import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { INVITE_LABEL_MAX, INVITE_LINK_DEFAULT_TTL_DAYS, INVITE_LINK_TTL_DAYS, passwordPolicy } from '@klass/shared';
import { fmtDate } from '../lib/format';
import { useAuth } from '../App';
import Feed from '../components/Feed';
import InviteHistory from '../components/InviteHistory';
import AuthError from '../components/AuthError';

interface MemberRow { userId: string; name: string; email: string; joinedAt: string }
/**
 * Ответ `POST /api/classes/:id/members/lookup` (2026-10-27, часть B): сервер нашёл
 * существующий аккаунт ученика, но членства ещё нет — оно появится только после
 * подтверждения. `className`/`classId` приходят с сервера, чтобы в карточке стояло то
 * же имя класса, которое хранится в базе, а не то, что страница успела загрузить.
 */
interface StudentMatch {
  userId: string;
  name: string;
  email: string;
  alreadyMember: boolean;
  classId: string;
  className: string;
}
interface ClassView { id: string; name: string; description: string; color: string; archived: boolean; chatMode?: 'on' | 'off' | 'announce'; botPublicSchedule?: boolean; boardArchivePublic?: boolean }

export default function ClassDetail() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  // задача 2026-10-23: ссылка-приглашение. `newLink` живёт только в памяти этой страницы —
  // сервер отдаёт её ровно один раз, и «показать ещё раз» честного способа не имеет.
  const [linkLabel, setLinkLabel] = useState('');
  const [linkTtl, setLinkTtl] = useState<number>(INVITE_LINK_DEFAULT_TTL_DAYS);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // окно истории закрыто по умолчанию: на главном экране класса записей нет, пока учитель не
  // попросил их посмотреть (задача 2026-10-24, часть B)
  const [historyOpen, setHistoryOpen] = useState(false);
  // сброс пароля учителем (часть C): null — форма закрыта, иначе id ученика
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pwA1, setPwA1] = useState('');
  const [pwA2, setPwA2] = useState('');
  // показ сгенерированного временного пароля (2026-10-28): «скопировано» живёт до следующего сброса
  const [pwCopied, setPwCopied] = useState(false);
  // 2026-10-26: добавление СУЩЕСТВУЮЩЕГО аккаунта по почте. Нужно ровно для тупика
  // «ученик забыл пароль, а в списке его нет»: сброс требует членства, а членства нет.
  // Пароль здесь не создаётся и не меняется — только строка в class_members.
  const [addEmail, setAddEmail] = useState('');
  const [addNotice, setAddNotice] = useState('');
  // часть B (2026-10-27): найденный аккаунт живёт здесь, пока учитель его не подтвердил.
  // Поиск и членство разведены намеренно: по одной почте в класс попадал человек, которого
  // учитель ни разу не видел, а «Ann@X.io» в 7-Б мог оказаться совсем не той Анной.
  const [addMatch, setAddMatch] = useState<StudentMatch | null>(null);
  // 2026-10-27: аккаунт ученика создаёт учитель. Имя, фамилия, почта и ВРЕМЕННЫЙ пароль, который
  // набирает сам учитель, — так экран перестаёт быть тупиком «пусть сначала зарегистрируется сам».
  // Пароль живёт только в состоянии этой формы: он нигде не сохраняется, в ответ сервера не
  // приходит и после удачного создания форму покидает.
  const [scFirst, setScFirst] = useState('');
  const [scLast, setScLast] = useState('');
  const [scEmail, setScEmail] = useState('');
  const [scPw1, setScPw1] = useState('');
  const [scPw2, setScPw2] = useState('');
  const [scDone, setScDone] = useState('');
  const [scTaken, setScTaken] = useState('');
  // feedback is a toast, not `window.alert` (task 3, 2026-10-10): a native modal blocks the
  // renderer until somebody dismisses it, and a page that still has one open when the client
  // wants to leave it cannot finish closing — measured as `page.close` taking 235 s in the e2e
  // run. The rest of the product already uses this pattern (Chat.tsx, Lesson.tsx).
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);
  const say = (text: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = window.setTimeout(() => setToast(''), 2_000);
  };
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const classesQ = useQuery({ queryKey: ['classes'], queryFn: () => api<ClassView[]>('/api/classes') });
  const cls = (classesQ.data ?? []).find((c) => c.id === id) ?? null;
  const [edit, setEdit] = useState<{ name: string; description: string; color: string } | null>(null);
  useEffect(() => {
    if (cls && !edit) setEdit({ name: cls.name, description: cls.description ?? '', color: cls.color });
  }, [cls]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveClass = useMutation({
    mutationFn: (p: { name: string; description: string; color: string }) =>
      api(`/api/classes/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['classes'] }); say(t('notes.saved')); },
  });
  const archiveClass = useMutation({
    mutationFn: () => api(`/api/classes/${id}/archive`, { method: 'POST' }),
    // the router moves, and the list cache is refreshed for it: `window.location.href` was a full
    // document reload started the same instant the client began to leave the page (see the toast
    // comment above for what that did to `page.close` in the e2e run)
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['classes'] }); nav('/classes'); },
  });
  // bot task §3 — public schedule switch
  const botSchedule = useMutation({
    mutationFn: (on: boolean) => api(`/api/classes/${id}`, { method: 'PATCH', body: JSON.stringify({ botPublicSchedule: on }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['classes'] }); },
  });
  // часть 4 — «показывать архив досок ученикам»: по умолчанию выключено, решает сервер на каждом
  // запросе архива, здесь только переключатель.
  const archivePublic = useMutation({
    mutationFn: (on: boolean) => api(`/api/classes/${id}`, { method: 'PATCH', body: JSON.stringify({ boardArchivePublic: on }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['classes'] }); },
  });

  // задача 2026-10-24 (часть B): история приглашений больше не живёт на экране класса — её
  // тянет отдельное окно (`InviteHistory`), и только когда учитель его открыл.
  const members = useQuery({
    queryKey: ['members', id],
    queryFn: () => api<MemberRow[]>(`/api/classes/${id}/members`),
    enabled: me?.role === 'teacher',
  });

  /* способ с кодом класса убран отсюда 2026-10-27 вместе с самим маршрутом: `POST
     /api/classes/:id/invites` теперь отвечает 410, и кнопки, которая бы на него ходила,
     на экране больше нет */
  const createLink = useMutation({
    mutationFn: () => api<{ id: string; url: string; expiresAt: string }>(`/api/classes/${id}/invites/link`, {
      method: 'POST', body: JSON.stringify({ label: linkLabel, ttlDays: linkTtl }),
    }),
    onSuccess: (r) => {
      setNewLink(r.url);
      void qc.invalidateQueries({ queryKey: ['invitations', id] });
    },
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api(`/api/classes/${id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members', id] }),
  });
  /**
   * Способ 1 (2026-10-27): создать аккаунт ученика и добавить его в класс.
   *
   * Успех — это один вызов, который обязан вернуть и аккаунт, и членство сразу: сервер делает
   * это одной транзакцией, поэтому экран не «создаёт, а потом добавляет» и не оставляет ученика
   * без класса на середине пути.
   *
   * Занятая почта (`emailTaken`, 409) — не ошибка формы, а другой сценарий, и экран обязан
   * повести себя по-честному: ничего не было создано и ничей пароль не изменён; показываем тот же
   * блок «найти и подтвердить», что и для существующего аккаунта, с уже набранным адресом.
   * Пароли при этом ОБЯЗАНЫ обнулиться: их некуда передавать, и оставлять введённый пароль в
   * полях под кнопкой «добавить существующего» было бы приглашением сбросить чужой пароль.
   * Серверный сброс пароля этот путь не вызывает и не может вызвать: он требует членства.
   */
  const createStudent = useMutation({
    mutationFn: (p: { firstName: string; lastName: string; email: string; password: string }) =>
      api<{ ok: true; userId: string; name: string; email: string; mustChangePassword: boolean }>(
        `/api/classes/${id}/students`, { method: 'POST', body: JSON.stringify(p) }),
    onSuccess: (r) => {
      setScFirst(''); setScLast(''); setScEmail(''); setScPw1(''); setScPw2('');
      setScTaken('');
      setScDone(t('classes.createDone', { name: r.name }));
      void qc.invalidateQueries({ queryKey: ['members', id] });
    },
    onError: (err) => {
      setScPw1(''); setScPw2('');
      const code = (err as { code?: string }).code;
      if (code !== 'emailTaken') { setScTaken(''); return; }
      const mail = scEmail.trim();
      setScTaken(t('classes.emailTakenNotice'));
      setAddNotice('');
      setAddMatch(null);
      if (mail) lookupStudent.mutate(mail);
    },
  });
  /**
   * Шаг 1 — поиск (2026-10-27, часть B): только чтение. Сервер отвечает личностью найденного
   * ученика и именем класса; ни строки в `class_members`, ни пароля этот запрос не касается.
   * `alreadyMember` означает, что подтверждать нечего — сброс пароля уже доступен в списке.
   */
  const lookupStudent = useMutation({
    mutationFn: (email: string) =>
      api<StudentMatch & { found: true }>(`/api/classes/${id}/members/lookup`, {
        method: 'POST', body: JSON.stringify({ email }),
      }),
    onSuccess: (r) => { setAddMatch(r); setAddNotice(''); },
  });
  /**
   * Шаг 2 — добавление по почте (2026-10-26, с подтверждением с 2026-10-27). Сервер отвечает
   * `alreadyMember`, а не ошибкой, если строка уже есть: для учителя это не авария, и повторный
   * клик не должен выглядеть как сломанная кнопка. После успеха список перезапрашивается — сразу
   * появляются сброс пароля и удаление.
   */
  const addExisting = useMutation({
    mutationFn: (email: string) =>
      api<{ ok: true; userId: string; name: string; alreadyMember: boolean }>(`/api/classes/${id}/members`, {
        method: 'POST', body: JSON.stringify({ email }),
      }),
    onSuccess: (r) => {
      setAddEmail('');
      setAddMatch(null);
      setAddNotice(r.alreadyMember
        ? t('classes.addExistingAlready', { name: r.name })
        : t('classes.addExistingDone', { name: r.name }));
      void qc.invalidateQueries({ queryKey: ['members', id] });
    },
  });
  /** прежний путь: сервер генерирует пароль и показывает его один раз */
  const resetPw = useMutation({
    mutationFn: (userId: string) => api<{ tempPassword: string }>(`/api/classes/${id}/members/${userId}/reset-password`, { method: 'POST' }),
    onSuccess: () => { setPwCopied(false); say(t('classes.pwSet')); },
  });
  /** новый путь: пароль набирает учитель; ответ сервера его не возвращает */
  const setPw = useMutation({
    mutationFn: ({ userId, password }: { userId: string; password: string }) =>
      api<{ ok: true }>(`/api/classes/${id}/members/${userId}/reset-password`, {
        method: 'POST', body: JSON.stringify({ password }),
      }),
    onSuccess: () => { setPwFor(null); setPwA1(''); setPwA2(''); say(t('classes.pwSet')); },
  });

  return (
    <div>
      <p><Link to="/classes">← {t('classes.title')}</Link></p>
      <div className="row" style={{ marginBottom: 8 }}>
        {cls && <span className="dot" style={{ background: cls.color, width: 14, height: 14 }} />}
        <h1 style={{ margin: 0 }} data-testid="class-title">{cls?.name ?? t('common.loading')}</h1>
        <div className="spacer" />
        {me?.role === 'teacher' && (
          <Link data-testid="class-new-note" to={`/notes?new=1&classId=${id}`}>
            <button className="ghost" style={{ marginTop: 0 }}>📝 {t('home.newNote')}</button>
          </Link>
        )}
      </div>
      {cls?.description && <p className="muted">{cls.description}</p>}
      {me?.role === 'teacher' && (
        <p><Link to={`/lesson?classId=${id}`}><button style={{ marginTop: 0 }} className="secondary">{t('lesson.title')}</button></Link></p>
      )}
      {/* часть 4: ученику архив виден ровно тогда, когда учитель включил переключатель класса;
          доступ всё равно проверяет сервер (выключенный архив и чужой класс отвечают 404) */}
      {me?.role === 'student' && Boolean(cls?.boardArchivePublic) && (
        <p>
          <Link to={`/classes/${id}/archive`} data-testid="student-archive-link">
            <button style={{ marginTop: 0 }} className="secondary">{t('archive.title')}</button>
          </Link>
        </p>
      )}
      <Feed classId={id} />
      {me?.role === 'teacher' && (
        <>
          {/* 2026-10-27: «Добавить ученика» — один экран с тремя понятными способами, и кнопка
              «создать код» с него убрана совсем. Учитель больше не читает восемь символов вслух:
              если данные уже есть в голове, аккаунт заводится здесь же; если аккаунт уже есть —
              он находится по почте и добавляется после явного подтверждения; ссылка остаётся
              способом для того, кто должен зарегистрироваться сам. */}
          <div className="card" data-testid="add-student">
            <h2>{t('classes.addStudent')}</h2>
            <p className="muted" style={{ fontSize: '.88rem' }}>{t('classes.addStudentHint')}</p>

            {/* способ 1 — аккаунт создаёт учитель: имя, фамилия, почта и временный пароль */}
            <div className="student-create" data-testid="student-create">
              <h3>{t('classes.addCreateTitle')}</h3>
              <p className="muted" style={{ fontSize: '.88rem' }}>{t('classes.createHint')}</p>
              <form data-testid="student-create-form" onSubmit={(e) => {
                e.preventDefault();
                const first = scFirst.trim();
                const last = scLast.trim();
                const mail = scEmail.trim();
                if (!first || !last || !mail) return;
                if (scPw1 !== scPw2) return;
                if (!passwordPolicy.safeParse(scPw1).success) return;
                setScDone('');
                setScTaken('');
                createStudent.mutate({ firstName: first, lastName: last, email: mail, password: scPw1 });
              }}>
                <div className="row invite-row">
                  <div className="field">
                    <label htmlFor="sc-first">{t('auth.firstName')}</label>
                    <input id="sc-first" data-testid="sc-first" value={scFirst} maxLength={80} required
                      onChange={(e) => { setScFirst(e.target.value); setScTaken(''); }} autoComplete="off" />
                  </div>
                  <div className="field">
                    <label htmlFor="sc-last">{t('auth.lastName')}</label>
                    <input id="sc-last" data-testid="sc-last" value={scLast} maxLength={80} required
                      onChange={(e) => { setScLast(e.target.value); setScTaken(''); }} autoComplete="off" />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="sc-email">{t('common.email')}</label>
                  <input id="sc-email" data-testid="sc-email" type="email" value={scEmail} required
                    onChange={(e) => { setScEmail(e.target.value); setScTaken(''); }}
                    autoComplete="off" spellCheck={false} />
                </div>
                <div className="row invite-row">
                  <div className="field">
                    <label htmlFor="sc-password">{t('classes.tempPassword')}</label>
                    <input id="sc-password" data-testid="sc-password" type="password" value={scPw1} required
                      minLength={10} autoComplete="new-password" onChange={(e) => setScPw1(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="sc-password2">{t('classes.tempPasswordConfirm')}</label>
                    <input id="sc-password2" data-testid="sc-password2" type="password" value={scPw2} required
                      autoComplete="new-password" onChange={(e) => setScPw2(e.target.value)} />
                  </div>
                </div>
                <p className="muted" style={{ fontSize: '.82rem' }}>{t('classes.pwHint')}</p>
                {scPw1 !== '' && scPw2 !== '' && scPw1 !== scPw2 && (
                  <p className="error" role="alert" data-testid="sc-mismatch">{t('classes.pwMismatch')}</p>
                )}
                <button type="submit" data-testid="sc-submit"
                  disabled={createStudent.isPending || !scFirst.trim() || !scLast.trim() || !scEmail.trim()}>
                  {t('classes.createSubmit')}
                </button>
              </form>
              {/* Занятая почта выведена из общего вывода ошибок намеренно: `auth.emailTaken`
                  написан для ученика («войдите этой почтой — попадёте в класс»), а здесь перед
                  нами экран учителя, и у этого отказа уже есть своя строка (`sc-taken`) плюс
                  найденный аккаунт ниже. Две фразы об одном отказе человек прочитал бы как две
                  разные проблемы. Остальные отказы идут обычным переводимым текстом. */}
              {createStudent.error && (createStudent.error as { code?: string }).code !== 'emailTaken' && (
                <AuthError code={(createStudent.error as { code?: string }).code ?? 'errorGeneric'} />
              )}
              {scTaken && <p className="error" role="status" data-testid="sc-taken">{scTaken}</p>}
              {scDone && <p className="ok" role="status" data-testid="sc-done">{scDone}</p>}
            </div>

            {/* способ 2 — существующий аккаунт: найти, посмотреть, подтвердить. Пароль не
                трогается, пока учитель сам не нажмёт сброс в появившейся строке списка. */}
            <div className="add-existing" data-testid="add-existing">
              <h3>{t('classes.addExistingTitle')}</h3>
              <p className="muted" style={{ fontSize: '.88rem' }}>{t('classes.addExistingHint')}</p>
              <form className="row invite-row" data-testid="add-existing-form" onSubmit={(e) => {
                e.preventDefault();
                const v = addEmail.trim();
                if (!v) return;
                setAddNotice('');
                setAddMatch(null);
                lookupStudent.reset();
                addExisting.reset();
                lookupStudent.mutate(v);
              }}>
                <div className="field">
                  <label htmlFor="add-existing-email">{t('classes.addExistingEmail')}</label>
                  <input id="add-existing-email" data-testid="add-existing-email" type="email" value={addEmail}
                    onChange={(e) => { setAddEmail(e.target.value); setAddNotice(''); setAddMatch(null); }} required
                    autoComplete="off" spellCheck={false} />
                </div>
                <button type="submit" className="secondary" data-testid="add-existing-submit"
                  disabled={lookupStudent.isPending || addExisting.isPending || !addEmail.trim()}>
                  {t('classes.addExistingFind')}
                </button>
              </form>
              {lookupStudent.error && !addMatch && (
                <AuthError code={(lookupStudent.error as { code?: string }).code ?? 'errorGeneric'} />
              )}

              {/* Шаг 2 — явное подтверждение. Показаны все три факта, которые учитель обязан
                  сверить: имя, почта найденного аккаунта и класс, в который он попадёт.
                  Кнопка «Отмена» возвращает к поиску и ничего не создаёт. */}
              {addMatch && (
                <div className="card add-existing-match" data-testid="add-existing-match"
                  aria-labelledby="add-existing-match-title">
                  <h4 id="add-existing-match-title" style={{ marginTop: 0 }}>
                    {t('classes.addExistingMatchTitle')}
                  </h4>
                  <p style={{ margin: '2px 0' }}>
                    <span className="muted">{t('classes.addExistingMatchName')}: </span>
                    <strong data-testid="add-existing-match-name">{addMatch.name}</strong>
                  </p>
                  <p style={{ margin: '2px 0' }}>
                    <span className="muted">{t('classes.addExistingMatchEmail')}: </span>
                    <span data-testid="add-existing-match-email">{addMatch.email}</span>
                  </p>
                  <p style={{ margin: '2px 0' }}>
                    <span className="muted">{t('classes.addExistingMatchClass')}: </span>
                    <span data-testid="add-existing-match-class">{addMatch.className}</span>
                  </p>
                  <p className="muted" style={{ fontSize: '.85rem' }} data-testid="add-existing-match-explain">
                    {addMatch.alreadyMember
                      ? t('classes.addExistingMatchAlready', { name: addMatch.name })
                      : t('classes.addExistingMatchExplain')}
                  </p>
                  <div className="row">
                    {!addMatch.alreadyMember && (
                      <button className="secondary" style={{ marginTop: 0 }} data-testid="add-existing-confirm"
                        disabled={addExisting.isPending || lookupStudent.isPending}
                        onClick={() => { setAddNotice(''); addExisting.mutate(addMatch.email); }}>
                        {t('classes.addExistingSubmit')}
                      </button>
                    )}
                    <button className="ghost" style={{ marginTop: 0 }} data-testid="add-existing-cancel"
                      disabled={addExisting.isPending} onClick={() => setAddMatch(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                  {!addMatch.alreadyMember && (
                    <p className="muted" style={{ fontSize: '.82rem' }}>{t('classes.addExistingMatchWrong')}</p>
                  )}
                  {addExisting.error && (
                    <AuthError code={(addExisting.error as { code?: string }).code ?? 'errorGeneric'} />
                  )}
                </div>
              )}
              {addNotice && <p className="ok" role="status" data-testid="add-existing-done">{addNotice}</p>}
            </div>

            {/* способ 3 — одноразовая ссылка: для ученика, который регистрируется сам.
                Показывается ОДИН раз: сервер хранит только её хеш, поэтому «вспомнить» её
                невозможно, и это надо сказать прямо, а не оставить пустую кнопку. */}
            <div className="invite-link-section" data-testid="invite-link-section">
              <h3>{t('classes.addLinkTitle')}</h3>
              <div className="row invite-row">
                <div className="field">
                  <label htmlFor="invite-label">{t('classes.invite.linkLabel')}</label>
                  <input id="invite-label" data-testid="invite-link-label" value={linkLabel} maxLength={INVITE_LABEL_MAX}
                    onChange={(e) => setLinkLabel(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="invite-ttl">{t('classes.invite.linkTtl')}</label>
                  <select id="invite-ttl" data-testid="invite-link-ttl" value={linkTtl} style={{ marginTop: 0 }}
                    onChange={(e) => setLinkTtl(Number(e.target.value))}>
                    {INVITE_LINK_TTL_DAYS.map((d) => <option key={d} value={d}>{t(`classes.invite.ttl${d}`)}</option>)}
                  </select>
                </div>
                <button data-testid="create-invite-link" onClick={() => { setLinkCopied(false); createLink.mutate(); }}
                  disabled={createLink.isPending}>
                  {t('classes.invite.createLink')}
                </button>
              </div>

              {newLink && (
                <div className="invite-reveal" data-testid="invite-link-box">
                  <p className="invite-warn" role="status" data-testid="invite-link-warn">{t('classes.invite.warn')}</p>
                  <div className="invite-url" dir="ltr">{newLink}</div>
                  <div className="row invite-actions">
                    <button type="button" data-testid="invite-link-copy" onClick={() => {
                      void navigator.clipboard?.writeText(newLink).then(() => setLinkCopied(true)).catch(() => undefined);
                    }}>
                      {linkCopied ? t('classes.invite.copied') : t('classes.invite.copy')}
                    </button>
                    {/* обычная ссылка share-URL Telegram: без бота, без токена и без отправки —
                        мессенджер открывается у самого учителя, и сообщение остаётся его */}
                    <a className="secondary invite-tg" data-testid="invite-link-telegram"
                      href={`https://t.me/share/url?url=${encodeURIComponent(newLink)}`}
                      target="_blank" rel="noopener noreferrer">{t('classes.invite.sendTg')}</a>
                    <button type="button" className="ghost" data-testid="invite-link-done" style={{ marginTop: 0 }}
                      onClick={() => { setNewLink(null); setLinkLabel(''); }}>
                      {t('classes.invite.done')}
                    </button>
                  </div>
                  <p className="muted" style={{ fontSize: '.82rem' }}>{t('classes.invite.linkOnce')}</p>
                </div>
              )}
            </div>

            {/* задача 2026-10-24 (часть B): вместо таблицы истории на экране класса — одна
                компактная кнопка. Записи никуда не деваются и не удаляются: меняется только то,
                где они показываются. Кнопка всегда на месте, чтобы узкий экран не оставлял
                учителя без доступа к истории. */}
            <div className="row invite-history-row">
              <button type="button" className="secondary" data-testid="invite-history-open"
                aria-haspopup="dialog" aria-expanded={historyOpen}
                onClick={() => setHistoryOpen(true)}>
                {t('classes.inviteHistory')}
              </button>
              <span className="muted invite-history-hint" data-testid="invite-history-hint">
                {t('classes.inviteHistoryHint')}
              </span>
            </div>
          </div>

          <InviteHistory classId={id} open={historyOpen} onClose={() => setHistoryOpen(false)} />

          <div className="card" data-testid="class-members">
            <h2>{t('classes.members')}</h2>
            {(members.data ?? []).length === 0 && <p className="muted">{t('classes.noMembers')}</p>}
            <table>
              <tbody>
                {(members.data ?? []).map((m) => (
                  <tr key={m.userId}>
                    <td>{m.name}</td>
                    <td className="muted">{m.email}</td>
                    <td className="muted">{fmtDate(m.joinedAt, i18n.language)}</td>
                    <td>
                      {/* Задача 2026-10-23, часть C. Кнопка как раньше — сервер генерирует пароль
                          и показывает его один раз: это тот путь, который учителю нужен, когда
                          ученик стоит рядом. Рядом — форма «ввести пароль самому» (ученик
                          distant, пароль диктуется по телефону). Оба пути поднимают
                          must_change_password и снимают локаут: без последнего сброс
                          «не работал» ровно для того, ради кого его делают. */}
                      <button className="secondary" style={{ marginTop: 0, marginRight: 6 }}
                        data-testid="member-reset-pw"
                        onClick={() => resetPw.mutate(m.userId)} disabled={resetPw.isPending || setPw.isPending}>
                        {t('classes.resetPw')}
                      </button>
                      <button className="ghost" style={{ marginTop: 0, marginRight: 6 }} data-testid={`member-reset-pw-custom-${m.userId}`}
                        onClick={() => {
                          setPwFor(pwFor === m.userId ? null : m.userId);
                          setPwA1(''); setPwA2('');
                        }}
                        disabled={setPw.isPending}>
                        {t('classes.pwByTeacher')}
                      </button>
                      <button className="danger" style={{ marginTop: 0 }} onClick={() => { if (window.confirm(t('classes.removeMemberConfirm'))) removeMember.mutate(m.userId); }}>
                        {t('classes.removeMember')}
                      </button>
                      {resetPw.data && resetPw.variables === m.userId && !resetPw.isPending && (
                        <div className="invite-reveal" data-testid="member-temp-pw-box">
                          {/* временный пароль существует ровно один раз: сервер его не хранит и
                              повторно не покажет — копия должна уйти ученику отсюда, а не из
                              переписки с самим собой (2026-10-28) */}
                          <p className="invite-warn" role="status" data-testid="member-temp-pw-hint">
                            {t('classes.pwTempWarn')}
                          </p>
                          <div className="invite-url" dir="ltr">
                            <code data-testid="member-temp-pw">{resetPw.data.tempPassword}</code>
                          </div>
                          <div className="row invite-actions">
                            <button type="button" data-testid="member-temp-pw-copy" onClick={() => {
                              void navigator.clipboard?.writeText(resetPw.data!.tempPassword)
                                .then(() => setPwCopied(true)).catch(() => undefined);
                            }}>
                              {pwCopied ? t('classes.pwCopied') : t('classes.pwCopy')}
                            </button>
                            <button type="button" className="ghost" style={{ marginTop: 0 }}
                              data-testid="member-temp-pw-done"
                              onClick={() => { resetPw.reset(); setPwCopied(false); }}>
                              {t('classes.pwDone')}
                            </button>
                          </div>
                        </div>
                      )}
                      {resetPw.error && resetPw.variables === m.userId && (
                        <span className="error" data-testid="member-reset-pw-error" style={{ marginLeft: 8 }}>
                          {/* код сервера переводится как остальные ошибки входа; неизвестный
                              код не показывает сырой ключ и не превращается в пустоту */}
                          {t(`auth.${(resetPw.error as { code?: string }).code ?? 'errorGeneric'}`,
                            { defaultValue: t('common.errorGeneric') })}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {pwFor && (
              <form className="card pw-form" data-testid="pw-form" onSubmit={(e) => {
                e.preventDefault();
                if (pwA1 !== pwA2) return;
                if (!passwordPolicy.safeParse(pwA1).success) return;
                setPw.mutate({ userId: pwFor, password: pwA1 });
              }}>
                <h3>{t('classes.pwNew')}</h3>
                <label htmlFor="pw-a1">{t('classes.pwNew')}</label>
                <input id="pw-a1" data-testid="pw-input" type="password" value={pwA1} autoComplete="new-password"
                  onChange={(e) => setPwA1(e.target.value)} minLength={10} />
                <label htmlFor="pw-a2">{t('classes.pwConfirm')}</label>
                <input id="pw-a2" data-testid="pw-confirm" type="password" value={pwA2} autoComplete="new-password"
                  onChange={(e) => setPwA2(e.target.value)} />
                <p className="muted" style={{ fontSize: '.82rem' }}>{t('classes.pwHint')}</p>
                {pwA1 !== '' && pwA2 !== '' && pwA1 !== pwA2 && (
                  <p className="error" role="alert" data-testid="pw-mismatch">{t('classes.pwMismatch')}</p>
                )}
                {setPw.error && (
                  <p className="error" role="alert" data-testid="pw-error">
                    {t(`auth.${(setPw.error as { code?: string }).code ?? 'errorGeneric'}`,
                      { defaultValue: t('common.errorGeneric') })}
                  </p>
                )}
                <div className="row">
                  <button type="submit" data-testid="pw-save"
                    disabled={setPw.isPending || pwA1 !== pwA2 || !passwordPolicy.safeParse(pwA1).success}>
                    {t('common.save')}
                  </button>
                  <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="pw-cancel"
                    onClick={() => { setPwFor(null); setPwA1(''); setPwA2(''); }}>
                    {t('classes.pwCancel')}
                  </button>
                </div>
              </form>
            )}
          </div>
          <div className="card">
            <h2>{t('tg.group')}</h2>
            <TelegramClassSettings classId={id} />
          </div>
          {/* item 8 — chat state + mute management (teacher) */}
          <div className="card" data-testid="chat-settings">
            <h2>{t('chat.settingsTitle')}</h2>
            <ChatSettings classId={id} initialMode={cls?.chatMode ?? 'on'} />
          </div>
          {/* bot task §3 — public schedule switch for the Telegram bot */}
          <div className="card" data-testid="bot-schedule">
            <h2>{t('classes.botScheduleTitle')}</h2>
            <label className="row" style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                data-testid="bot-schedule-on"
                checked={Boolean(cls?.botPublicSchedule)}
                onChange={(e) => botSchedule.mutate(e.target.checked)}
                disabled={botSchedule.isPending}
              />
              <span>{cls?.botPublicSchedule ? t('classes.botScheduleOn') : t('classes.botScheduleOff')}</span>
            </label>
            <p className="muted" style={{ fontSize: '.85rem' }}>{t('classes.botScheduleHint')}</p>
          </div>
          {/* часть 4 — архив уроков класса: переключатель доступа учеников и вход в сам архив */}
          <div className="card" data-testid="class-archive">
            <h2>{t('archive.title')}</h2>
            <label className="row" style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" data-testid="archive-public-on"
                checked={Boolean(cls?.boardArchivePublic)}
                onChange={(e) => archivePublic.mutate(e.target.checked)}
                disabled={archivePublic.isPending} />
              <span>{t('classes.archiveSwitch')}</span>
            </label>
            <p className="muted" style={{ fontSize: '.85rem' }}>
              {cls?.boardArchivePublic ? t('classes.archiveSwitchOn') : t('classes.archiveSwitchOff')}
            </p>
            <p style={{ marginBottom: 0 }}>
              <Link to={`/classes/${id}/archive`} data-testid="class-archive-open">
                <button type="button" className="secondary" style={{ marginTop: 0 }}>{t('archive.open')}</button>
              </Link>
            </p>
          </div>
          {/* C.2 — class settings: rename / description / color / archive */}
          {cls && edit && (
            <div className="card" data-testid="class-settings">
              <h2>{t('classes.settings')}</h2>
              <label>{t('classes.className')}</label>
              <input data-testid="cls-name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              <label>{t('classes.description')}</label>
              <textarea data-testid="cls-desc" rows={2} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
              <div className="row" style={{ marginTop: 8 }}>
                <label style={{ margin: 0 }}>{t('classes.color')}</label>
                <input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} />
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button data-testid="cls-save" style={{ marginTop: 0 }} disabled={saveClass.isPending || !edit.name.trim()}
                  onClick={() => saveClass.mutate(edit)}>{t('common.save')}</button>
                <div className="spacer" />
                <button className="danger" style={{ marginTop: 0 }} data-testid="cls-archive" disabled={archiveClass.isPending}
                  onClick={() => { if (window.confirm(`${t('classes.archive')}: ${cls.name}?`)) archiveClass.mutate(); }}>
                  {t('classes.archive')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {toast && <div className="toast" role="status" data-testid="class-toast">{toast}</div>}
    </div>
  );
}

/** item 8 — chat mode + mute management (teacher). */
function ChatSettings({ classId, initialMode }: { classId: string; initialMode: 'on' | 'off' | 'announce' }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState(initialMode);
  useEffect(() => setMode(initialMode), [initialMode]);
  const mutes = useQuery({
    queryKey: ['chat-mutes', classId],
    queryFn: () => api<{ mutes: { userId: string; name: string; until: string | null }[] }>(`/api/classes/${classId}/chat/mutes`),
  });
  const setModeM = useMutation({
    mutationFn: (m: string) => api(`/api/classes/${classId}/chat/mode`, { method: 'PUT', body: JSON.stringify({ mode: m }) }),
    onSuccess: (_r, m) => { setMode(m as 'on' | 'off' | 'announce'); void qc.invalidateQueries({ queryKey: ['classes'] }); void qc.invalidateQueries({ queryKey: ['chat-summary'] }); },
  });
  const unmute = useMutation({
    mutationFn: (userId: string) => api(`/api/classes/${classId}/chat/mutes/${userId}`, { method: 'DELETE' }),
    onSuccess: () => void mutes.refetch(),
  });
  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}>
        <span className="muted">{t('chat.mode.label')}</span>
        <select style={{ width: 'auto', marginTop: 0 }} data-testid="chat-mode" value={mode}
          onChange={(e) => setModeM.mutate(e.target.value)} disabled={setModeM.isPending}>
          <option value="on">{t('chat.mode.on')}</option>
          <option value="off">{t('chat.mode.off')}</option>
          <option value="announce">{t('chat.mode.announce')}</option>
        </select>
      </div>
      {(mutes.data?.mutes ?? []).length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong style={{ fontSize: '.85rem' }}>{t('chat.mutedTitle')}</strong>
          {(mutes.data?.mutes ?? []).map((m) => (
            <div key={m.userId} className="row" style={{ alignItems: 'center', marginTop: 4 }}>
              <span>{m.name}</span>
              <span className="muted">{m.until ? new Date(m.until).toLocaleString() : t('chat.muteForever')}</span>
              <div className="spacer" />
              <button className="secondary" style={{ marginTop: 0 }} onClick={() => unmute.mutate(m.userId)}>{t('chat.unmute')}</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function TelegramClassSettings({ classId }: { classId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ['tgclass', classId],
    queryFn: () => api<{ chats: string[]; channel: 'private' | 'group' | 'both' }>(`/api/classes/${classId}/telegram`),
  });
  const code = useMutation({
    mutationFn: () => api<{ code: string }>(`/api/classes/${classId}/link-token`, { method: 'POST' }),
  });
  const setChannel = useMutation({
    mutationFn: (ch: string) => api(`/api/classes/${classId}/notify-channel`, { method: 'PUT', body: JSON.stringify({ channel: ch }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tgclass'] }),
  });
  return (
    <>
      <div className="row">
        <span className="muted">{t('tg.channel')}</span>
        <select style={{ width: 'auto', marginTop: 0 }} value={info.data?.channel ?? 'private'} onChange={(e) => setChannel.mutate(e.target.value)}>
          <option value="private">{t('tg.channelPrivate')}</option>
          <option value="group">{t('tg.channelGroup')}</option>
          <option value="both">{t('tg.channelBoth')}</option>
        </select>
        <div className="spacer" />
        <button className="secondary" style={{ marginTop: 0 }} onClick={() => code.mutate()}>{t('tg.makeCode')}</button>
      </div>
      {code.data && <p className="code-box" style={{ fontSize: '1.2rem' }}>{code.data.code}</p>}
      <p className="muted">{t('tg.howto')}</p>
      {(info.data?.chats ?? []).map((c) => (
        <span key={c} className="badge" style={{ marginRight: 6 }}>chat {c}</span>
      ))}
      {(info.data?.chats ?? []).length === 0 && <span className="muted">{t('tg.noGroup')}</span>}
    </>
  );
}
