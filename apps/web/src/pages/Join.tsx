import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { consumeJoinToken, JOIN_TOKEN_KEY, passwordPolicy, POLICY_VERSION } from '@klass/shared';
import { joinByInvite, login, logout, previewInvite, registerByInvite, acceptPolicy, requestEmailCode } from '../lib/api';
import { forgetJoinToken } from '../lib/joinToken';
import { clearJoinFlow, readJoinFlow, saveJoinFlow, type JoinFlowError } from '../lib/joinFlow';
import { useAuth } from '../App';
import AuthError from '../components/AuthError';
import { storedLocale } from '../i18n';
import { fmtDateTime } from '../lib/format';
import { useFeatures } from '../lib/features';

/**
 * Вход по одноразовой ссылке (задача 2026-10-23, часть B; починка 2026-10-26).
 *
 * Ссылка выглядит как `/join#<токен>`. Фрагмент уже вычищен из адреса первым оператором
 * `main.tsx` (`primeJoinToken` — раньше темы, раньше `ReactDOM` и раньше любого запроса
 * приложения; инлайн-скрипт в shell для этого не годится: его отбрасывает наша CSP
 * `script-src 'self'`), а сам токен оставлен в памяти страницы под `JOIN_TOKEN_KEY` — отсюда его
 * и берёт `consumeJoinToken` ниже.
 *
 * Что экран ОБЯЗАН делать по постановке:
 *  • показать класс ДО того, как что-либо запрашивать с токеном повторно, и не спалить токен
 *    ни в заголовок, ни в консоль, ни в адрес;
 *  • не предлагать поле «код класса»: класс знает сервер;
 *  • дать два пути человеку, у которого аккаунт уже есть: войти прямо здесь (токен тогда не
 *    теряется) или пересесть другим аккаунтом;
 *  • при занятой почте не выдавать «не удалось создать аккаунт» за конец истории: это вход,
 *    и форма входа должна открыться с уже набранной почтой;
 *  • учителю, открывшему ученическую ссылку, — объяснить и дать кнопку «войти учеником»,
 *    а не тупик из одной строчки.
 *
 * Почему вход и регистрация здесь идут с `deferNotify`: `login()`/`registerByInvite()` кладут
 * access-токен в память, но не объявляют вход сразу. Иначе `App` перезагрузил бы `/api/me`,
 * дерево маршрутов сменилось бы, и `/join` перемонтировался бы ПОСРЕДИ запроса «войти в класс»:
 * исход зависел бы от гонки двух запросов, а ошибка join осталась бы в состоянии уже
 * уничтоженного компонента. Экран сам зовёт `onDone()` (тот же refresh) в нужный момент:
 * после членства — с отметкой успеха, после ошибки входа в класс — с сохранённой ошибкой
 * (`lib/joinFlow.ts`), чтобы новый экземпляр показал «вы вошли, но в класс не попали» и кнопку
 * повтора. Токен всё это время лежит в stash и очищается только после успешного членства.
 */
type Phase = 'loading' | 'invited' | 'joined' | 'broken';

interface Preview { className: string; expiresAt: string | null }

/**
 * Отметка «успех уже случился на ЭТОЙ загрузке страницы». Живёт до первого перехода.
 * Нужна потому, что после `onDone()` `/join` перемонтируется уже в дереве вошедшего
 * пользователя: токен к этому моменту израсходован и очищен, а человек должен увидеть
 * «Готово: вы в классе …», а не «приглашение не найдено».
 */
const DONE_KEY = '__blubluJoinDone';
type DoneMark = { classId: string; className: string };

function readDoneMark(): DoneMark | null {
  const v = (window as unknown as Record<string, unknown>)[DONE_KEY];
  return v && typeof v === 'object' ? (v as DoneMark) : null;
}

function clearDoneMark(): void {
  delete (window as unknown as Record<string, unknown>)[DONE_KEY];
}

export default function Join({ onDone }: { onDone: () => void | Promise<void> }) {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const nav = useNavigate();
  const win = window as unknown as Window & { [key: string]: unknown };
  const [token] = useState<string | null>(() => {
    const fresh = consumeJoinToken(win.location, win.history, win[JOIN_TOKEN_KEY]);
    // новая ссылка важнее прошлой отметки об успехе: иначе повторное приглашение в тот же
    // браузер показало бы «вы уже в классе» вместо формы
    if (fresh) clearDoneMark();
    return fresh;
  });
  // состояние формы переживает перемонтирование после входа/выхода — в памяти вкладки, не в URL
  const saved = useMemo(() => (token ? readJoinFlow(token) : null), [token]);
  const [done] = useState<DoneMark | null>(() => (token ? null : readDoneMark()));
  const doneRef = useRef<DoneMark | null>(done);
  const [phase, setPhase] = useState<Phase>(() => {
    if (done) return 'joined';
    return token ? 'loading' : 'broken';
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  /** ошибка сервера = код + reqId; экран переводит код, а id только переносится между шагами:
   *  с 2026-10-27 он не показывается (см. `AuthError`), но остаётся в ответе и в access-логе */
  const [err, setErr] = useState<JoinFlowError | null>(saved?.error ?? null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'register' | 'signin'>(saved?.mode ?? 'register');

  // форма регистрации
  const [firstName, setFirstName] = useState(saved?.firstName ?? '');
  const [lastName, setLastName] = useState(saved?.lastName ?? '');
  const [email, setEmail] = useState(saved?.email ?? '');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  /*
   * Часть F (переехала сюда 2026-10-27 с экрана регистрации по коду). Подтверждение почты —
   * свойство транспорта, а не способа входа: если владелец включил `EMAIL_PROVIDER`, спросить
   * код из письма обязан и путь по ссылке. Поле и кнопка показываются ТОЛЬКО когда включатель
   * стоит: при выключенном экране не становится больше на одну лишнюю строчку.
   */
  const { emailVerification } = useFeatures();
  const [emailCode, setEmailCode] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
  // форма входа существующего аккаунта
  const [loginEmail, setLoginEmail] = useState(saved?.loginEmail ?? '');
  const [loginPassword, setLoginPassword] = useState('');

  const previewShown = useMemo(() => (preview ? {
    name: preview.className,
    until: preview.expiresAt ? fmtDateTime(preview.expiresAt, i18n.language) : null,
  } : null), [preview, i18n.language]);

  /** Снимок формы на случай перемонтирования. Пароли сюда не попадают намеренно. */
  function persist(overrides: Partial<Omit<ReturnType<typeof snapshot>, 'token'>> = {}) {
    if (!token) return;
    saveJoinFlow({ ...snapshot(), ...overrides });
  }
  function snapshot() {
    return { token: token ?? '', mode, firstName, lastName, email, loginEmail, error: err };
  }
  useEffect(() => {
    if (!token || doneRef.current) return;
    saveJoinFlow({ token, mode, firstName, lastName, email, loginEmail, error: err });
    // token не меняется на жизни экземпляра; остальные поля — ровно то, что нужно пережить
  }, [token, mode, firstName, lastName, email, loginEmail, err]);

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

  /**
   * Переход в класс — ровно один раз и только после того, как `App` узнал о входе.
   * Таймер заводится эффектом на `phase === 'joined'`, поэтому при перемонтировании старый
   * таймер снимается, а новый экземпляр (он тоже видит отметку) заводит свой. Так навигация
   * не остаётся в руках уничтоженного компонента.
   */
  useEffect(() => {
    if (phase !== 'joined') return;
    const mark = doneRef.current ?? readDoneMark();
    if (!mark) return;
    const timer = window.setTimeout(() => {
      clearDoneMark();
      nav(`/classes/${mark.classId}`, { replace: true });
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [phase, nav]);

  function rememberError(e: unknown, fallback: string) {
    const api = e as { code?: string; reqId?: string };
    const next = { code: api.code ?? fallback, reqId: api.reqId ?? '' };
    setErr(next);
    persist({ error: next });
    return next;
  }

  /**
   * Успешное членство. Порядок важен:
   *  1) отметка об успехе и очистка израсходованного токена — до любых сетевых ожиданий;
   *  2) `onDone()` (refresh) — теперь приложение может сменить дерево маршрутов;
   *  3) `phase = joined` — эффект выше отведёт на экран класса через секунду.
   * Если шаг 2 перемонтирует экран, новый экземпляр прочитает отметку и сам покажет «Готово».
   */
  async function wentToClass(classId: string) {
    const mark = { classId, className: preview?.className ?? '' };
    doneRef.current = mark;
    (window as unknown as Record<string, unknown>)[DONE_KEY] = mark;
    forgetJoinToken(win);
    clearJoinFlow();
    try {
      await Promise.resolve(onDone());
    } catch { /* refresh повторится при следующей загрузке; членство уже состоялось */ }
    setPhase('joined');
  }

  /**
   * Запрос письма. Отдельный обработчик, а не часть отправки: человек должен видеть, что код
   * вот-вот придёт, и иметь возможность попросить его заново, не теряя введённого. Имя и фамилия
   * к этому моменту уже набраны — письмо обращается к человеку, а не к «уважаемый пользователь».
   */
  async function sendCode() {
    setErr(null);
    setBusy(true);
    try {
      await requestEmailCode(firstName.trim(), lastName.trim(), email.trim(), storedLocale() ?? undefined);
      setCodeRequested(true);
    } catch (e: unknown) {
      rememberError(e, 'emailUnavailable');
    } finally {
      setBusy(false);
    }
  }

  async function submitRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setErr(null);
    if (!accepted) { setErr({ code: 'mustAccept', reqId: '' }); return; }
    // проверка на этой стороне — только чтобы не слать заведомо пустое; решает сервер
    if (!passwordPolicy.safeParse(password).success) { setErr({ code: 'passwordTooWeak', reqId: '' }); return; }
    // часть F: сначала письмо, потом шесть цифр — ровно в том же порядке, что был на экране
    // регистрации по коду, потому что порядок этот про обращение в письме, а не про способ входа
    if (emailVerification && !codeRequested) { await sendCode(); return; }
    if (emailVerification && !/^\d{6}$/.test(emailCode)) { setErr({ code: 'emailCodeRequired', reqId: '' }); return; }
    setBusy(true);
    try {
      const r = await registerByInvite(
        token, firstName.trim(), lastName.trim(), email.trim(), password, storedLocale() ?? undefined,
        { deferNotify: true, ...(emailVerification ? { emailCode } : {}) },
      );
      // согласие с этого экрана и есть принятие документов: тот же шаг, что делает регистрация по коду
      await acceptPolicy(POLICY_VERSION).catch(() => undefined);
      await wentToClass(r.classId);
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
    let stage: 'login' | 'join' = 'login';
    try {
      const user = await login(loginEmail.trim(), loginPassword, { deferNotify: true });
      setLoginPassword('');
      persist({ loginEmail: loginEmail.trim(), error: null });
      // Учитель вошёл на ученическую ссылку: роль не понижаем и в класс не добавляем.
      // Говорим это кодом, который переводится, и оставляем приглашение живым.
      if (user.role !== 'student') {
        const next = { code: 'studentAccountRequired', reqId: '' };
        setErr(next);
        persist({ error: next });
        await Promise.resolve(onDone());
        return;
      }
      stage = 'join';
      const r = await joinByInvite(token);
      await wentToClass(r.classId);
    } catch (e: unknown) {
      // Ошибка входа и ошибка уже вошедшего человека — разные вещи: первая значит «пароль
      // не тот», вторая — «пароль верный, но в класс не пустили». Вторая обязана оставить
      // человека в приложении, с сохранённой причиной и возможностью повторить.
      rememberError(e, stage === 'login' ? 'invalidCredentials' : 'errorGeneric');
      if (stage === 'join') await Promise.resolve(onDone());
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
      await wentToClass(r.classId);
    } catch (e: unknown) {
      rememberError(e, 'errorGeneric');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Смена аккаунта не должна стоить приглашения. Режим и почту сохраняем синхронно ДО
   * `logout()`: выход объявляет `App`, тот перемонтирует `/join`, и только снимок в
   * `joinFlow` доносит до нового экземпляра, что нужна форма входа, а не регистрация.
   */
  async function switchAccount() {
    persist({ mode: 'signin', loginEmail: '', error: null });
    setErr(null);
    setMode('signin');
    setLoginPassword('');
    await logout();
  }

  function goSignin() {
    // почта, которую человек только что набрал в регистрации, — безопасный и полезный
    // предзаполнитель: она уже в этом браузере и почти всегда та самая
    const prefill = loginEmail || email.trim();
    persist({ mode: 'signin', loginEmail: prefill, error: null });
    setErr(null);
    setLoginEmail(prefill);
    setMode('signin');
  }

  function goRegister() {
    persist({ mode: 'register', error: null });
    setErr(null);
    setMode('register');
  }

  if (phase === 'joined') {
    const name = preview?.className || done?.className || doneRef.current?.className || '';
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
          ? <AuthError code={err?.code ?? 'inviteInvalid'} />
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

      {/* уже вошедший человек: продолжить или пересесть — выбор должен быть виден, а не угадываться.
          Учителю мало строчки «ссылка для ученика»: без явной кнопки он остаётся в тупике. */}
      {me && (
        <div className="join-as" data-testid="join-signed-in">
          <p>{t('join.asWhom', { name: me.name })}</p>
          {me.role === 'teacher' ? (
            <>
              <p className="muted" data-testid="join-teacher-note">{t('join.teacherLink')}</p>
              <div className="row">
                <button type="button" data-testid="join-switch" onClick={switchAccount} disabled={busy}>
                  {t('join.signInAsStudent')}
                </button>
              </div>
            </>
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
          {err && <AuthError code={err.code}>{errHint(err.code)}</AuthError>}
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
              {/* часть F: письмо просится один раз, потом поле на шесть цифр. Оба живут ВНУТРИ
                  формы регистрации, чтобы имя и фамилия успели попасть в обращение письма. */}
              {emailVerification && !codeRequested && (
                <p className="muted" data-testid="join-email-code-hint" style={{ fontSize: '.85rem' }}>
                  {t('auth.emailStepHint')}
                </p>
              )}
              {emailVerification && codeRequested && (
                <>
                  <p className="muted" data-testid="join-code-sent" style={{ fontSize: '.85rem' }}>{t('auth.codeSent')}</p>
                  <label htmlFor="join-email-code">{t('auth.emailCode')}</label>
                  <input id="join-email-code" data-testid="join-email-code" value={emailCode} inputMode="numeric"
                    autoComplete="one-time-code" maxLength={6}
                    onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                    style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 4 }} />
                </>
              )}
              {err && (err.code === 'mustAccept'
                ? <p className="error" role="alert" data-testid="join-error">{t('consent.mustAccept')}</p>
                : <AuthError code={err.code}>{errHint(err.code)}</AuthError>)}
              {emailVerification && !codeRequested ? (
                /*
                 * `type="submit"`, а не кнопка со своим обработчиком: иначе браузерная проверка
                 * обязательных полей (имя, фамилия) не запускается, и человек получает письмо
                 * «введите имя» постфактум. Отправка формы эту проверку делает сама.
                 */
                <button type="submit" data-testid="join-send-code" disabled={busy}>{t('auth.sendCode')}</button>
              ) : (
                <button type="submit" data-testid="join-register" disabled={busy}>{t('common.register')}</button>
              )}
              {/* новый код доступен и после ошибки: пять попыток — потолок на письмо, а не на
                  человека, и лишать кнопки «попросить ещё» значило бы запереть форму */}
              {emailVerification && codeRequested && (
                <button className="ghost" type="button" style={{ marginTop: 0 }} data-testid="join-resend"
                  disabled={busy || !firstName.trim() || !lastName.trim()} onClick={() => void sendCode()}>
                  {t('auth.resend')}
                </button>
              )}
              <p className="muted">
                <button type="button" className="ghost link-button" data-testid="join-to-signin"
                  style={{ marginTop: 0 }} onClick={goSignin}>
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
              {err && <AuthError code={err.code}>{errHint(err.code)}</AuthError>}
              <div className="row">
                <button type="submit" data-testid="join-signin" disabled={busy}>{t('common.login')}</button>
                <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="join-to-register"
                  onClick={goRegister}>
                  {t('join.backToRegister')}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {!emailVerification && <p className="muted" style={{ fontSize: '.82rem' }}>{t('join.noEmailStep')}</p>}
    </div>
  );

  /**
   * Подсказка под ошибкой. `emailTaken` — это не конец: это вход. Кнопка должна не просто
   * переключить форму, а перенести в неё уже набранную почту. `alreadyMember` — не авария:
   * человек уже в классе, и ему нужно перейти.
   */
  function errHint(code: string) {
    if (code === 'emailTaken') {
      return (
        <p style={{ marginTop: '-8px' }}>
          <button type="button" className="ghost link-button" style={{ marginTop: 0 }} data-testid="join-error-signin"
            onClick={goSignin}>
            {t('join.haveAccount')}
          </button>
        </p>
      );
    }
    if (code === 'inviteExpired' || code === 'inviteRevoked' || code === 'inviteUsed' || code === 'inviteInvalid') {
      return <p className="muted" style={{ fontSize: '.85rem' }}>{t('join.askTeacher')}</p>;
    }
    return null;
  }
}
