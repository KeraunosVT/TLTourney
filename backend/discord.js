// backend/discord.js — Discord REST helpers for the TOURNAMENT server.
//
// ⚠️  This app is bound to the tournament's OWN Discord server and its own
// Discord application. None of these values are shared with, or copied from,
// the guild app (Gear-Gap) — a different server, a different bot, a different
// client secret. If you find yourself pasting an ID from that project's .env
// into this one, stop: the role IDs would be meaningless here and the OAuth
// redirect would send people to the wrong site.
//
// No gateway connection — REST only. The bot token is optional: without it the
// app still works, it just can't re-check a session against Discord, so a
// member who leaves the server keeps access until their cookie expires.
const axios = require('axios');

const API = 'https://discord.com/api/v10';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

const botConfigured = Boolean(BOT_TOKEN && GUILD_ID);

const authHeaders = () => ({ Authorization: `Bot ${BOT_TOKEN}` });

// Fetch one member of the tournament server by user id, for session
// re-verification. Returns { status, member } — 404 means they've left.
async function fetchMember(userId) {
  if (!botConfigured) throw new Error('Discord bot is not configured.');
  const res = await axios.get(`${API}/guilds/${GUILD_ID}/members/${userId}`, {
    headers: authHeaders(),
    validateStatus: (s) => s < 500,
  });
  return { status: res.status, member: res.status === 200 ? res.data : null };
}

// Every role in the tournament server, newest-highest first. Used by the setup
// check so you can read the role IDs off the running app instead of hunting
// through Discord's UI. @everyone is dropped: every member holds it, so naming
// it as the organizer role would make the whole server an organizer.
let rolesCache = null;
let rolesCacheAt = 0;
const CACHE_TTL_MS = 60 * 1000;

async function listRoles() {
  if (!botConfigured) return [];
  if (rolesCache && Date.now() - rolesCacheAt < CACHE_TTL_MS) return rolesCache;
  try {
    const { data } = await axios.get(`${API}/guilds/${GUILD_ID}/roles`, { headers: authHeaders() });
    const roles = (data || [])
      .filter((r) => r.id !== GUILD_ID && !r.managed)
      .map((r) => ({ id: r.id, name: r.name, position: r.position }))
      .sort((a, b) => b.position - a.position);
    rolesCache = roles;
    rolesCacheAt = Date.now();
    return roles;
  } catch (err) {
    if (rolesCache) {
      console.warn('listRoles refresh failed — serving stale cache:', err.message);
      return rolesCache;
    }
    throw err;
  }
}

// Give a member a role.
//
// Idempotent by nature: Discord answers 204 whether or not they already had it,
// so there is no need to read the member first and no harm in it running on
// every login.
//
// NEVER throws. Handing out a role is a side effect of signing in; a login that
// failed because a role couldn't be granted would lock people out of the site
// over something cosmetic. The caller gets a result object and ignores it.
async function addRole(userId, roleId) {
  if (!botConfigured) return { ok: false, reason: 'no bot token' };
  if (!roleId) return { ok: false, reason: 'no role configured' };
  try {
    await axios.put(
      `${API}/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`,
      null,
      { headers: authHeaders() }
    );
    return { ok: true };
  } catch (err) {
    const status = err.response?.status;
    const code = err.response?.data?.code;
    // 50013 "Missing Permissions" on a role grant is usually NOT a missing
    // permission — it's hierarchy: the bot's own highest role sits below the
    // role it's trying to hand out. Discord reports both cases identically, so
    // name both rather than sending someone to check only the one that's fine.
    const reason = status === 403 || code === 50013
      ? `Missing Permissions. Two things to check: the bot needs "Manage Roles", AND its own role must sit ABOVE role ${roleId} in Server Settings → Roles.`
      : status === 404
        ? `Role ${roleId} does not exist in this server, or the member has left.`
        : (err.response?.data?.message || err.message);
    console.warn(`Role grant failed (user ${userId} → role ${roleId}): ${reason}`);
    return { ok: false, reason };
  }
}

// DM a member. Used to tell someone their signup was approved or rejected —
// a decision that reaches nobody may as well not have been made.
//
// Failure is reported to the caller but never fails the decision itself: a
// closed DM inbox must not roll back an approval that already happened.
async function sendDM(userId, content) {
  if (!botConfigured) return { ok: false, reason: 'no bot token' };
  try {
    const { data: channel } = await axios.post(
      `${API}/users/@me/channels`,
      { recipient_id: userId },
      { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
    );
    await axios.post(
      `${API}/channels/${channel.id}/messages`,
      { content },
      { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
    );
    return { ok: true };
  } catch (err) {
    // 50007 = "Cannot send messages to this user" — DMs closed. Common and not
    // an error on our side.
    const code = err.response?.data?.code;
    console.warn(`DM to ${userId} failed (${code || err.message})`);
    return { ok: false, reason: code === 50007 ? 'DMs closed' : (err.message || 'failed') };
  }
}

module.exports = { fetchMember, listRoles, addRole, sendDM, botConfigured, GUILD_ID };
