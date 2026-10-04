import { useEffect, useRef, useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, type Me } from '../lib/api';
import { APP_NAME } from '../lib/brand';
import { useChatUnread } from '../lib/chat';
import { getThemeChoice, setTheme, type ThemeChoice } from '../lib/theme';

/** Minimal inline icon set (stroke-based, inherits currentColor). */
export const Icon = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const icons = {
  home: 'M3 11l9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5',
  classes: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM9 7h7M9 11h7M12 15h4',
  calendar: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 9h16M8 3v4M16 3v4',
  notes: 'M6 3h12a1 1 0 0 1 1 1v14a2 2 0 0 1-2 2H6a2 2 0 0 0 2-2V3zM9 8h7M9 12h5',
  live: 'M12 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6.3 17.7a8 8 0 0 1 0-11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 20.5a13 13 0 0 1 0-17M20.5 3.5a13 13 0 0 1 0 17',
  chat: 'M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  collapse: 'M15 6l-6 6 6 6',
  logout: 'M9 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v3M12 20v3M4.2 4.2l2.2 2.2M17.6 17.6l2.2 2.2M1 12h3M20 12h3M4.2 19.8l2.2-2.2M17.6 6.4l2.2-2.2',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
};

const LOCALES = [
  { code: 'ru', native: 'Русский' },
  { code: 'uz', native: "Oʻzbekcha" },
  { code: 'en', native: 'English' },
] as const;

/** Compact language dropdown: shows CURRENT language, switches instantly (B.2). */
export function LangDropdown({ me, onMeChanged }: { me: Me | null; onMeChanged?: () => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const current = LOCALES.find((l) => l.code === i18n.language) ?? LOCALES[0];
  async function pick(code: string) {
    setOpen(false);
    await i18n.changeLanguage(code);
    if (me) {
      // single source of truth: the profile follows the UI switch immediately (fixes
      // the old mismatch where the topbar caption showed the *target* language)
      try {
        await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify({ name: me.name, tz: me.tz, locale: code }) });
        onMeChanged?.();
      } catch { /* UI language still switched for this session */ }
    }
  }
  return (
    <div className="lang-wrap" ref={ref}>
      <button className="ghost" style={{ marginTop: 0 }} onClick={() => setOpen(!open)} aria-label={t('common.language')}>
        <Icon d={icons.globe} size={18} /> {current.code.toUpperCase()}
      </button>
      {open && (
        <div className="lang-menu" role="menu">
          {LOCALES.map((l) => (
            <button key={l.code} className={l.code === current.code ? 'sel' : ''} onClick={() => void pick(l.code)} role="menuitem">
              {l.native}{l.code === current.code ? ' ✓' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Light / dark / system cycler. */
export function ThemeToggle() {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice());
  useEffect(() => {
    const h = (e: Event) => setChoice((e as CustomEvent).detail as ThemeChoice);
    window.addEventListener('klass-theme', h);
    return () => window.removeEventListener('klass-theme', h);
  }, []);
  const next: ThemeChoice = choice === 'light' ? 'dark' : choice === 'dark' ? 'system' : 'light';
  const label = t(`common.theme${choice === 'light' ? 'Light' : choice === 'dark' ? 'Dark' : 'System'}`);
  return (
    <button className="ghost" style={{ marginTop: 0, justifyContent: 'flex-start' }}
      onClick={() => setTheme(next)} title={`${label} → ${next}`}>
      <Icon d={choice === 'dark' ? icons.moon : icons.sun} size={18} /> <span className="lbl">{label}</span>
    </button>
  );
}

async function doLogout() {
  const { logout } = await import('../lib/api');
  await logout();
}

export interface NavState { liveClassId: string | null }

export function Nav({ me, live }: { me: Me | null; live: NavState }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('klass_sidebar') === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const unreadQ = useChatUnread();
  const unread = (unreadQ.data ?? []).reduce((n, s) => n + s.unread, 0);
  const initials = (me?.name ?? '?').trim().split(/\s+/).map((w) => w[0]?.toUpperCase() ?? '').slice(0, 2).join('') || '?';
  const notesTo = me?.role === 'student' ? '/sheets' : '/notes';
  const items = [
    { to: '/', icon: icons.home, label: t('nav.home'), end: true },
    { to: '/classes', icon: icons.classes, label: t('nav.classes') },
    { to: '/calendar', icon: icons.calendar, label: t('nav.calendar') },
    { to: notesTo, icon: icons.notes, label: t('nav.notes') },
    { to: '/chat', icon: icons.chat, label: t('nav.chat'), badge: unread }, // item 8
    ...(live.liveClassId ? [{ to: `/lesson?classId=${live.liveClassId}`, icon: icons.live, label: t('nav.lessons') }] : []),
  ];

  return (
    <>
      {/* ≥768px — sidebar */}
      {me && !loggedOut && (
        <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
          <Link to="/" className="side-brand">
            <span className="side-logo">B</span>
            <span className="lbl">{APP_NAME}</span>
          </Link>
          <nav className="side-nav">
            {items.map((it) => (
              <NavLink key={it.to} to={it.to} end={it.end}
                className={({ isActive }) => (isActive ? 'side-item active' : 'side-item')}>
                <span className="ico"><Icon d={it.icon} /></span>
                <span className="lbl">{it.label}</span>
                {'badge' in it && it.badge ? <span className="nav-badge" data-testid="nav-chat-badge">{(it.badge as number) > 99 ? '99+' : it.badge}</span> : null}
              </NavLink>
            ))}
          </nav>
          <div className="side-foot">
            <div className="side-lang" style={{ padding: '4px 8px' }}>
              <LangDropdown me={me} onMeChanged={() => undefined} />
            </div>
            <button className="ghost" style={{ margin: 0, width: '100%', justifyContent: 'flex-start' }}
              onClick={() => { const c = !collapsed; setCollapsed(c); localStorage.setItem('klass_sidebar', c ? '1' : '0'); }}
              title={t('nav.collapse')}>
              <span style={{ transform: collapsed ? 'rotate(180deg)' : undefined, display: 'inline-flex' }}><Icon d={icons.collapse} size={18} /></span>
              {!collapsed && <span className="lbl">{t('nav.collapse')}</span>}
            </button>
            <div className="side-user" onClick={() => setMenuOpen(!menuOpen)} role="button" tabIndex={0}>
              <span className="avatar">{initials}</span>
              <span className="lbl" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{me.name}</span>
            </div>
            {menuOpen && (
              <div className="menu-pop" onMouseLeave={() => setMenuOpen(false)}>
                <NavLink to="/profile" className="side-item" onClick={() => setMenuOpen(false)}>
                  <span className="ico"><Icon d={icons.profile} size={18} /></span><span className="lbl">{t('nav.profile')}</span>
                </NavLink>
                <div style={{ padding: '4px 8px' }}><LangDropdown me={me} /></div>
                <ThemeToggle />
                <button className="ghost" onClick={() => {
                  setMenuOpen(false);
                  void doLogout().then(() => { setLoggedOut(true); window.location.href = '/login'; });
                }}>
                  <Icon d={icons.logout} size={18} /> {t('common.logout')}
                </button>
              </div>
            )}
          </div>
        </aside>
      )}

      {/* <768px — compact app bar + bottom tabs */}
      <header className="appbar">
        <Link to="/" className="side-brand" style={{ padding: 0 }}>
          <span className="side-logo" style={{ width: 28, height: 28, flex: '0 0 28px', fontSize: '.95rem' }}>B</span>
          <span>{APP_NAME}</span>
        </Link>
        <div className="spacer" />
        <LangDropdown me={me} />
        {me && <Link to="/profile" aria-label={t('nav.profile')} style={{ display: 'inline-flex', alignItems: 'center' }}><Icon d={icons.profile} size={20} /></Link>}
      </header>

      {me && !loggedOut && (
        <nav className="tabbar">
          {items.slice(0, 5).map((it) => (
            <NavLink key={it.to} to={it.to} end={it.end}
              className={({ isActive }) => (isActive ? 'active' : undefined)}>
              <span className="ico"><Icon d={it.icon} size={20} />{'badge' in it && it.badge ? <span className="nav-badge dot" aria-hidden>•</span> : null}</span>
              {it.label}
            </NavLink>
          ))}
          {live.liveClassId
            ? <NavLink to={`/lesson?classId=${live.liveClassId}`} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                <span className="ico"><Icon d={icons.live} size={20} /></span>{t('nav.lessons')}
              </NavLink>
            : <NavLink to="/profile" className={({ isActive }) => (isActive ? 'active' : undefined)}>
                <span className="ico"><Icon d={icons.profile} size={20} /></span>{t('nav.profile')}
              </NavLink>}
        </nav>
      )}
    </>
  );
}
