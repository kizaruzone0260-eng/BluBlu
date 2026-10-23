import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { acceptPolicy, checkCode, registerByCode, requestEmailCode } from '../lib/api';
import AuthError from '../components/AuthError';
import { storedLocale } from '../i18n';
import { useFeatures } from '../lib/features';
import { POLICY_VERSION } from '@klass/shared';

/**
 * Item 9 — student registration in two steps.
 * Step 1: class code + email + password. The code is VALIDATED without being
 * consumed (wrong/used/expired all give the same message), so leaving now
 * costs the class nothing. Step 2: given name + family name (both required);
 * only submitting step 2 creates the account and atomically redeems the code.
 *
 * Часть F (2026-10-16): когда на сервере включено подтверждение почты (`EMAIL_PROVIDER` ≠ none),
 * шаг 2 получает промежуточное состояние: сначала «Получить код» (письмо на адрес), потом поле на
 * шесть цифр и обычная отправка. Порядок не случайный — код просится ТОГДА, когда имя и фамилия
 * уже введены, чтобы письмо обращалось к человеку по имени, а не было машинной строкой.
 * При выключателе по умолчанию (`none`) экран остаётся ровно прежним: ни поля, ни кнопки.
 */
export default function Register({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { emailVerification } = useFeatures();
  const [step, setStep] = useState<1 | 2>(1);
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [emailCode, setEmailCode] = useState('');
  /** письмо запрошено: поле кода показано и кнопка сменилась с «получить» на «зарегистрировать» */
  const [codeRequested, setCodeRequested] = useState(false);
  const [accepted, setAccepted] = useState(false);
  /** code = the server's own error code; reqId = the short reference the pupil can send (task B) */
  const [err, setErr] = useState<{ code: string; reqId: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /** One place where an exception becomes a screen state, so no path can lose the id. */
  function rememberError(e: unknown, fallback: string) {
    const api = e as { code?: string; reqId?: string };
    setErr({ code: api.code ?? fallback, reqId: api.reqId ?? '' });
  }

  async function submitStep1(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await checkCode(code);
      setStep(2);
    } catch (e: unknown) {
      // ONE generic message for wrong / used / expired — nothing is revealed (§3.2/item 9)
      rememberError(e, 'invalidCode');
    } finally {
      setBusy(false);
    }
  }

  /** Запрос письма. Отдельный обработчик, а не часть отправки: человек должен видеть, что
   *  код вот-вот придёт, и иметь возможность попросить его заново, не теряя введённого. */
  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await requestEmailCode(firstName.trim(), lastName.trim(), email, storedLocale() ?? undefined);
      setCodeRequested(true);
    } catch (e: unknown) {
      rememberError(e, 'emailUnavailable');
    } finally {
      setBusy(false);
    }
  }

  async function submitStep2(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    // consent (Phase 2): the student must accept Privacy + Terms at step 2
    if (!accepted) { setErr({ code: 'mustAccept', reqId: '' }); return; }
    if (emailVerification && !codeRequested) { await sendCode(e); return; }
    if (emailVerification && !/^\d{6}$/.test(emailCode)) { setErr({ code: 'emailCodeRequired', reqId: '' }); return; }
    setBusy(true);
    try {
      // a language picked on this screen is a choice, so it belongs to the new account (task 1);
      // storedLocale() is only set by an actual click, never by the app's own default
      await registerByCode(
        firstName.trim(), lastName.trim(), email, password, code, storedLocale() ?? undefined,
        emailVerification ? emailCode : undefined,
      );
      // record the acceptance for the freshly created account (already logged in)
      await acceptPolicy(POLICY_VERSION).catch(() => undefined);
      onDone();
    } catch (e: unknown) {
      rememberError(e, 'errorGeneric');
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
          <label htmlFor="reg-code">{t('auth.classCode')}</label>
          <input id="reg-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required maxLength={9} data-testid="reg-code"
            style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 2 }} autoComplete="one-time-code" />
          <label htmlFor="reg-email">{t('common.email')}</label>
          <input id="reg-email" type="email" data-testid="reg-email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <label htmlFor="reg-password">{t('common.password')}</label>
          <input id="reg-password" data-testid="reg-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
          {err && (err.code === 'mustAccept'
            ? <p className="error" role="alert" data-testid="reg-error">{t('consent.mustAccept')}</p>
            : <AuthError code={err.code} reqId={err.reqId} />)}
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
          {/* Часть F: письмо с кодом просится один раз, потом поле кода. Оба живут ВНУТРИ шага 2,
              чтобы имя и фамилия успели попасть в обращение письма. */}
          {emailVerification && !codeRequested && (
            <p className="muted" data-testid="reg-email-code-hint" style={{ fontSize: '.85rem' }}>
              {t('auth.emailStepHint')}
            </p>
          )}
          {emailVerification && codeRequested && (
            <>
              <p className="muted" data-testid="reg-code-sent" style={{ fontSize: '.85rem' }}>{t('auth.codeSent')}</p>
              <label htmlFor="reg-email-code">{t('auth.emailCode')}</label>
              <input id="reg-email-code" data-testid="reg-email-code" value={emailCode} inputMode="numeric"
                autoComplete="one-time-code" maxLength={6}
                onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 4 }} />
            </>
          )}
          {err && (err.code === 'mustAccept' ? (
            <p className="error" data-testid="reg-error">{t('consent.mustAccept')}</p>
          ) : (
            /*
             * Task B: «почта уже занята» is the one failure the pupil can solve without anybody,
             * so the sentence comes with the way there — the sign-in link. The wording itself
             * does not confirm to a stranger that an account exists; it reads as a condition.
             */
            <AuthError code={err.code} reqId={err.reqId}>
              {err.code === 'emailTaken' ? (
                <p style={{ marginTop: '-8px' }}>
                  <Link to="/login" data-testid="reg-error-login">{t('common.login')}</Link>
                </p>
              ) : null}
            </AuthError>
          ))}
          <div className="row">
            {emailVerification && !codeRequested ? (
              /*
               * `type="submit"`, а не кнопка со своим обработчиком: иначе браузерная проверка
               * обязательных полей (имя, фамилия) не запускается, и человек получает письмо
               * «введите имя» постфактум. Отправка формы эту проверку делает сама.
               */
              <button data-testid="register-send-code" type="submit" disabled={busy}>
                {t('auth.sendCode')}
              </button>
            ) : (
              <button data-testid="register-submit" type="submit" disabled={busy}>{t('common.register')}</button>
            )}
            {/* новый код доступен и после ошибки: пять попыток — это потолок на письмо, а не на
                человека, и лишать его кнопки «попросить ещё» значило бы запереть форму */}
            {emailVerification && codeRequested && (
              <button className="ghost" type="button" style={{ marginTop: 0 }} data-testid="register-resend"
                disabled={busy || !firstName.trim() || !lastName.trim()} onClick={sendCode}>{t('auth.resend')}</button>
            )}
            <button className="ghost" type="button" style={{ marginTop: 0 }} onClick={() => { setStep(1); setErr(null); }}>
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
