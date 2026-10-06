import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useAuth } from '../App';
import Feed from '../components/Feed';

interface InviteRow {
  id: string; status: 'active' | 'used' | 'expired' | 'revoked';
  expiresAt: string; usedAt: string | null; usedByName: string | null; createdAt: string;
}
interface MemberRow { userId: string; name: string; email: string; joinedAt: string }
interface ClassView { id: string; name: string; description: string; color: string; archived: boolean; chatMode?: 'on' | 'off' | 'announce'; botPublicSchedule?: boolean }

export default function ClassDetail() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [newCode, setNewCode] = useState<string | null>(null);
  const [ttlDays, setTtlDays] = useState(7);

  const classesQ = useQuery({ queryKey: ['classes'], queryFn: () => api<ClassView[]>('/api/classes') });
  const cls = (classesQ.data ?? []).find((c) => c.id === id) ?? null;
  const [edit, setEdit] = useState<{ name: string; description: string; color: string } | null>(null);
  useEffect(() => {
    if (cls && !edit) setEdit({ name: cls.name, description: cls.description ?? '', color: cls.color });
  }, [cls]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveClass = useMutation({
    mutationFn: (p: { name: string; description: string; color: string }) =>
      api(`/api/classes/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['classes'] }); window.alert(t('notes.saved')); },
  });
  const archiveClass = useMutation({
    mutationFn: () => api(`/api/classes/${id}/archive`, { method: 'POST' }),
    onSuccess: () => { window.location.href = '/classes'; },
  });
  // bot task §3 — public schedule switch
  const botSchedule = useMutation({
    mutationFn: (on: boolean) => api(`/api/classes/${id}`, { method: 'PATCH', body: JSON.stringify({ botPublicSchedule: on }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['classes'] }); },
  });

  const invites = useQuery({
    queryKey: ['invites', id],
    queryFn: () => api<InviteRow[]>(`/api/classes/${id}/invites`),
    enabled: me?.role === 'teacher',
  });
  const members = useQuery({
    queryKey: ['members', id],
    queryFn: () => api<MemberRow[]>(`/api/classes/${id}/members`),
    enabled: me?.role === 'teacher',
  });

  const createInvite = useMutation({
    mutationFn: () => api<{ code: string }>(`/api/classes/${id}/invites`, {
      method: 'POST', body: JSON.stringify({ ttlDays }),
    }),
    onSuccess: (r) => { setNewCode(r.code); void qc.invalidateQueries({ queryKey: ['invites', id] }); },
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) => api(`/api/classes/${id}/invites/${inviteId}/revoke`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites', id] }),
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api(`/api/classes/${id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members', id] }),
  });
  const resetPw = useMutation({
    mutationFn: (userId: string) => api<{ tempPassword: string }>(`/api/classes/${id}/members/${userId}/reset-password`, { method: 'POST' }),
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
        <p><a href={`/lesson?classId=${id}`}><button style={{ marginTop: 0 }} className="secondary">{t('lesson.title')}</button></a></p>
      )}
      <Feed classId={id} />
      {me?.role === 'teacher' && (
        <>
          <div className="card">
            <h2>{t('classes.invite.title')}</h2>
            <div className="row">
              <label style={{ margin: 0 }}>{t('classes.invite.ttlDays')}</label>
              <input type="number" min={1} max={30} value={ttlDays} style={{ width: 80 }}
                onChange={(e) => setTtlDays(Number(e.target.value))} />
              <button data-testid="create-invite" style={{ marginTop: 0 }} onClick={() => createInvite.mutate()} disabled={createInvite.isPending}>
                {t('classes.invite.create')}
              </button>
            </div>
            {newCode && (
              <div style={{ marginTop: 12 }}>
                <div data-testid="invite-code" className="code-box">{newCode}</div>
                <p className="muted">{t('classes.invite.showOnce')}</p>
              </div>
            )}
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>{t('classes.invite.title')}</th><th>{t('classes.invite.created')}</th>
                  <th>{t('classes.invite.expires')}</th>
                  <th>{t('classes.invite.usedBy')}</th><th />
                </tr>
              </thead>
              <tbody>
                {(invites.data ?? []).map((i) => (
                  <tr key={i.id}>
                    <td><span className={`badge ${i.status}`}>{t(`classes.invite.${i.status}`)}</span></td>
                    {/* item 7: journal rows must show WHEN the action happened — the
                        old table only printed expiresAt (today+7d), which read like a
                        wrong date (04.10 → «11.10»). Locale comes from the app. */}
                    <td data-testid="invite-created">{fmtDate(i.createdAt, i18n.language)}</td>
                    <td>{fmtDateTime(i.expiresAt, i18n.language)}</td>
                    <td>{i.usedByName ?? '—'}{i.usedAt ? ` · ${fmtDateTime(i.usedAt, i18n.language)}` : ''}</td>
                    <td>
                      {i.status === 'active' && (
                        <button className="danger" style={{ marginTop: 0 }} onClick={() => revoke.mutate(i.id)}>
                          {t('classes.invite.revoke')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
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
                      <button className="secondary" style={{ marginTop: 0, marginRight: 6 }}
                        data-testid="member-reset-pw"
                        onClick={() => resetPw.mutate(m.userId)} disabled={resetPw.isPending}>
                        {t('classes.resetPw')}
                      </button>
                      <button className="danger" style={{ marginTop: 0 }} onClick={() => { if (window.confirm(t('classes.removeMemberConfirm'))) removeMember.mutate(m.userId); }}>
                        {t('classes.removeMember')}
                      </button>
                      {resetPw.data && resetPw.variables === m.userId && (
                        <span className="ok" data-testid="member-temp-pw" style={{ marginLeft: 8 }}>{resetPw.data.tempPassword}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
