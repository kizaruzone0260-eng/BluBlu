import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { registerByCode } from '../lib/api';

export default function Register({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      await registerByCode(name, email, password, code);
      onDone();
    } catch (e: unknown) {
      setErr((e as { code?: string }).code ?? 'errorGeneric');
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto' }}>
      <h1>{t('auth.registerByCode')}</h1>
      <form onSubmit={submit}>
        <label>{t('common.name')}</label>
        <input data-testid="reg-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} autoComplete="name" />
        <label>{t('common.email')}</label>
        <input type="email" data-testid="reg-email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        <label>{t('common.password')}</label>
        <input data-testid="reg-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        <label>{t('auth.classCode')}</label>
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required maxLength={9} data-testid="reg-code"
          style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 2 }} />
        {err && <p className="error">{t(`auth.${err}`, { defaultValue: t('common.errorGeneric') })}</p>}
        <button data-testid="register-submit" type="submit">{t('common.register')}</button>
      </form>
      <p className="muted"><Link to="/login">{t('common.login')}</Link></p>
    </div>
  );
}
