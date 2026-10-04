import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchMe, onAuthChange, restoreSession, type Me } from './lib/api';
import { Nav, LangDropdown, ThemeToggle } from './components/Nav';
import Home, { useLiveClass } from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Classes from './pages/Classes';
import ClassDetail from './pages/ClassDetail';
import Calendar from './pages/Calendar';
import Lesson from './pages/Lesson';
import Profile from './pages/Profile';
import Notes from './pages/Notes';
import Sheets from './pages/Sheets';
import Spike from './pages/Spike';
import Privacy from './pages/Privacy';

const AuthCtx = createContext<{ me: Me | null; refresh: () => void }>({ me: null, refresh: () => {} });
export const useAuth = () => useContext(AuthCtx);

function tryRestoreSession(): Promise<void> {
  // no access token in memory → attempt cookie refresh once at boot.
  // Shared single-flight with api()'s 401 handler (StrictMode double-boot safe).
  return restoreSession().then(() => undefined).catch(() => {});
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booted, setBooted] = useState(false);
  const { i18n } = useTranslation();

  async function refresh() {
    const u = await fetchMe();
    setMe(u);
    // profile language is the source of truth once logged in; the switcher keeps
    // the profile in sync, so this never fights with the user's choice.
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
      {me ? (
        <Shell me={me}>
          <Routes>
            <Route path="/" element={<Home me={me} />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/notes" element={me.role === 'teacher' ? <Notes /> : <Navigate to="/" />} />
            <Route path="/classes" element={<Classes />} />
            <Route path="/classes/:id" element={<ClassDetail />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/lesson" element={<Lesson />} />
            <Route path="/sheets" element={me.role === 'student' ? <Sheets /> : <Navigate to="/" />} />
            <Route path="/spike" element={<Spike />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Shell>
      ) : (
        <div className="container">
          <AuthHeader />
          <Routes>
            <Route path="/login" element={<Login onDone={refresh} />} />
            <Route path="/register" element={<Register onDone={refresh} />} />
            <Route path="/spike" element={<Spike />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="*" element={<Navigate to="/login" />} />
          </Routes>
        </div>
      )}
    </AuthCtx.Provider>
  );
}

function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const live = useLiveClass();
  return (
    <div className="app-shell">
      <Nav me={me} live={live} />
      <div className="main">
        <div className="container">{children}</div>
      </div>
    </div>
  );
}

/** Compact header for unauthenticated pages (login/register/privacy). */
function AuthHeader() {
  const { t } = useTranslation();
  return (
    <div className="topbar">
      <a href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text)' }}>
        <span className="side-logo">K</span>
        <strong>{t('app.name')}</strong>
      </a>
      <span className="muted">{t('app.tagline')}</span>
      <div className="spacer" />
      <ThemeToggleCompact />
      <LangDropdown me={null} />
    </div>
  );
}

function ThemeToggleCompact() {
  return <div style={{ display: 'inline-flex' }}><ThemeToggle /></div>;
}
