import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { acceptPolicy, checkCode, registerByCode } from '../lib/api';
import { POLICY_VERSION } from '@klass/shared';

/**
 * Item 9 — student registration in two steps.
 * Step 1: class code + email + password. The code is VALIDATED without being
 * consumed (wrong/used/expired all give the same message), so leaving now
 * costs the class nothing. Step 2: given name + family name (both required);
 * only submitting step 2 creates the account and atomically redeems the code.
 */
export default function Register({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2>(1);
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitStep1(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await checkCode(code);
      setStep(2);
    } catch (e: unknown) {
      // ONE generic message for wrong / used / expired — nothing is revealed (§3.2/item 9)
      setErr((e as { code?: string }).code ?? 'invalidCode');
    } finally {
      setBusy(false);
    }
  }

  async function submitStep2(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    // consent (Phase 2): the student must accept Privacy + Terms at step 2
    if (!accepted) { setErr('mustAccept'); return; }
    setBusy(true);
    try {
      await registerByCode(firstName.trim(), lastName.trim(), email, password, code);
      // record the acceptance for the freshly created account (already logged in)
      await acceptPolicy(POLICY_VERSION).catch(() => undefined);
      onDone();
    } catch (e: unknown) {
      setErr((e as { code?: string }).code ?? 'errorGeneric');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto' }}>
      <h1>{t('auth.registerByCode')}</h1>
      <p className="muted" data-testid="reg-step" style={{ fontSize: '.85rem' }}>
        {step === 1 ? t('auth.step1') : t('auth.step2')} · {step}/2
      </p>
      {step === 1 ? (
        <form onSubmit={submitStep1}>
          <label>{t('auth.classCode')}</label>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required maxLength={9} data-testid="reg-code"
            style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 2 }} autoComplete="one-time-code" />
          <label>{t('common.email')}</label>
          <input type="email" data-testid="reg-email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <label>{t('common.password')}</label>
          <input data-testid="reg-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
          {err && <p className="error" data-testid="reg-error">{t(`auth.${err}`, { defaultValue: t('common.errorGeneric') })}</p>}
          <button data-testid="register-step1" type="submit" disabled={busy}>{t('auth.continue')}</button>
        </form>
      ) : (
        <form onSubmit={submitStep2}>
          <label htmlFor="reg-first">{t('auth.firstName')}</label>
          <input id="reg-first" data-testid="reg-first" value={firstName} onChange={(e) => setFirstName(e.target.value)}
            required minLength={2} autoComplete="given-name" />
          <label htmlFor="reg-last">{t('auth.lastName')}</label>
          <input id="reg-last" data-testid="reg-last" value={lastName} onChange={(e) => setLastName(e.target.value)}
            required minLength={2} autoComplete="family-name" />
          <p className="consent-row">
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input id="reg-consent" data-testid="reg-consent" type="checkbox" checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)} style={{ width: 'auto', marginTop: 3 }} />
              <span>
                {t('consent.regCheckbox')}{' '}
                <Link to="/privacy">{t('legalLinks.privacy')}</Link>
                {' / '}
                <Link to="/terms">{t('legalLinks.terms')}</Link>
              </span>
            </label>
          </p>
          {err && (
            <p className="error" data-testid="reg-error">
              {err === 'mustAccept' ? t('consent.mustAccept') : t(`auth.${err}`, { defaultValue: t('common.errorGeneric') })}
            </p>
          )}
          <div className="row">
            <button data-testid="register-submit" type="submit" disabled={busy}>{t('common.register')}</button>
            <button className="ghost" type="button" style={{ marginTop: 0 }} onClick={() => { setStep(1); setErr(''); }}>
              {t('auth.back')}
            </button>
          </div>
        </form>
      )}
      <p className="muted">
        <Link to="/login">{t('common.login')}</Link>
        {' · '}
        <Link to="/privacy">{t('legalLinks.privacy')}</Link>
        {' · '}
        <Link to="/terms">{t('legalLinks.terms')}</Link>
      </p>
    </div>
  );
}
