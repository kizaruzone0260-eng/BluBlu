import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, fetchMe, onAuthChange, restoreSession, type Me } from './lib/api';
import { APP_NAME } from './lib/brand';
import { Nav, LangDropdown, ThemeToggle } from './components/Nav';
import Home, { useLiveClass } from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Classes from './pages/Classes';
import ClassDetail from './pages/ClassDetail';
import MaterialNew from './pages/MaterialNew';
import Calendar from './pages/Calendar';
import CompleteName from './pages/CompleteName';
import Lesson from './pages/Lesson';
import Profile from './pages/Profile';
import Notes from './pages/Notes';
import Sheets from './pages/Sheets';
import ChatRoom, { ChatList } from './pages/Chat';import Spike from './pages/Spike';
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

  // item 4 — the timezone is captured from the device (no profile field for it):
  // on login/restore, on profile load and on window focus (user moved cities).
  useEffect(() => {
    if (!me) return;
    const syncTz = () => {
      const dev = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!dev || dev === me.tz) return;
      void api('/api/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: me.name, locale: me.locale, tz: dev }),
      }).then(() => refresh()).catch(() => undefined);
    };
    syncTz();
    window.addEventListener('focus', syncTz);
    return () => window.removeEventListener('focus', syncTz);
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
        me.profileCompleted === false ? (
          // name screen (task 2): replaces the whole app until saved — no route
          // to navigate around, so no redirect loop; logout stays reachable.
          <div className="container">
            <AuthHeader />
            <CompleteName me={me} onDone={refresh} />
          </div>
        ) : (
        <Shell me={me}>
          <Routes>
            <Route path="/" element={<Home me={me} />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/notes" element={me.role === 'teacher' ? <Notes /> : <Navigate to="/" />} />
            <Route path="/classes" element={<Classes />} />
            <Route path="/classes/:id" element={<ClassDetail />} />
            {/* material task A — the create form is a separate page, teacher only */}
            <Route path="/classes/:id/material/new" element={me.role === 'teacher' ? <MaterialNew /> : <Navigate to="/" />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/lesson" element={<Lesson />} />
            <Route path="/sheets" element={me.role === 'student' ? <Sheets /> : <Navigate to="/" />} />
            <Route path="/chat" element={<ChatList />} />
            <Route path="/chat/:id" element={<ChatRoom />} />
            <Route path="/spike" element={<Spike />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Shell>
        )
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
        <span className="side-logo">B</span>
        <strong>{APP_NAME}</strong>
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
