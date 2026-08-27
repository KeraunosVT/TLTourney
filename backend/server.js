// backend/server.js — the API, and the built frontend beside it.
//
// One process serves both: /api/* is this app, everything else falls through to
// frontend/dist. That means one thing to deploy and no CORS in production.
const path = require('path');

// .env lives next to this file, not at the repo root.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const { router: authRouter, requireAuth, requireOrganizer, authConfigured } = require('./auth');
const signups = require('./signups');
const organizerRouter = require('./organizer');
const teams = require('./teams');
const board = require('./board');
const draft = require('./draft');
const bracket = require('./bracket');
const { currentTournament, supabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a proxy (Render, Fly, nginx) the client IP arrives in X-Forwarded-For,
// and secure cookies need to know the original request was HTTPS.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// Local dev only — in production the frontend is served from this same origin,
// so there is no cross-origin request to allow.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : false, credentials: true }));
app.use(express.json({ limit: '64kb' }));  // no uploads here; a signup is small
app.use(cookieParser());

// ── Health & public info ────────────────────────────────────────────────────
// No auth: this is what a load balancer hits, and what tells the login page
// which tournament it is inviting people to.
// `db` used to report whether credentials were PRESENT, which is not the same
// question as whether the database works — a correctly configured connection to
// a project with no tables reported db:true while every page failed. It now
// probes for real, so this one URL distinguishes "not configured" from
// "configured but the migration hasn't been run".
app.get('/api/health', async (req, res) => {
  const out = { status: 'ok', auth: authConfigured, db: !!supabase };

  if (supabase) {
    const { error } = await supabase.from('tournaments').select('id').limit(1);
    out.schema = !error;
    if (error) {
      out.status = 'degraded';
      out.hint = /schema cache|does not exist|relation/i.test(error.message)
        ? 'Tables are missing — run migrations/001_signups.sql in the Supabase SQL editor, then migrations/verify.sql.'
        : error.message;
    }
  }

  res.json(out);
});

app.get('/api/tournament', async (req, res) => {
  const t = await currentTournament();
  if (!t) return res.json({ tournament: null });
  res.json({
    tournament: {
      name: t.name,
      status: t.status,
      roster_size: t.roster_size,
      party_count: t.party_count,
      party_size: t.party_size,
      sub_count: t.sub_count,
      signups_close_at: t.signups_close_at,
      open: t.status === 'signups',
    },
  });
});

app.use('/api/auth', authRouter);

// ── The stream view ─────────────────────────────────────────────────────────
// Deliberately ABOVE requireAuth, and the only data route that is.
//
// This is what a broadcast points at: an OBS browser source carries no session
// cookie, and neither does anybody who follows the link from the stream. Read
// only, and it returns nothing that isn't already being shown on the broadcast
// — teams, rosters, picks, the clock. Boards, the pool list and Discord ids are
// all on the authenticated route instead.
//
// Rate-limited by IP rather than by user, because there is no user. Generous:
// the page polls every two seconds and a watch party is many browsers behind
// one address.
const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Too many requests — slow down.' },
});
app.use('/api/stream/draft', streamLimiter, draft.publicRouter);

// ── Everything below needs a session ────────────────────────────────────────
app.use('/api', requireAuth);

// Writing a signup is cheap but not free. Cap it per
// user rather than per IP: a guild sharing one office connection is a normal
// thing, and keying on IP would have them throttling each other.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator takes the IP, not the request — it normalises IPv6 into a
  // /56 subnet so one client can't rotate through addresses to reset its count.
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { error: "You're saving very fast — give it a moment." },
});

app.use('/api/signup', (req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)), signups.router);
app.use('/api/teams', teams.publicRouter);

// The board gets its own, much larger allowance rather than sharing the signup
// limiter. A signup is one form saved a handful of times; a board is a captain
// working through 300 players, one small write per placement, and 30/minute
// would throttle somebody doing exactly what the page is for. Still capped —
// this is a write path — just capped at a rate a human sorting cards cannot
// reach.
const boardLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { error: "You're saving very fast — give it a moment." },
});

app.use('/api/board', (req, res, next) => (req.method === 'GET' ? next() : boardLimiter(req, res, next)), board.router);

// The draft page polls every couple of seconds while it is open, so its GET is
// exempt for the same reason the board's is. The pick itself is a write, but a
// write nobody makes twice a minute — it shares the board's allowance.
app.use('/api/draft', (req, res, next) => (req.method === 'GET' ? next() : boardLimiter(req, res, next)), draft.router);

app.use('/api/bracket', bracket.router);

app.use('/api/organizer/teams', requireOrganizer, teams.organizerRouter);
app.use('/api/organizer/bracket', requireOrganizer, bracket.organizerRouter);
app.use('/api/organizer/draft', requireOrganizer, draft.organizerRouter);
app.use('/api/organizer', requireOrganizer, organizerRouter);

// ── Static frontend ─────────────────────────────────────────────────────────
const frontendPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendPath));

// Any non-API path is a client route — hand it index.html and let React Router
// sort it out. An unmatched /api path must 404 as JSON rather than as an HTML
// page, or a typo'd endpoint comes back looking like a working page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));

// ── Errors ──────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`TLTourney API on :${PORT}`);
  if (!authConfigured) console.log('   → login is not configured; see backend/.env.example');
  if (!supabase) console.log('   → database is not configured; see backend/.env.example');
});
