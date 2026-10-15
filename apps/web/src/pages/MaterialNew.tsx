import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { classifyAttachmentUrl, safeExternalUrl, type AttachmentKind } from '../lib/attachments';
import RichText from '../components/RichText';
import { useAuth } from '../App';
import { usePopover } from '../lib/popover';
import type { EditorHandle } from '../lib/controlledEditor';

/**
 * Material task A — «Создать материал» as a separate page (fullscreen on
 * mobile). Left: title + rich description + attachments; right: for whom
 * (multi-class), assign-to (all/selected students), topic (pick/create/
 * rename/delete) and the publish dropdown (now / schedule / draft).
 * One POST per selected class — each class gets its own post + audience.
 */

interface ClassView { id: string; name: string; archived: boolean }
interface MemberRow { userId: string; name: string; email: string }
interface TopicRow { id: string; name: string; position: number }
interface LinkDraft { url: string; title: string; kind: Exclude<AttachmentKind, 'file'> }

const FILE_ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tiff,.mp3,.m4a,.mp4';

export default function MaterialNew() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { me } = useAuth();
  const nav = useNavigate();

  const [title, setTitle] = useState('');
  const [titleErr, setTitleErr] = useState('');
  const [body, setBody] = useState('');
  const [pickedClasses, setPickedClasses] = useState<Set<string>>(new Set(id ? [id] : []));
  const [audienceMode, setAudienceMode] = useState<'all' | 'selected'>('all');
  const [pickedStudents, setPickedStudents] = useState<Set<string>>(new Set());
  const [topicId, setTopicId] = useState<string>('');
  const [newTopicName, setNewTopicName] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [linkInput, setLinkInput] = useState<'none' | 'link' | 'youtube' | 'drive'>('none');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [publish, setPublish] = useState<'now' | 'schedule' | 'draft'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [pubAnchor, setPubAnchor] = useState<HTMLElement | null>(null);
  const pubPop = usePopover({ open: menuOpen, anchor: pubAnchor, align: 'end', onClose: () => setMenuOpen(false) });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const rtRef = useRef<EditorHandle | null>(null);

  const classesQ = useQuery({ queryKey: ['classes'], queryFn: () => api<ClassView[]>('/api/classes') });
  const classes = useMemo(() => (classesQ.data ?? []).filter((c) => !c.archived), [classesQ.data]);
  const primary = [...pickedClasses][0] ?? id;

  // members per picked class (audience list)
  const membersQ = useQuery({
    queryKey: ['material-members', [...pickedClasses].join(',')],
    enabled: audienceMode === 'selected' && pickedClasses.size > 0,
    queryFn: async () => {
      const rows = await Promise.all([...pickedClasses].map(async (cid) => ({
        cid, list: await api<MemberRow[]>(`/api/classes/${cid}/members`),
      })));
      return rows;
    },
  });
  const topicsQ = useQuery({
    queryKey: ['topics', primary],
    queryFn: () => api<TopicRow[]>(`/api/classes/${primary}/topics`),
    enabled: Boolean(primary),
  });
  const topics = topicsQ.data ?? [];

  const create = useMutation({
    mutationFn: async (vars: { publish: 'now' | 'schedule' | 'draft'; scheduledAt: string | null }) => {
      // последние символы могли ещё не уйти в состояние (дебаунс редактора) — забираем их сейчас
      const description = rtRef.current?.flush() || body;
      for (const cid of pickedClasses) {
        const form = new FormData();
        form.set('title', title.trim());
        form.set('description', description);
        form.set('publish', vars.publish);
        if (vars.scheduledAt) form.set('scheduledAt', vars.scheduledAt);
        // audience for THIS class only (ids that are its members)
        if (vars.publish !== 'draft' && audienceMode === 'selected') {
          const members = (membersQ.data ?? []).find((m) => m.cid === cid)?.list ?? [];
          const ids = members.filter((m) => pickedStudents.has(m.userId)).map((m) => m.userId);
          form.set('audience', JSON.stringify(ids));
        }
        // one class → existing topic id; many classes → create-by-name per class
        if (newTopicName) form.set('newTopic', newTopicName);
        else if (topicId && pickedClasses.size === 1) form.set('topicId', topicId);
        form.set('attachments', JSON.stringify(links.map((l) => ({ url: l.url, title: l.title }))));
        for (const f of files) form.append('file', f);
        await api(`/api/classes/${cid}/materials`, { method: 'POST', body: form });
      }
    },
  });

  if (me?.role !== 'teacher') return <p className="error">{t('common.errorGeneric')}</p>;

  function submit(mode: 'now' | 'schedule' | 'draft') {
    setErr('');
    if (!title.trim()) { setTitleErr(t('material.titleRequired')); return; }
    setTitleErr('');
    if (!pickedClasses.size) { setErr(t('material.pickClassErr')); return; }
    if (mode === 'schedule') {
      if (!scheduledAt) { setErr(t('material.pickTimeErr')); return; }
      const when = new Date(scheduledAt);
      if (Number.isNaN(+when) || when.getTime() <= Date.now()) { setErr(t('material.futureErr')); return; }
    }
    setBusy(true);
    create.mutateAsync({ publish: mode, scheduledAt: mode === 'schedule' ? new Date(scheduledAt).toISOString() : null })
      .then(() => nav(`/classes/${primary}`))
      .catch((e: { code?: string }) => {
        const map: Record<string, string> = {
          invalidLink: t('material.badLink'), invalidSchedule: t('material.futureErr'),
          invalidAudience: t('material.badAudience'), invalidTopic: t('material.badTopic'),
          titleRequired: t('material.titleRequired'),
          tooLarge: t('material.tooLarge'), quotaExceeded: t('material.quota'),
          fileTypeRejected: t('material.badType'),
        };
        setErr(map[e.code ?? ''] ?? t('common.errorGeneric'));
      })
      .finally(() => setBusy(false));
  }

  function addLink() {
    setErr('');
    const url = safeExternalUrl(linkUrl);
    if (!url) { setErr(t('material.badLink')); return; }
    const kind = classifyAttachmentUrl(url);
    if (kind === 'file') return; // unreachable for parsed URLs, narrows the type
    if (linkInput === 'youtube' && kind !== 'youtube') { setErr(t('material.notYoutube')); return; }
    if (linkInput === 'drive' && kind !== 'drive') { setErr(t('material.notDrive')); return; }
    if (linkInput === 'link' && kind !== 'link') { /* youtube/drive pasted into «Ссылка» still land as themselves */ }
    setLinks((l) => [...l, { url, title: linkTitle.trim().slice(0, 200), kind }]);
    setLinkUrl(''); setLinkTitle(''); setLinkInput('none');
  }

  const linkKind = safeExternalUrl(linkUrl) ? classifyAttachmentUrl(safeExternalUrl(linkUrl)!) : null;

  return (
    <div className="material-page" data-testid="material-page">
      <div className="material-main">
        <div className="row" style={{ alignItems: 'center' }}>
          <h1 style={{ margin: 0 }} data-testid="material-h1">{t('material.newTitle')}</h1>
          <div className="spacer" />
          <button className="ghost" style={{ marginTop: 0 }} data-testid="material-cancel"
            onClick={() => nav(`/classes/${primary}`)}>{t('common.cancel')}</button>
        </div>

        <label htmlFor="m-title">{t('material.titleLabel')}</label>
        <input id="m-title" data-testid="material-title" value={title} maxLength={200}
          placeholder={t('material.titlePh')} aria-invalid={Boolean(titleErr)}
          onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) setTitleErr(''); }} />
        {titleErr && <p className="error" data-testid="material-title-err" style={{ marginTop: 4 }}>{titleErr}</p>}

        <label>{t('material.description')}</label>
        <RichText value={body} docId={id} onChange={setBody} handle={rtRef} />

        {/* ── Прикрепить ── */}
        <label style={{ marginTop: 12 }}>{t('material.attach')}</label>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="att-upload"
            onClick={() => fileRef.current?.click()}>⬆ {t('material.upload')}</button>
          <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="att-link"
            aria-pressed={linkInput === 'link'} onClick={() => setLinkInput(linkInput === 'link' ? 'none' : 'link')}>🔗 {t('material.link')}</button>
          <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="att-youtube"
            aria-pressed={linkInput === 'youtube'} onClick={() => setLinkInput(linkInput === 'youtube' ? 'none' : 'youtube')}>▶ YouTube</button>
          <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="att-drive"
            aria-pressed={linkInput === 'drive'} onClick={() => setLinkInput(linkInput === 'drive' ? 'none' : 'drive')}>🗄 {t('material.drive')}</button>
          <input ref={fileRef} type="file" multiple accept={FILE_ACCEPT} style={{ display: 'none' }} data-testid="att-files"
            onChange={(e) => { const picked = Array.from(e.target.files ?? []); setFiles((f) => [...f, ...picked]); e.target.value = ''; }} />
        </div>
        {linkInput !== 'none' && (
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }} data-testid="link-form">
            <input style={{ flex: 1, minWidth: 200, margin: 0 }} data-testid="link-url" value={linkUrl}
              placeholder={t('material.urlPh')} onChange={(e) => setLinkUrl(e.target.value)} />
            <input style={{ flex: 1, minWidth: 140, margin: 0 }} data-testid="link-title" value={linkTitle}
              placeholder={t('material.titlePh')} onChange={(e) => setLinkTitle(e.target.value)} />
            <button type="button" data-testid="link-add" style={{ marginTop: 0 }} disabled={!linkKind} onClick={addLink}>{t('common.create')}</button>
          </div>
        )}
        {(files.length > 0 || links.length > 0) && (
          <div className="att-list" data-testid="att-list">
            {files.map((f, i) => (
              <div key={`f${i}`} className="att-card" data-testid="att-file">
                <span>📄 {f.name}</span>
                <span className="muted">{(f.size / 1024).toFixed(0)} KB</span>
                <div className="spacer" />
                <button type="button" className="ghost danger-text" style={{ marginTop: 0 }} aria-label={t('common.delete')}
                  data-testid={`att-file-del-${i}`} onClick={() => setFiles((a) => a.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            {links.map((l, i) => (
              <div key={l.url + i} className="att-card" data-testid={`att-card-${l.kind}`}>
                <span>{l.kind === 'youtube' ? '▶ YouTube' : l.kind === 'drive' ? '🗄 Google Drive' : '🔗 ' + (l.title || l.url)}</span>
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="muted att-url">{l.url}</a>
                <div className="spacer" />
                <button type="button" className="ghost danger-text" style={{ marginTop: 0 }} aria-label={t('common.delete')}
                  data-testid={`att-link-del-${i}`} onClick={() => setLinks((a) => a.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            {links.some((l) => l.kind === 'drive') && <p className="muted" style={{ fontSize: '.85rem' }}>{t('material.driveHint')}</p>}
          </div>
        )}
        {err && <p className="error" data-testid="material-err">{err}</p>}
      </div>

      {/* ── right panel ── */}
      <aside className="material-side card">
        <h3>{t('material.forWhom')}</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {classes.map((c) => (
            <label key={c.id} className="chip-label" data-testid={`mc-class-${c.id}`}>
              <input type="checkbox" checked={pickedClasses.has(c.id)} onChange={(e) => {
                setPickedClasses((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; });
                setTopicId(''); setNewTopicName(null);
              }} /> {c.name}
            </label>
          ))}
        </div>

        <h3 style={{ marginTop: 14 }}>{t('material.assignTo')}</h3>
        <div className="row" style={{ gap: 10 }}>
          <label className="chip-label"><input type="radio" name="aud" data-testid="aud-all" checked={audienceMode === 'all'}
            onChange={() => setAudienceMode('all')} /> {t('material.allStudents')}</label>
          <label className="chip-label"><input type="radio" name="aud" data-testid="aud-some" checked={audienceMode === 'selected'}
            onChange={() => setAudienceMode('selected')} /> {t('material.selectedStudents')}</label>
        </div>
        {audienceMode === 'selected' && (
          <div className="aud-list" data-testid="aud-list">
            {(membersQ.data ?? []).flatMap((grp) => grp.list.map((m) => (
              <label key={grp.cid + m.userId} className="row" style={{ gap: 6, margin: '2px 0' }}>
                <input type="checkbox" data-testid={`aud-${m.userId}`} checked={pickedStudents.has(m.userId)}
                  onChange={(e) => setPickedStudents((s) => { const n = new Set(s); if (e.target.checked) n.add(m.userId); else n.delete(m.userId); return n; })} />
                {m.name}
              </label>
            )))}
            {(membersQ.data ?? []).every((g) => !g.list.length) && <span className="muted">{t('material.noStudents')}</span>}
          </div>
        )}

        <h3 style={{ marginTop: 14 }}>{t('material.topic')}</h3>
        <select data-testid="topic-select" value={newTopicName ? '__new__' : topicId} style={{ width: '100%' }}
          onChange={(e) => { if (e.target.value !== '__new__') { setTopicId(e.target.value); setNewTopicName(null); } }}>
          <option value="">{t('material.noTopic')}</option>
          {topics.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
          <option value="__new__">{t('material.newTopic')}</option>
        </select>
        {newTopicName !== null && (
          <input data-testid="topic-new" autoFocus value={newTopicName} maxLength={120} placeholder={t('material.topicPh')}
            style={{ marginTop: 6 }} onChange={(e) => setNewTopicName(e.target.value)} />
        )}
        {newTopicName === null && (
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="topic-create"
              onClick={() => setNewTopicName('')}>+ {t('material.newTopic')}</button>
            {topicId && (
              <>
                <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="topic-rename"
                  onClick={() => {
                    const cur = topics.find((x) => x.id === topicId)?.name ?? '';
                    const v = window.prompt(t('material.renameTopic'), cur);
                    if (v && v.trim()) api(`/api/topics/${topicId}`, { method: 'PATCH', body: JSON.stringify({ name: v.trim() }) })
                      .then(() => topicsQ.refetch());
                  }}>✎</button>
                <button type="button" className="ghost danger-text" style={{ marginTop: 0 }} data-testid="topic-delete"
                  onClick={() => {
                    if (window.confirm(t('material.deleteTopicConfirm'))) api(`/api/topics/${topicId}`, { method: 'DELETE' })
                      .then(() => { setTopicId(''); topicsQ.refetch(); });
                  }}>🗑</button>
              </>
            )}
          </div>
        )}

        {publish === 'schedule' && (
          <div style={{ marginTop: 12 }}>
            <label htmlFor="m-when">{t('material.scheduleFor')}</label>
            <input id="m-when" type="datetime-local" data-testid="material-when" value={scheduledAt} style={{ width: '100%' }}
              onChange={(e) => setScheduledAt(e.target.value)} />
            <p className="muted" style={{ fontSize: '.8rem' }}>{t('material.tzDevice')}</p>
          </div>
        )}

        <div className="pub-row" data-testid="publish-row">
          <button data-testid="material-publish" disabled={busy || create.isPending}
            onClick={() => submit(publish)}>
            {publish === 'now' ? t('material.publishNow') : publish === 'draft' ? t('material.saveDraft') : t('material.scheduleBtn')}
          </button>
          <button className="secondary pub-caret" data-testid="publish-menu" aria-haspopup="menu" aria-expanded={menuOpen}
            style={{ marginTop: 0, minWidth: 40 }} disabled={busy}
            onClick={(e) => { setPubAnchor(e.currentTarget); setMenuOpen((v) => !v); }}>▾</button>
          {menuOpen && (
            <div className="card pub-menu" role="menu" data-testid="publish-options" ref={pubPop.ref} style={pubPop.style}>
              <button role="menuitem" data-testid="pub-now" style={{ marginTop: 0 }} onClick={() => { setPublish('now'); setMenuOpen(false); }}>{t('material.publishNow')}</button>
              <button role="menuitem" data-testid="pub-schedule" style={{ marginTop: 0 }} onClick={() => { setPublish('schedule'); setMenuOpen(false); }}>{t('material.schedule')}</button>
              <button role="menuitem" data-testid="pub-draft" style={{ marginTop: 0 }} onClick={() => { setPublish('draft'); setMenuOpen(false); }}>{t('material.saveDraft')}</button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
