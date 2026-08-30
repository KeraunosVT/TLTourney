import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { CaptaincyProvider, useCaptaincy } from './captaincy';
import { useLocation } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import { Sigil } from './components/Brand';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Queue from './pages/Queue';
import Setup from './pages/Setup';
import Teams from './pages/Teams';
import Board from './pages/Board';
import Draft from './pages/Draft';
import Bracket from './pages/Bracket';
import Match from './pages/Match';
import Leaderboard from './pages/Leaderboard';
import Predictions from './pages/Predictions';
import Player from './pages/Player';
import Watch from './pages/Watch';
import Pool from './pages/Pool';

function Shell() {
  const { user, logout } = useAuth();
  const { team: captainOf } = useCaptaincy();

  const link = ({ isActive }) =>
    `px-3 py-2 rounded text-[13.5px] border-l-2 flex items-center gap-2.5 transition-colors ${
      isActive
        ? 'bg-panelup text-bone border-crimson'
        : 'text-ash border-transparent hover:bg-panelup hover:text-bone'
    }`;

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <nav className="md:w-[224px] md:flex-none border-b md:border-b-0 md:border-r border-line bg-panel/55 p-4 flex md:flex-col gap-5 items-center md:items-stretch overflow-x-auto">
        {/* Sized against the rail's 224px minus its 16px padding either side:
            32 + 10 gap leaves 166px for the type, which "THRONE & LIBERTY" at
            13px Marcellus fills almost exactly. Shrink the rail and this wraps. */}
        <div className="px-1 flex items-center gap-2.5">
          <Sigil size={32} />
          <div className="leading-none">
            <div className="wordmark text-[13px] tracking-[0.04em] whitespace-nowrap">
              THRONE <span className="text-crimson">&amp;</span> LIBERTY
            </div>
            <div className="text-[8px] uppercase tracking-[0.26em] text-ash mt-[5px] whitespace-nowrap">
              Tournament Series
            </div>
          </div>
        </div>
        <div className="flex md:flex-col gap-1 flex-1 md:flex-none">
          <NavLink to="/signup" className={link}>Sign up</NavLink>
          {/* Shown to everyone, unlike the board. The draft is the event — a
              player who isn't a captain still wants to watch their name come
              off the list, and the page refuses the pick button rather than the
              page. */}
          <NavLink to="/draft" className={link}>Draft</NavLink>
          <NavLink to="/bracket" className={link}>Bracket</NavLink>
          {/* Everyone, deliberately — the prediction game is for the people
              watching as much as the people playing. */}
          <NavLink to="/predictions" className={link}>Predictions</NavLink>
          <NavLink to="/leaderboard" className={link}>Leaderboard</NavLink>
          {/* Only a captain has one, so only a captain is offered one. The
              server refuses it either way — this just keeps a dead link off
              everyone else's rail. */}
          {captainOf && <NavLink to="/board" className={link}>Draft board</NavLink>}
          {user?.isOrganizer && <NavLink to="/queue" className={link}>Approval queue</NavLink>}
          {user?.isOrganizer && <NavLink to="/teams" className={link}>Teams</NavLink>}
          {user?.isOrganizer && <NavLink to="/setup" className={link}>Setup</NavLink>}
        </div>
        <div className="md:mt-auto px-2 flex md:flex-col items-center md:items-start gap-2 text-xs text-ash">
          <span className="whitespace-nowrap">
            {user?.username}
            {user?.isOrganizer && <span className="text-crimson"> · organizer</span>}
          </span>
          {captainOf && (
            <span className="whitespace-nowrap text-[11px]">
              {captainOf.label} of <span className="text-bone">{captainOf.name}</span>
            </span>
          )}
          <button onClick={logout} className="hover:text-bone underline underline-offset-2">
            Sign out
          </button>
        </div>
      </nav>
      <main className="flex-1 min-w-0">
        {/* Keyed on the path so navigating away from a crashed page clears the
            boundary — without the key it latches and every route stays broken. */}
        <ErrorBoundary key={useLocation().pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="eyebrow">Checking your session…</div>
      </div>
    );
  }
  if (!user) return <Login />;
  return <Shell />;
}

// Organizer-only routes. The server enforces this too — this only decides what
// the browser bothers to render.
function OrganizerOnly({ children }) {
  const { user } = useAuth();
  if (!user?.isOrganizer) return <Navigate to="/signup" replace />;
  return children;
}

// Captain-only, and unlike the organizer check this one has to WAIT. Captaincy
// arrives a moment after the session does, and redirecting on a not-yet-loaded
// answer would bounce a captain off their own board every time they refreshed
// it. Organizer status has no such gap — it rides in the session itself.
function CaptainOnly({ children }) {
  const { team, loading } = useCaptaincy();
  if (loading) return <div className="p-8 text-sm text-ash">Checking your team…</div>;
  if (!team) return <Navigate to="/signup" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <CaptaincyProvider>
        <BrowserRouter>
          <Routes>
            {/* OUTSIDE the gate, deliberately and uniquely. This is the scene a
                broadcast points at: an OBS browser source has no session, and
                sending it to a login page would put a login page on the stream.
                It reads the one unauthenticated API route, which returns only
                what is being broadcast anyway. */}
            <Route path="/watch" element={<Watch />} />

            {/* The pop-out, and the URL read off the broadcast. Public for the
                same reason /watch is: a viewer typing it in has no session, and
                a producer pointing a second OBS source at it has no cookie. */}
            <Route path="/pool" element={<Pool />} />

            <Route element={<Gate />}>
              <Route index element={<Navigate to="/signup" replace />} />
              <Route path="/signup" element={<Signup />} />
              <Route path="/draft" element={<Draft />} />
              <Route path="/bracket" element={<Bracket />} />
              <Route path="/match/:key" element={<Match />} />
              <Route path="/predictions" element={<Predictions />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/player/:signupId" element={<Player />} />
              <Route path="/board" element={<CaptainOnly><Board /></CaptainOnly>} />
              <Route path="/queue" element={<OrganizerOnly><Queue /></OrganizerOnly>} />
              <Route path="/teams" element={<OrganizerOnly><Teams /></OrganizerOnly>} />
              <Route path="/setup" element={<OrganizerOnly><Setup /></OrganizerOnly>} />
              <Route path="*" element={<Navigate to="/signup" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </CaptaincyProvider>
    </AuthProvider>
  );
}
