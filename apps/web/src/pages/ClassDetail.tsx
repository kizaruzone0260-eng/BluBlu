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

interface MemberRow { userId: string; name: string; email: string; joinedAt: string }
interface ClassView { id: string; name: string; description: string; color: string; archived: boolean; chatMode?: 'on' | 'off' | 'announce'; botPublicSchedule?: boolean; boardArchivePublic?: boolean }

export default function ClassDetail() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [newCode, setNewCode] = useState<string | null>(null);
  const [ttlDays, setTtlDays] = useState(7);
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

  const createInvite = useMutation({
    mutationFn: () => api<{ code: string }>(`/api/classes/${id}/invites`, {
      method: 'POST', body: JSON.stringify({ ttlDays }),
    }),
    onSuccess: (r) => { setNewCode(r.code); void qc.invalidateQueries({ queryKey: ['invitations', id] }); },
  });
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
  /** прежний путь: сервер генерирует пароль и показывает его один раз */
  const resetPw = useMutation({
    mutationFn: (userId: string) => api<{ tempPassword: string }>(`/api/classes/${id}/members/${userId}/reset-password`, { method: 'POST' }),
    onSuccess: () => say(t('classes.pwSet')),
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
          {/* задача 2026-10-23, часть A: «Добавить ученика». Ссылка — основной способ, код —
              запасной. Ссылка показывается ОДИН раз: сервер хранит только её хеш, поэтому
              «вспомнить» её невозможно, и это надо сказать прямо, а не оставить пустую кнопку. */}
          <div className="card" data-testid="add-student">
            <h2>{t('classes.addStudent')}</h2>
            <p className="muted" style={{ fontSize: '.88rem' }}>{t('classes.addStudentHint')}</p>

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

            {/* Запасной способ тоже виден всегда: «спряхать под details» означало бы, что
                учителю нужен клик, чтобы найти то, чем он пользовался месяцами, а старый
                тест (flow/zz8) жмет кнопку сразу. */}
            <div className="invite-code-fallback" data-testid="invite-code-fallback">
              <h3>{t('classes.invite.create')}</h3>
              <div className="row invite-row">
                <label style={{ margin: 0 }}>{t('classes.invite.ttlDays')}</label>
                <input type="number" min={1} max={30} value={ttlDays} style={{ width: 80 }}
                  onChange={(e) => setTtlDays(Number(e.target.value))} />
                <button className="secondary" data-testid="create-invite" style={{ marginTop: 0 }}
                  onClick={() => createInvite.mutate()} disabled={createInvite.isPending}>
                  {t('classes.invite.create')}
                </button>
              </div>
              {newCode && (
                <div style={{ marginTop: 12 }}>
                  <div data-testid="invite-code" className="code-box">{newCode}</div>
                  <p className="muted">{t('classes.invite.showOnce')}</p>
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
                        <span className="ok" data-testid="member-temp-pw" style={{ marginLeft: 8 }}>{resetPw.data.tempPassword}</span>
                      )}
                      {resetPw.error && resetPw.variables === m.userId && (
                        <span className="error" data-testid="member-reset-pw-error" style={{ marginLeft: 8 }}>
                          {t('common.errorGeneric')}
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
