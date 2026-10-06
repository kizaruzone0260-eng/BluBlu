import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { login } from '../lib/api';
import { buildId } from '../lib/build';

export default function Login({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      await login(email, password);
      onDone();
    } catch (e: unknown) {
      setErr((e as { code?: string }).code ?? 'errorGeneric');
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto' }}>
      <h1>{t('common.login')}</h1>
      <form onSubmit={submit}>
        <label htmlFor="login-email">{t('common.email')}</label>
        <input id="login-email" data-testid="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        <label htmlFor="login-password">{t('common.password')}</label>
        <input id="login-password" data-testid="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        {err && <p className="error" role="alert">{t(`auth.${err}`, { defaultValue: t('common.errorGeneric') })}</p>}
        <button data-testid="login-submit" type="submit">{t('common.login')}</button>
      </form>
      <p className="muted">
        {t('auth.haveCode')} <Link to="/register">{t('common.register')}</Link>
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
