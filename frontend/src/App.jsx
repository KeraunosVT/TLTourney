import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Queue from './pages/Queue';

function Shell() {
  const { user, logout } = useAuth();

  const link = ({ isActive }) =>
    `px-3 py-2 rounded text-[13.5px] border-l-2 flex items-center gap-2.5 transition-colors ${
      isActive
        ? 'bg-panelup text-bone border-brass'
        : 'text-ash border-transparent hover:bg-panelup hover:text-bone'
    }`;

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <nav className="md:w-[208px] md:flex-none border-b md:border-b-0 md:border-r border-line bg-panel/55 p-4 flex md:flex-col gap-5 items-center md:items-stretch overflow-x-auto">
        <div className="px-2">
          <div className="font-display text-[21px] leading-none whitespace-nowrap">
            TL<span className="text-brass">Tourney</span>
          </div>
        </div>
        <div className="flex md:flex-col gap-1 flex-1 md:flex-none">
          <NavLink to="/signup" className={link}>Sign up</NavLink>
          {user?.isOrganizer && <NavLink to="/queue" className={link}>Approval queue</NavLink>}
        </div>
        <div className="md:mt-auto px-2 flex md:flex-col items-center md:items-start gap-2 text-xs text-ash">
          <span className="whitespace-nowrap">
            {user?.username}
            {user?.isOrganizer && <span className="text-brass"> · organizer</span>}
          </span>
          <button onClick={logout} className="hover:text-bone underline underline-offset-2">
            Sign out
          </button>
        </div>
      </nav>
      <main className="flex-1 min-w-0">
        <Outlet />
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

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Gate />}>
            <Route index element={<Navigate to="/signup" replace />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/queue" element={<OrganizerOnly><Queue /></OrganizerOnly>} />
            <Route path="*" element={<Navigate to="/signup" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
