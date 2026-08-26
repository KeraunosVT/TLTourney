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
const signupsRouter = require('./signups');
const organizerRouter = require('./organizer');
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
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  auth: authConfigured,
  db: !!supabase,
}));

app.get('/api/tournament', async (req, res) => {
  const t = await currentTournament();
  if (!t) return res.json({ tournament: null });
  res.json({
    tournament: {
      name: t.name,
      status: t.status,
      roster_size: t.roster_size,
      signups_close_at: t.signups_close_at,
      open: t.status === 'signups',
    },
  });
});

app.use('/api/auth', authRouter);

// ── Everything below needs a session ────────────────────────────────────────
app.use('/api', requireAuth);

// Writing a signup is cheap but not free, and the form autosaves. Cap it per
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

app.use('/api/signup', (req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)), signupsRouter);
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
