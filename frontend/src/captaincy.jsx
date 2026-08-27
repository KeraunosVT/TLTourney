// Am I a captain, and of what?
//
// Separate from AuthProvider on purpose. The session says who you are and is
// answered from a cookie; captaincy says what you run and is answered from the
// database — it changes while you are signed in, and an organizer seating you
// mid-session should not need you to log out and back in for the board to
// appear.
//
// Fetched once per page load and refreshable, because the alternative is every
// component that wants to know asking the server again.
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api from './api';
import { useAuth } from './auth';

const CaptaincyContext = createContext({ teams: [], loading: true, refresh: () => {} });

export function CaptaincyProvider({ children }) {
  const { user } = useAuth();
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) { setTeams([]); setLoading(false); return; }
    try {
      const { data } = await api.get('/api/teams/mine');
      setTeams(data.captainOf || []);
    } catch {
      // Not being a captain is the common case, and a failure here should cost
      // a nav link, not the page.
      setTeams([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <CaptaincyContext.Provider value={{ teams, team: teams[0] || null, loading, refresh }}>
      {children}
    </CaptaincyContext.Provider>
  );
}

export const useCaptaincy = () => useContext(CaptaincyContext);
