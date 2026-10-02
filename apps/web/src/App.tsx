import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchMe, onAuthChange, setAccessToken, type Me } from './lib/api';
import Login from './pages/Login';
import Register from './pages/Register';
import Classes from './pages/Classes';
import ClassDetail from './pages/ClassDetail';
import Spike from './pages/Spike';
import Profile from './pages/Profile';
import Notes from './pages/Notes';
import Calendar from './pages/Calendar';
import Lesson from './pages/Lesson';
import Sheets from './pages/Sheets';

const AuthCtx = createContext<{ me: Me | null; refresh: () => void }>({ me: null, refresh: () => {} });
export const useAuth = () => useContext(AuthCtx);

function tryRestoreSession(): Promise<void> {
  // no access token in memory → attempt cookie refresh once at boot
  return fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) return;
      const j = await r.json();
      setAccessToken(j.accessToken);
    })
    .catch(() => {});
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booted, setBooted] = useState(false);
  const { i18n } = useTranslation();

  async function refresh() {
    const u = await fetchMe();
    setMe(u);
    if (u && u.locale !== i18n.language) void i18n.changeLanguage(u.locale);
  }

  useEffect(() => {
    (async () => {
      await tryRestoreSession();
      await refresh();
      setBooted(true);
    })();
    return onAuthChange(() => { void refresh(); });
  }, []);

  if (!booted) return <div className="container muted">…</div>;

  return (
    <AuthCtx.Provider value={{ me, refresh }}>
      <div className="container">
        <Topbar me={me} onLoggedOut={() => setMe(null)} />
        <Routes>
          <Route path="/login" element={me ? <Navigate to="/classes" /> : <Login onDone={refresh} />} />
          <Route path="/register" element={me ? <Navigate to="/classes" /> : <Register onDone={refresh} />} />
          <Route path="/spike" element={<Spike />} />
          <Route path="/profile" element={me ? <Profile /> : <Navigate to="/login" />} />
          <Route path="/notes" element={me?.role === 'teacher' ? <Notes /> : <Navigate to="/classes" />} />
          <Route path="/classes" element={me ? <Classes /> : <Navigate to="/login" />} />
          <Route path="/classes/:id" element={me ? <ClassDetail /> : <Navigate to="/login" />} />
          <Route path="/calendar" element={me ? <Calendar /> : <Navigate to="/login" />} />
          <Route path="/lesson" element={me ? <Lesson /> : <Navigate to="/login" />} />
          <Route path="/sheets" element={me?.role === 'student' ? <Sheets /> : <Navigate to="/classes" />} />
          <Route path="*" element={<Navigate to={me ? '/classes' : '/login'} />} />
        </Routes>
      </div>
    </AuthCtx.Provider>
  );
}

function Topbar({ me, onLoggedOut }: { me: Me | null; onLoggedOut: () => void }) {
  const { t, i18n } = useTranslation();
  const next = i18n.language === 'ru' ? 'uz' : 'ru';
  return (
    <div className="topbar">
      <strong>{t('app.name')}</strong>
      <span className="muted">{t('app.tagline')}</span>
      <div className="spacer" />
      <button className="secondary" style={{ marginTop: 0 }} onClick={() => void i18n.changeLanguage(next)}>
        {next.toUpperCase()}
      </button>
      {me ? (
        <>
          <a href="/classes">{t('classes.title')}</a>
          <a href="/calendar">{t('cal.title')}</a>
          {me.role === 'student' && <a href="/sheets">{t('sheets.title')}</a>}
          {me.role === 'teacher' && <a href="/notes">{t('notes.title')}</a>}
          <a href="/profile">{me.name}</a>
          <LogoutBtn onLoggedOut={onLoggedOut} />
        </>
      ) : (
        <a href="/login">{t('common.login')}</a>
      )}
    </div>
  );
}

function LogoutBtn({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      className="secondary"
      style={{ marginTop: 0 }}
      onClick={async () => {
        const { logout } = await import('./lib/api');
        await logout();
        onLoggedOut();
      }}
    >
      {t('common.logout')}
    </button>
  );
}
