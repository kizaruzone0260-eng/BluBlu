import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { APP_NAME } from '../lib/brand';

/**
 * Hardening Phase 3: a per-screen browser-tab title, translated in all three
 * languages, with the brand always suffixed. Maps the current route to a
 * `titles.*` key; re-runs whenever the language or path changes so the tab title
 * tracks both. A dynamic segment (e.g. /classes/:id) still resolves to a stable
 * screen key, so no per-entity titles leak into history.
 */
const ROUTE_KEY = (path: string): string => {
  if (path === '/' ) return 'home';
  if (path.startsWith('/login')) return 'login';
  if (path.startsWith('/register')) return 'register';
  if (path.startsWith('/profile')) return 'profile';
  if (path.startsWith('/notes')) return 'notes';
  if (path.startsWith('/sheets')) return 'sheets';
  if (path.startsWith('/calendar')) return 'calendar';
  if (path.startsWith('/lesson')) return 'lesson';
  if (path.startsWith('/privacy')) return 'privacy';
  if (path.startsWith('/terms')) return 'terms';
  if (path.startsWith('/chat')) return 'chat';
  // Telegram Mini App (часть F): у неё свой язык из профиля, но вкладка всё равно подписана
  if (path.startsWith('/mini')) return 'mini';
  if (/^\/classes\/[^/]+\/material\/new/.test(path)) return 'materialNew';
  if (/^\/classes\/[^/]+/.test(path) && path.split('/')[2]) return 'class';
  if (path.startsWith('/classes')) return 'classes';
  return 'app';
};

export default function TitleManager() {
  const loc = useLocation();
  const { t, i18n } = useTranslation();
  useEffect(() => {
    const key = ROUTE_KEY(loc.pathname);
    const label = t(`titles.${key}`);
    document.title = key === 'app' ? APP_NAME : `${label} · ${APP_NAME}`;
  }, [loc.pathname, i18n.language, t]);
  return null;
}
