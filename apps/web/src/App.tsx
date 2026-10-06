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
import AcceptPolicies from './pages/AcceptPolicies';
import Lesson from './pages/Lesson';
import Profile from './pages/Profile';
import Notes from './pages/Notes';
import Sheets from './pages/Sheets';
import ChatRoom, { ChatList } from './pages/Chat';import Spike from './pages/Spike';
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';
import ErrorScreen from './pages/ErrorScreen';
import TitleManager from './components/TitleManager';
import ErrorBoundary from './components/ErrorBoundary';

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
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const { i18n } = useTranslation();

  // Offline (Phase 3): surface a friendly translated screen when the browser
  // reports no connection, and recover automatically when it comes back.
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

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
    <ErrorBoundary>
      <TitleManager />
      <AuthCtx.Provider value={{ me, refresh }}>
        {!online ? (
          <div className="container">
            <AuthHeader />
            <ErrorScreen kind="offline" />
          </div>
        ) : me ? (
        me.policyAccepted === false ? (
          // Legal gate (Phase 2): replaces the authenticated UI until the current
          // privacy+terms bundle is accepted. The standalone legal pages stay
          // reachable from the gate via these nested routes.
          <div className="container">
            <AuthHeader />
            <Routes>
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="*" element={<AcceptPolicies onDone={refresh} />} />
            </Routes>
          </div>
        ) : me.profileCompleted === false ? (
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
            <Route path="/notes" element={me.role === 'teacher' ? <Notes /> : <ErrorScreen kind="403" />} />
            <Route path="/classes" element={<Classes />} />
            <Route path="/classes/:id" element={<ClassDetail />} />
            {/* material task A — the create form is a separate page, teacher only */}
            <Route path="/classes/:id/material/new" element={me.role === 'teacher' ? <MaterialNew /> : <ErrorScreen kind="403" />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/lesson" element={<Lesson />} />
            <Route path="/sheets" element={me.role === 'student' ? <Sheets /> : <ErrorScreen kind="403" />} />
            <Route path="/chat" element={<ChatList />} />
            <Route path="/chat/:id" element={<ChatRoom />} />
            <Route path="/spike" element={<Spike />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            {/* a signed-in user landing on the auth screens goes home (previously
                the catch-all redirect handled this); truly-unknown paths → 404 */}
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="/register" element={<Navigate to="/" replace />} />
            <Route path="*" element={<ErrorScreen kind="404" />} />
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
              <Route path="/terms" element={<Terms />} />
              <Route path="*" element={<Navigate to="/login" />} />
            </Routes>
          </div>
        )}
      </AuthCtx.Provider>
    </ErrorBoundary>
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
