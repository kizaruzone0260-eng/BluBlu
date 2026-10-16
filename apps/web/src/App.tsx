import { createContext, useContext, useEffect, useState, Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, fetchMe, onAuthChange, restoreSession, type Me } from './lib/api';
import { resolveLocale, shouldCarryStoredChoice } from '@klass/shared';
import { applyLocale, storedLocale } from './i18n';
import { APP_NAME } from './lib/brand';
import { Nav, LangDropdown, ThemeToggle } from './components/Nav';
import Home, { useLiveClass } from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import CompleteName from './pages/CompleteName';
import AcceptPolicies from './pages/AcceptPolicies';
import ChangePasswordGate from './pages/ChangePassword';
import Classes from './pages/Classes';
import Profile from './pages/Profile';
import ChatRoom, { ChatList } from './pages/Chat';
/*
 * Часть 2 задачи 2026-10-10: «Спайк» — отладочная страница звонка, и она статически тянула за
 * собой livekit-client в НАЧАЛЬНЫЙ бандл, то есть 300+ kB медиа-клиента получал каждый, кто
 * открыл «Главную». Теперь он ленивый, как и остальные маршруты (числа — в таблице «до и после»).
 */
const Spike = lazy(() => import('./pages/Spike'));
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';
import ErrorScreen from './pages/ErrorScreen';
import TitleManager from './components/TitleManager';
import ErrorBoundary from './components/ErrorBoundary';
// Performance (Phase 4): the heavy, editor/media surfaces are lazy-loaded so
// Excalidraw, FullCalendar, LiveKit and Tiptap stay OUT of the initial chunk.
const ClassDetail = lazy(() => import('./pages/ClassDetail'));
// часть A (2026-10-16): урок монтирует провайдер над роутером, поэтому он здесь не маршрут
import { LessonHostProvider, LessonSlot } from './components/LessonLive';
// часть 4: архив урока — своя ленивая страница, чтобы Excalidraw-миниатюры не ехали в начальный чанк
const ClassArchive = lazy(() => import('./pages/ClassArchive'));
const MaterialNew = lazy(() => import('./pages/MaterialNew'));
const Calendar = lazy(() => import('./pages/Calendar'));
const Notes = lazy(() => import('./pages/Notes'));
const Sheets = lazy(() => import('./pages/Sheets'));

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
      // NO locale in this body (task 1, run 37974043289): the sync says nothing about a language,
      // and re-sending `me.locale` from this snapshot raced the language carry-over below — on a
      // UTC machine the two PATCHes land in either order, and the one that landed last looked
      // like a person choosing the language they had never seen.
      void api('/api/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: me.name, tz: dev }),
      }).then(() => refresh()).catch(() => undefined);
    };
    syncTz();
    window.addEventListener('focus', syncTz);
    return () => window.removeEventListener('focus', syncTz);
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    const u = await fetchMe();
    setMe(u);
    if (!u) return;
    /*
     * Language (task 1, 2026-10-09). This line used to be
     *   `if (u.locale !== i18n.language) changeLanguage(u.locale)`
     * — every profile, including one nobody ever touched, over the device. The order is now
     * profile-if-chosen > this device > default, and a choice made on the sign-in screen is
     * carried into the account the first time it is seen, so it survives the next device too.
     */
    const sources = { profileLocale: u.locale, profileExplicit: u.localeExplicit, storedLocale: storedLocale() };
    if (shouldCarryStoredChoice(sources)) {
      void api('/api/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: u.name, tz: u.tz, locale: sources.storedLocale }),
      }).then(() => refresh()).catch(() => undefined);
    }
    await applyLocale(resolveLocale(sources));
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
        ) : me.mustChangePassword ? (
          // Part 3: a temporary password is still in force (teacher reset the
          // student, or the owner reset a teacher). The app stays locked until
          // the user sets their own — the change clears the flag + revokes the
          // other sessions, then refresh() unlocks the Shell.
          <div className="container">
            <AuthHeader />
            <ChangePasswordGate onDone={refresh} />
          </div>
        ) : (
        <LessonHostProvider>
        <Shell me={me}>
          <Suspense fallback={<div className="container muted">…</div>}>
          <Routes>
            <Route path="/" element={<Home me={me} />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/notes" element={me.role === 'teacher' ? <Notes /> : <ErrorScreen kind="403" />} />
            <Route path="/classes" element={<Classes />} />
            <Route path="/classes/:id" element={<ClassDetail />} />
            {/* часть 4: архив класса. Роль здесь не проверяется — права решает сервер, и ученику
                с выключенным переключателем положен тот же 404, что и чужому классу */}
            <Route path="/classes/:id/archive" element={<ClassArchive />} />
            {/* material task A — the create form is a separate page, teacher only */}
            <Route path="/classes/:id/material/new" element={me.role === 'teacher' ? <MaterialNew /> : <ErrorScreen kind="403" />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/lesson" element={<LessonSlot />} />
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
          </Suspense>
        </Shell>
        </LessonHostProvider>
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
  // на странице урока проба «где идёт урок» не нужна: там свой статус-запрос и сокет
  const where = useLocation();
  const live = useLiveClass(!where.pathname.startsWith('/lesson'));
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
