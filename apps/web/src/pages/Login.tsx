import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { login } from '../lib/api';
import AuthError from '../components/AuthError';
import { shouldSuggestBrowser } from '@klass/shared';
import { buildId } from '../lib/build';

export default function Login({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<{ code: string; reqId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // Часть B: подсказка «откройте в настоящем браузере» только там, где куки правда не выживают.
  // read/write передаются извне, чтобы решение осталось чистым и протестированным без документа;
  // вне браузера (SSR/тест) подсказки нет.
  const suggestBrowser =
    typeof document === 'undefined'
      ? false
      : shouldSuggestBrowser({
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          cookieEnabled: typeof navigator !== 'undefined' ? navigator.cookieEnabled : true,
          read: () => document.cookie,
          write: (next) => {
            document.cookie = next;
          },
        });

  async function copyLink() {
    if (typeof window === 'undefined') return;
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setLinkCopied(true);
    } catch { /* no clipboard permission: the address is still in the address bar to copy by hand */ }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      await login(email, password);
      onDone();
    } catch (e: unknown) {
      // Task B: the code AND the request id travel together — a locked account, a wrong
      // password and a throttled shared IP must all be explainable to the teacher in one line.
      const api = e as { code?: string; reqId?: string };
      setErr({ code: api.code ?? 'errorGeneric', reqId: api.reqId ?? '' });
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto' }}>
      <h1>{t('common.login')}</h1>
      {/*
        Task B: in Telegram's / Instagram's own browser the login itself works, but the
        refresh cookie often does not survive a reload — the pupil is sent back here and has no
        way to know why. One sentence, plus the address to open somewhere that keeps cookies.
      */}
      {suggestBrowser ? (
        <p className="muted auth-webview-hint" data-testid="login-webview-hint" style={{ fontSize: '.85rem' }}>
          {t('auth.openInBrowser')}{' '}
          <button
            type="button" className="ghost link-button" data-testid="login-copy-link"
            onClick={copyLink} aria-label={`${t('auth.copyLink')}: ${typeof window !== 'undefined' ? window.location.origin : ''}`}
          >
            {linkCopied ? t('auth.copied') : t('auth.copyLink')}
          </button>
        </p>
      ) : null}
      <form onSubmit={submit}>
        <label htmlFor="login-email">{t('common.email')}</label>
        <input id="login-email" data-testid="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        <label htmlFor="login-password">{t('common.password')}</label>
        <input id="login-password" data-testid="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        {err && <AuthError code={err.code} />}
        <button data-testid="login-submit" type="submit" disabled={busy}>{t('common.login')}</button>
      </form>
      <p className="muted">
        {t('auth.needInvite')} <Link to="/register">{t('auth.howToJoin')}</Link>
      </p>
      <p className="muted">
        <Link to="/privacy">{t('legalLinks.privacy')}</Link>
        {' · '}
        <Link to="/terms">{t('legalLinks.terms')}</Link>
      </p>
      {/* build stamp (task 1) — tiny, interface-only */}
      <p className="muted build-tag" data-testid="build-tag">build {buildId()}</p>
    </div>
  );
}
