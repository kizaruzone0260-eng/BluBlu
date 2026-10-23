import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { consumeJoinToken, JOIN_TOKEN_KEY, passwordPolicy, POLICY_VERSION } from '@klass/shared';
import { joinByInvite, login, logout, previewInvite, registerByInvite, acceptPolicy } from '../lib/api';
import { useAuth } from '../App';
import AuthError from '../components/AuthError';
import { storedLocale } from '../i18n';
import { fmtDateTime } from '../lib/format';

/**
 * Вход по одноразовой ссылке (задача 2026-10-23, часть B).
 *
 * Ссылка выглядит как `/join#<токен>`. Фрагмент уже вычищен из адреса инлайн-скриптом в
 * `index.html` — до первого запроса страницы; сюда токен приходит либо из него, либо (если
 * скрипт не отработал) читается и стирается здесь же, на первом же рендере.
 *
 * Что экран ОБЯЗАН делать по постановке:
 *  • показать класс ДО того, как что-либо запрашивать с токеном повторно, и не спалить токен
 *    ни в заголовок, ни в консоль, ни в адрес;
 *  • не предлагать поле «код класса»: класс знает сервер;
 *  • не слать ни за каким кодом из письма — подтверждения почты в продукте нет;
 *  • дать два пути человеку, у которого аккаунт уже есть: войти прямо здесь (токен тогда не
 *    теряется) или продолжить существующим аккаунтом, если он уже в системе.
 *
 * Вход сделан прямо на этой странице, а не ссылкой на `/login`, по одной причине: `/login`
 * уводит с `/join`, а токен после очистки адреса существует только в памяти этой страницы.
 * Ссылка «есть аккаунт? войти» существующую форму не дублирует логикой — тот же `login()` из
 * `lib/api.ts` и тот же ответ сервера.
 */
type Phase = 'loading' | 'invited' | 'joined' | 'broken';

interface Preview { className: string; expiresAt: string | null }

/**
 * Отметка «успех уже случился на ЭТОЙ загрузке страницы». Нужна ровно из-за одного места:
 * `onDone()` подставляет `me`, и React перемонтирует `/join` из другой ветки дерева
 * (незалогиненная → Shell). При перемонтировании токен достать уже не откуда — фрагмент вычищен,
 * stash прочитан, — и без этой отметки человек получил бы «приглашение не найдено» в ту самую
 * секунду, когда он успешно вошёл в класс. Живёт до первого перехода, дальше не нужен.
 */
const DONE_KEY = '__blubluJoinDone';
type DoneMark = { classId: string; className: string };

function readDoneMark(): DoneMark | null {
  const v = (window as unknown as Record<string, unknown>)[DONE_KEY];
  return v && typeof v === 'object' ? (v as DoneMark) : null;
}

export default function Join({ onDone }: { onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const nav = useNavigate();
  const [token] = useState<string | null>(() =>
    consumeJoinToken(
      window.location,
      window.history,
      (window as unknown as Record<string, unknown>)[JOIN_TOKEN_KEY],
    ));
  // свежий токен важнее отметки: если на этой же загрузке страницы человек открыл новую ссылку,
  // он проходит её заново, а не видит чужой экран «готово»
  const [done] = useState<DoneMark | null>(() => (token ? null : readDoneMark()));
  const [phase, setPhase] = useState<Phase>(() => {
    if (done) return 'joined';
    return token ? 'loading' : 'broken';
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  /** ошибка сервера = код + reqId; экран переводит код, id печатает для учителя */
  const [err, setErr] = useState<{ code: string; reqId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'register' | 'signin'>('register');

  // форма регистрации
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  // форма входа существующего аккаунта
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const previewShown = useMemo(() => (preview ? {
    name: preview.className,
    until: preview.expiresAt ? fmtDateTime(preview.expiresAt, i18n.language) : null,
  } : null), [preview, i18n.language]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    (async () => {
      try {
        const p = await previewInvite(token);
        if (!alive) return;
        setPreview(p);
        setPhase('invited');
      } catch (e: unknown) {
        if (!alive) return;
        const api = e as { code?: string; reqId?: string; status?: number };
        setErr({ code: api.code ?? 'inviteInvalid', reqId: api.reqId ?? '' });
        setPhase('broken');
      }
    })();
    return () => { alive = false; };
    // токен берётся один раз на жизнь страницы: повторный вызов только набил бы лимиты
  }, [token]);

  function rememberError(e: unknown, fallback: string) {
    const api = e as { code?: string; reqId?: string };
    setErr({ code: api.code ?? fallback, reqId: api.reqId ?? '' });
  }

  /** Куда идти после успешного входа в класс: сам класс, а не «домой, разберись сам». */
  function wentToClass(classId: string) {
    (window as unknown as Record<string, unknown>)[DONE_KEY] = { classId, className: preview?.className ?? '' };
    setPhase('joined');
    onDone();
    // секунда на то, чтобы человек УВИДЕЛ название класса: дальше роутер уводит сам, а отметка
    // о успехе уже в window, поэтому перемонтирование /join не покажет «приглашение не найдено»
    window.setTimeout(() => nav(`/classes/${classId}`), 1_000);
  }

  async function submitRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setErr(null);
    if (!accepted) { setErr({ code: 'mustAccept', reqId: '' }); return; }
    // проверка на этой стороне — только чтобы не слать заведомо пустое; решает сервер
    if (!passwordPolicy.safeParse(password).success) { setErr({ code: 'passwordTooWeak', reqId: '' }); return; }
    setBusy(true);
    try {
      const r = await registerByInvite(
        token, firstName.trim(), lastName.trim(), email.trim(), password, storedLocale() ?? undefined,
      );
      // согласие с этого экрана и есть принятие документов: тот же шаг, что делает регистрация по коду
      await acceptPolicy(POLICY_VERSION).catch(() => undefined);
      wentToClass(r.classId);
    } catch (e: unknown) {
      rememberError(e, 'errorGeneric');
    } finally {
      setBusy(false);
    }
  }

  async function submitSignin(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setErr(null);
    setBusy(true);
    try {
      await login(loginEmail.trim(), loginPassword);
      const r = await joinByInvite(token);
      wentToClass(r.classId);
    } catch (e: unknown) {
      rememberError(e, 'invalidCredentials');
    } finally {
      setBusy(false);
    }
  }

  async function continueWithMe() {
    if (!token) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await joinByInvite(token);
      wentToClass(r.classId);
    } catch (e: unknown) {
      rememberError(e, 'errorGeneric');
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    // выйти и остаться на приглашении: токен жив в памяти страницы, поэтому «другой аккаунт»
    // не превращается в «откройте ссылку заново»
    await logout();
    onDone();
    setMode('signin');
  }

  if (phase === 'joined') {
    const name = preview?.className || done?.className || '';
    return (
      <div className="card join-card" data-testid="join-done" role="status">
        <h1>{t('join.title')}</h1>
        <p className="ok" data-testid="join-done-text">
          {name ? t('join.joined', { name }) : t('join.joinedPlain')}
        </p>
      </div>
    );
  }

  if (phase === 'broken') {
    return (
      <div className="card join-card" data-testid="join-broken">
        <h1>{t('join.title')}</h1>
        {token
          ? <AuthError code={err?.code ?? 'inviteInvalid'} reqId={err?.reqId} />
          : (
            <>
              <p className="error" role="alert">{t('join.noToken')}</p>
              <p className="muted" style={{ fontSize: '.9rem' }}>{t('join.noTokenHint')}</p>
            </>
          )}
        <p className="muted"><Link to="/login">{t('common.login')}</Link></p>
      </div>
    );
  }

  return (
    <div className="card join-card" data-testid="join-page">
      <h1>{t('join.title')}</h1>
      {phase === 'loading' && <p className="muted" role="status" data-testid="join-loading">{t('join.loading')}</p>}
      {previewShown && (
        <p className="join-class" data-testid="join-class">
          {t('join.invitedTo', { name: previewShown.name })}
          {previewShown.until ? <span className="muted"> · {t('join.validUntil', { date: previewShown.until })}</span> : null}
        </p>
      )}

      {/* уже вошедший человек: продолжать или пересесть — выбор должен быть виден, а не угадываться */}
      {me && (
        <div className="join-as" data-testid="join-signed-in">
          <p>{t('join.asWhom', { name: me.name })}</p>
          {me.role === 'teacher' ? (
            <p className="muted" data-testid="join-teacher-note">{t('join.teacherLink')}</p>
          ) : (
            <div className="row">
              <button type="button" data-testid="join-continue" onClick={continueWithMe} disabled={busy}>
                {t('join.joinButton')}
              </button>
              <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="join-switch"
                onClick={switchAccount} disabled={busy}>
                {t('join.switchAccount')}
              </button>
            </div>
          )}
        </div>
      )}

      {!me && phase === 'invited' && (
        <>
          {mode === 'register' ? (
            <form onSubmit={submitRegister} data-testid="join-form">
              <label htmlFor="join-first">{t('auth.firstName')}</label>
              <input id="join-first" data-testid="join-first" value={firstName} onChange={(e) => setFirstName(e.target.value)}
                required minLength={2} autoComplete="given-name" />
              <label htmlFor="join-last">{t('auth.lastName')}</label>
              <input id="join-last" data-testid="join-last" value={lastName} onChange={(e) => setLastName(e.target.value)}
                required minLength={2} autoComplete="family-name" />
              <label htmlFor="join-email">{t('common.email')}</label>
              <input id="join-email" data-testid="join-email" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              <label htmlFor="join-password">{t('common.password')}</label>
              <input id="join-password" data-testid="join-password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
              <p className="muted" style={{ fontSize: '.82rem', marginTop: 4 }}>{t('join.passwordHint')}</p>
              <p className="consent-row">
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input id="join-consent" data-testid="join-consent" type="checkbox" checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)} style={{ width: 'auto', marginTop: 3 }} />
                  <span>
                    {t('consent.regCheckbox')}{' '}
                    <Link to="/privacy">{t('legalLinks.privacy')}</Link>
                    {' / '}
                    <Link to="/terms">{t('legalLinks.terms')}</Link>
                  </span>
                </label>
              </p>
              {err && (err.code === 'mustAccept'
                ? <p className="error" role="alert" data-testid="join-error">{t('consent.mustAccept')}</p>
                : <AuthError code={err.code} reqId={err.reqId}>{errHint(err.code)}</AuthError>)}
              <button type="submit" data-testid="join-register" disabled={busy}>{t('common.register')}</button>
              <p className="muted">
                <button type="button" className="ghost link-button" data-testid="join-to-signin"
                  style={{ marginTop: 0 }} onClick={() => { setErr(null); setMode('signin'); }}>
                  {t('join.haveAccount')}
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={submitSignin} data-testid="join-signin-form">
              <h2 style={{ fontSize: '1rem' }}>{t('join.signIn')}</h2>
              <label htmlFor="join-login-email">{t('common.email')}</label>
              <input id="join-login-email" data-testid="join-login-email" type="email" value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)} required autoComplete="email" />
              <label htmlFor="join-login-password">{t('common.password')}</label>
              <input id="join-login-password" data-testid="join-login-password" type="password" value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)} required autoComplete="current-password" />
              {err && <AuthError code={err.code} reqId={err.reqId}>{errHint(err.code)}</AuthError>}
              <div className="row">
                <button type="submit" data-testid="join-signin" disabled={busy}>{t('common.login')}</button>
                <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="join-to-register"
                  onClick={() => { setErr(null); setMode('register'); }}>
                  {t('join.backToRegister')}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      <p className="muted" style={{ fontSize: '.82rem' }}>{t('join.noEmailStep')}</p>
    </div>
  );

  /**
   * Подсказка под ошибкой. `alreadyMember` — это не авария: человек уже в классе, и ему нужно
   * не «повторить», а перейти. `emailTaken` — ровно тот случай, где вход решает всё.
   */
  function errHint(code: string) {
    if (code === 'emailTaken') {
      return (
        <p style={{ marginTop: '-8px' }}>
          <button type="button" className="ghost link-button" style={{ marginTop: 0 }} data-testid="join-error-signin"
            onClick={() => { setErr(null); setMode('signin'); }}>
            {t('join.haveAccount')}
          </button>
        </p>
      );
    }
    if (code === 'inviteExpired' || code === 'inviteRevoked' || code === 'inviteUsed') {
      return <p className="muted" style={{ fontSize: '.85rem' }}>{t('join.askTeacher')}</p>;
    }
    return null;
  }
}
