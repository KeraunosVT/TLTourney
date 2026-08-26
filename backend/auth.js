// backend/auth.js — Discord OAuth2 login, gated to the TOURNAMENT server.
//
// Adapted from Gear-Gap's auth.js. The shape is the same and the reasoning
// behind it is worth keeping; what changed is that capabilities collapsed to a
// single `isOrganizer` flag. Gear-Gap needs fifteen named capabilities because
// fifteen different officers do fifteen different jobs. A tournament has
// organizers and it has everyone else, and inventing a permissions grid before
// there is a second kind of officer is work that pays nobody.
//
// ⚠️  The Discord application, server, and roles here belong to the TOURNAMENT.
// Nothing is shared with the guild app — see backend/discord.js.
//
// No bot required for login itself: membership and roles are read through the
// user's own `guilds.members.read` scope at GET /users/@me/guilds/{guild}/member.
// The bot token only powers re-verification and DMs.
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { fetchMember, addRole, botConfigured } = require('./discord');

const router = express.Router();

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_GUILD_ID,
  JWT_SECRET,
  APP_URL = '/',
} = process.env;

// Who may sign in at all. EMPTY means any member of the tournament server
// passes, which is a real configuration and the sensible default for an open
// tournament — you want people to be able to sign up.
const ALLOWED_ROLE_IDS = (process.env.DISCORD_ALLOWED_ROLE_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Who runs the tournament. EMPTY means nobody, which fails closed — the
// approval queue is unreachable until you set this.
const ADMIN_ROLE_IDS = (process.env.DISCORD_ADMIN_ROLE_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Handed out automatically the first time someone signs in on the site, and
// re-applied on every login after that (the grant is idempotent, so a role
// removed by hand comes back next time they visit).
//
// This one is WRITTEN to Discord rather than read from it, which makes it the
// only setting here that needs the bot to hold "Manage Roles" — and the bot's
// own role to sit above this one in the server's role list. EMPTY = feature off.
const VERIFIED_ROLE_ID = (process.env.DISCORD_VERIFIED_ROLE_ID || '').trim();

const COOKIE_NAME = 'tlt_session';
const STATE_COOKIE = 'tlt_oauth_state';
const SESSION_DAYS = 7;

// How stale a session may get before it's re-checked against Discord. Someone
// who leaves the server loses access within this window instead of riding out
// the full 7-day token. Needs the bot token; without one the old behaviour (no
// re-checks) holds, with a warning at boot.
const REVERIFY_MS = (parseInt(process.env.SESSION_REVERIFY_MINUTES, 10) || 60) * 60 * 1000;

// Auth is "configured" only when every required secret is present. If not, the
// app fails closed — data routes return 401 and nothing leaks.
const authConfigured = Boolean(
  DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT_URI && DISCORD_GUILD_ID && JWT_SECRET
);
if (!authConfigured) {
  console.warn('⚠️  Discord login is not fully configured — all data routes are locked. See backend/.env.example.');
}
if (authConfigured && ADMIN_ROLE_IDS.length === 0) {
  console.warn('⚠️  DISCORD_ADMIN_ROLE_IDS is empty — nobody can reach the approval queue. Set it to the organizer role in the TOURNAMENT server.');
}
if (authConfigured && !botConfigured) {
  console.warn('⚠️  No bot token — sessions cannot be re-verified and decisions cannot be DMed.');
}
if (VERIFIED_ROLE_ID && !botConfigured) {
  console.warn('⚠️  DISCORD_VERIFIED_ROLE_ID is set but there is no bot token — nobody will be given the role.');
}

// ── The deadlock ────────────────────────────────────────────────────────────
// These two variables do OPPOSITE things and are one word apart in name:
//
//   DISCORD_ALLOWED_ROLE_IDS  — the gate.  Checked BEFORE a login succeeds.
//   DISCORD_VERIFIED_ROLE_ID  — the grant. Applied AFTER a login succeeds.
//
// Put the same role in both and nobody can ever sign in: the grant only runs
// once the gate has passed, and the gate wants the role the grant would have
// given. It locks out the entire server, including whoever configured it, and
// the symptom is an ordinary "your roles don't let you sign in" that points
// nowhere near the cause.
//
// Not auto-corrected — silently ignoring configuration is its own bug — but it
// is shouted about at boot and reported by /api/auth/config.
const ROLE_DEADLOCK = Boolean(VERIFIED_ROLE_ID && ALLOWED_ROLE_IDS.includes(VERIFIED_ROLE_ID));
if (ROLE_DEADLOCK) {
  console.error(
    '\n🛑 CONFIGURATION DEADLOCK — NOBODY CAN SIGN IN.\n'
    + `   DISCORD_VERIFIED_ROLE_ID (${VERIFIED_ROLE_ID}) is also in DISCORD_ALLOWED_ROLE_IDS.\n`
    + '   The role is only granted AFTER a successful login, so it can never be the role\n'
    + '   that PERMITS the login. Everyone is refused with auth=forbidden, forever.\n'
    + '   Fix: leave DISCORD_ALLOWED_ROLE_IDS empty so any member of the server may sign in.\n'
  );
}
if (VERIFIED_ROLE_ID) {
  console.log(`   → signing in grants role ${VERIFIED_ROLE_ID} (bot needs "Manage Roles", ranked above it)`);
}

const isProd = process.env.NODE_ENV === 'production';
const baseCookie = { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/' };

// ── Begin login: redirect to Discord with a CSRF state ──────────────────────
router.get('/login', (req, res) => {
  if (!authConfigured) return res.status(503).send('Discord login is not configured.');

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, { ...baseCookie, maxAge: 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
    prompt: 'consent',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

// ── OAuth callback ──────────────────────────────────────────────────────────
// Full path: /api/auth/discord/callback — must match DISCORD_REDIRECT_URI and
// the redirect registered in the Discord developer portal for the TOURNAMENT
// application.
router.get('/discord/callback', async (req, res) => {
  if (!authConfigured) return res.status(503).send('Discord login is not configured.');

  const { code, state } = req.query;
  const savedState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, baseCookie);

  if (!code || !state || state !== savedState) {
    return res.redirect(`${APP_URL}?auth=error`);
  }

  try {
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: DISCORD_REDIRECT_URI,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;

    const memberRes = await axios.get(
      `https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${accessToken}` }, validateStatus: (s) => s < 500 }
    );

    if (memberRes.status === 404) {
      // They completed the Discord login but aren't in THIS server. The most
      // common cause by far is the wrong DISCORD_GUILD_ID — a login that works
      // for the organizer who set it up and nobody else usually means the ID
      // points at a server only they are in.
      console.warn(`Login refused: user is not a member of guild ${DISCORD_GUILD_ID} (auth=not_member)`);
      return res.redirect(`${APP_URL}?auth=not_member`);
    }
    if (memberRes.status !== 200) throw new Error(`member fetch failed: ${memberRes.status}`);

    const sessionUser = evaluateMember(memberRes.data);
    if (!sessionUser) {
      // Refusals used to be silent, which made "someone couldn't sign in"
      // unanswerable without reproducing it. The role IDs are not secret and
      // this is the one place the mismatch is visible.
      const held = memberRes.data?.roles || [];
      console.warn(
        `Login refused: DISCORD_ALLOWED_ROLE_IDS is set to [${ALLOWED_ROLE_IDS.join(', ')}] `
        + `and this member holds [${held.join(', ')}] — no overlap (auth=forbidden). `
        + (ROLE_DEADLOCK
          ? 'THIS IS THE DEADLOCK: the allow-list contains the role that is only granted after '
            + 'a successful login, so nobody will ever pass. Empty DISCORD_ALLOWED_ROLE_IDS.'
          : 'Leave DISCORD_ALLOWED_ROLE_IDS empty to let any member of the server sign in.')
      );
      return res.redirect(`${APP_URL}?auth=forbidden`);
    }

    // Mark them verified in Discord. Deliberately AFTER the access check —
    // someone whose roles don't admit them to the site shouldn't be tagged as
    // verified by it — and deliberately non-fatal: addRole never throws, and
    // its result is ignored, because a Discord hiccup here must not be the
    // reason somebody can't sign in.
    if (VERIFIED_ROLE_ID) await addRole(sessionUser.id, VERIFIED_ROLE_ID);

    issueSession(res, sessionUser);
    res.redirect(APP_URL);
  } catch (err) {
    // Nearly always one of three things, and the raw message rarely says which.
    const hint = /invalid_grant|invalid_client|redirect_uri/i.test(err.message || '')
      ? ' — check DISCORD_REDIRECT_URI matches the redirect registered on the Discord application, exactly'
      : '';
    console.error(`Auth callback error (auth=error): ${err.message}${hint}`);
    res.redirect(`${APP_URL}?auth=error`);
  }
});

// ── Why can't someone sign in? ──────────────────────────────────────────────
// Public and deliberately free of secrets: booleans, counts and the guild id,
// which is not sensitive. It exists because the answer to "someone got refused"
// is usually a configuration fact the organizer can check in five seconds, and
// without this the only way to find it is to reproduce the failure.
router.get('/config', (req, res) => {
  res.json({
    configured: authConfigured,
    guild_id: DISCORD_GUILD_ID || null,
    redirect_uri: DISCORD_REDIRECT_URI || null,
    // The usual culprit. TRUE means only holders of those roles may sign in —
    // everyone else is refused with auth=forbidden.
    allow_list_active: ALLOWED_ROLE_IDS.length > 0,
    allow_list_size: ALLOWED_ROLE_IDS.length,
    organizer_roles_set: ADMIN_ROLE_IDS.length > 0,
    bot_configured: botConfigured,
    verified_role_set: !!VERIFIED_ROLE_ID,
    // If this is true, nothing else on this page matters — see the boot log.
    role_deadlock: ROLE_DEADLOCK,
    ...(ROLE_DEADLOCK && {
      role_deadlock_fix: 'DISCORD_VERIFIED_ROLE_ID is also in DISCORD_ALLOWED_ROLE_IDS. '
        + 'The role is granted only after a successful login, so it can never be the role that '
        + 'permits one. Empty DISCORD_ALLOWED_ROLE_IDS.',
    }),
  });
});

// ── Who am I? ───────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!authConfigured || !token) return res.status(401).json({ authenticated: false });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        isOrganizer: !!user.isOrganizer,
      },
    });
  } catch {
    res.status(401).json({ authenticated: false });
  }
});

// ── Logout ──────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, baseCookie);
  res.json({ ok: true });
});

// ── Session helpers ─────────────────────────────────────────────────────────
// Turn a Discord guild-member object into a session payload, or null if their
// roles don't grant access. Synchronous, unlike Gear-Gap's: the role lists are
// environment variables here rather than a database row, so there is nothing
// to await and nothing that can be stale.
function evaluateMember(member) {
  const roles = member?.roles || [];
  const allowed = ALLOWED_ROLE_IDS.length === 0 || roles.some((r) => ALLOWED_ROLE_IDS.includes(r));
  if (!allowed) return null;

  const u = member.user || {};
  return {
    id: u.id,
    username: u.global_name || u.username || 'Player',
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
    isOrganizer: ADMIN_ROLE_IDS.length > 0 && roles.some((r) => ADMIN_ROLE_IDS.includes(r)),
    verified_at: Date.now(),
  };
}

function issueSession(res, sessionUser) {
  const token = jwt.sign(sessionUser, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE_NAME, token, { ...baseCookie, maxAge: SESSION_DAYS * 86400 * 1000 });
}

// ── Gate for protected routes ───────────────────────────────────────────────
// Sessions older than REVERIFY_MS are re-checked against Discord. Discord being
// unreachable is NOT treated as revocation (fail open, retry next request) —
// only a definitive 404 (left the server) or a failed role check revokes.
const reverifyInFlight = new Map(); // user id -> Promise, dedupes request bursts

async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!authConfigured || !token) return res.status(401).json({ error: 'Authentication required' });

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }

  const stale = botConfigured && Date.now() - (user.verified_at || 0) > REVERIFY_MS;
  if (stale) {
    try {
      let pending = reverifyInFlight.get(user.id);
      if (!pending) {
        pending = fetchMember(user.id).finally(() => reverifyInFlight.delete(user.id));
        reverifyInFlight.set(user.id, pending);
      }
      const { status, member } = await pending;

      if (status === 404) {
        res.clearCookie(COOKIE_NAME, baseCookie);
        return res.status(401).json({ error: 'You are no longer in the tournament Discord.' });
      }
      if (status === 200) {
        const refreshed = evaluateMember(member);
        if (!refreshed) {
          res.clearCookie(COOKIE_NAME, baseCookie);
          return res.status(401).json({ error: 'Your roles no longer grant access.' });
        }
        issueSession(res, refreshed); // fresh verified_at, current roles and name
        user = refreshed;
      } else {
        // 401/403/429 point at our bot config or rate limits, not this user.
        console.warn(`Session re-verify for ${user.id} got HTTP ${status} — keeping existing session.`);
      }
    } catch (err) {
      console.warn('Session re-verify failed — keeping existing session:', err.message);
    }
  }

  req.user = user;
  next();
}

// Gate for the organizer area.
function requireOrganizer(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.isOrganizer) return next();
    return res.status(403).json({ error: 'Organizer access required' });
  });
}

module.exports = { router, requireAuth, requireOrganizer, authConfigured };
