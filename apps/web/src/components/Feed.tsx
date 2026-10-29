import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { blobUrlFor, downloadFile } from '../lib/preview';
import { classifyAttachmentUrl, safeExternalUrl, youtubeVideoId } from '../lib/attachments';
import { fmtDateTime } from '../lib/format';
import { NoteBodyView } from './NoteInk';
import RichText from './RichText';
import { clearDraftIfSaved, type EditorHandle } from '../lib/uncontrolledEditor';
import { useAuth } from '../App';
import { useFocusTrap } from '../lib/focusTrap';

/**
 * Class feed (material task A): published posts grouped by topic with
 * collapsible headers, a teacher-only «Черновики и запланированные» section,
 * unified attachment cards (file / link / YouTube / Drive) and inline editing
 * of published materials (text, topic, audience, add/remove attachments).
 */

interface FileRef { id: string; name: string; mime: string; size: number }
interface Attachment {
  id: string; kind: 'file' | 'link' | 'youtube' | 'drive'; url: string | null;
  title: string; position: number; file: FileRef | null;
}
interface FeedPost {
  id: string; kind: 'material' | 'announcement'; title: string; body: string;
  pinned: boolean; topic: string | null; topicId: string | null; topicName: string | null;
  status: 'draft' | 'scheduled' | 'published'; scheduledAt: string | null;
  audience: string[]; attachments: Attachment[];
  createdAt: string; authorName: string;
}
interface TopicRow { id: string; name: string; position: number }
interface MemberRow { userId: string; name: string; email: string }

function canPreview(mime: string) {
  return (mime.startsWith('image/') || mime === 'application/pdf'
    || mime.startsWith('audio/') || mime.startsWith('video/') || mime.startsWith('text/'))
    && mime !== 'image/svg+xml';
}

export default function Feed({ classId }: { classId: string }) {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const feed = useQuery({ queryKey: ['feed', classId], queryFn: () => api<FeedPost[]>(`/api/classes/${classId}/feed`) });
  const [preview, setPreview] = useState<{ url: string; mime: string; name: string; revoke: () => void } | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  // окно просмотра файла ведёт себя как диалог: Escape закрывает, Tab не уходит за затемнение
  // (аудит 2026-10-28, пункт 13)
  useFocusTrap(previewRef, preview !== null);
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { preview.revoke(); setPreview(null); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview]);

  const isTeacher = me?.role === 'teacher';
  const invalidate = () => qc.invalidateQueries({ queryKey: ['feed', classId] });

  const createAnnouncement = useMutation({
    mutationFn: (p: { title: string; body: string }) => api(`/api/classes/${classId}/announcements`, {
      method: 'POST', body: JSON.stringify(p),
    }),
    onSuccess: invalidate,
  });
  const patchPost = useMutation({
    mutationFn: (p: { id: string; patch: Record<string, unknown> }) => api(`/api/posts/${p.id}`, {
      method: 'PATCH', body: JSON.stringify(p.patch),
    }),
    onSuccess: invalidate,
  });
  const delPost = useMutation({ mutationFn: (id: string) => api(`/api/posts/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
  const publishNow = useMutation({
    mutationFn: (id: string) => api(`/api/posts/${id}/publish`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  const [showAnnounce, setShowAnnounce] = useState(false);
  const [err, setErr] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);

  const posts = feed.data ?? [];
  const published = posts.filter((p) => p.status === 'published');
  const unpublished = posts.filter((p) => p.status !== 'published');

  // topic grouping (task A §2): real topics first in their stored order, then
  // legacy free-text, then «без темы»
  const groups = useMemo(() => {
    const byKey = new Map<string, { label: string; order: number; items: FeedPost[] }>();
    for (const p of published) {
      const key = p.topicId ?? p.topic ?? '__none__';
      if (!byKey.has(key)) {
        byKey.set(key, {
          label: p.topicName ?? p.topic ?? t('feed.noTopic'),
          order: p.topicId ? 0 : p.topic ? 1 : 2,
          items: [],
        });
      }
      byKey.get(key)!.items.push(p);
    }
    return [...byKey.entries()].sort((a, b) => a[1].order - b[1].order || a[1].label.localeCompare(b[1].label));
  }, [published, t]);

  const toggle = (k: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  async function openPreview(f: FileRef) {
    try {
      const { url, revoke } = await blobUrlFor(`/api/files/${f.id}/inline`);
      setPreview({ url, mime: f.mime, name: f.name, revoke });
    } catch {
      void downloadFile(f.id, f.name);
    }
  }

  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>{t('feed.title')}</h2>
        <div className="spacer" />
        {isTeacher && (
          <>
            <Link to={`/classes/${classId}/material/new`} data-testid="new-material-link">
              <button style={{ marginTop: 0 }}>{t('feed.newMaterial')}</button>
            </Link>
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => setShowAnnounce(!showAnnounce)}>
              {t('feed.newAnnouncement')}
            </button>
          </>
        )}
      </div>

      {showAnnounce && (
        <form
          style={{ marginTop: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            await createAnnouncement.mutateAsync({ title: String(fd.get('title')), body: String(fd.get('body') ?? '') });
            setShowAnnounce(false);
          }}
        >
          <label>{t('common.name')}</label>
          <input name="title" required maxLength={200} />
          <label>{t('feed.text')}</label>
          <textarea name="body" rows={3} maxLength={4000} />
          <button disabled={createAnnouncement.isPending}>{t('common.create')}</button>
        </form>
      )}

      {/* teacher-only drafts & scheduled (task A §3) */}
      {isTeacher && unpublished.length > 0 && (
        <section data-testid="drafts-section" style={{ marginTop: 10 }}>
          <h3>{t('feed.draftsTitle')}</h3>
          {unpublished.map((p) => (
            <div key={p.id} className="feed-post feed-unpublished" data-testid="draft-item">
              <div className="row">
                <span className={`badge ${p.status === 'scheduled' ? 'used' : ''}`} data-testid={`draft-status-${p.id}`}>
                  {p.status === 'scheduled' ? t('feed.scheduled') : t('feed.draft')}
                </span>
                {p.status === 'scheduled' && p.scheduledAt && (
                  <span className="muted">{fmtDateTime(p.scheduledAt, i18n.language)}</span>
                )}
                <div className="spacer" />
                <button className="secondary" style={{ marginTop: 0 }} data-testid={`draft-publish-${p.id}`}
                  onClick={() => publishNow.mutate(p.id)}>{t('material.publishNow')}</button>
                <button className="secondary" style={{ marginTop: 0 }} onClick={() => setEditing(editing === p.id ? null : p.id)}>
                  {t('feed.edit')}
                </button>
                <button className="danger" style={{ marginTop: 0 }} aria-label={t('common.delete')}
                  onClick={() => { if (window.confirm(t('feed.deleteConfirm'))) delPost.mutate(p.id); }}>✕</button>
              </div>
              <strong>{p.title}</strong>
              <Attachments posts={p} />
              {editing === p.id && <MaterialEdit classId={classId} post={p} onDone={invalidate} />}
            </div>
          ))}
        </section>
      )}

      {groups.map(([key, g]) => (
        <section key={key} data-testid={`topic-group-${key}`}>
          <button type="button" className="topic-head" data-testid={`topic-toggle-${key}`}
            aria-expanded={!collapsed.has(key)} onClick={() => toggle(key)}>
            <span className="topic-caret">{collapsed.has(key) ? '▸' : '▾'}</span>
            <strong>{g.label}</strong>
            <span className="muted">({g.items.length})</span>
          </button>
          {!collapsed.has(key) && g.items.map((p) => (
            <div key={p.id} className="feed-post" data-testid="feed-item">
              <div className="row">
                <span className={`badge ${p.kind === 'announcement' ? 'used' : 'active'}`}>
                  {t(p.kind === 'announcement' ? 'feed.announcement' : 'feed.material')}
                </span>
                {p.pinned && <span className="badge">📌</span>}
                {p.topicName && <span className="muted">{p.topicName}</span>}
                <div className="spacer" />
                {isTeacher && (
                  <>
                    <button className="secondary" style={{ marginTop: 0 }}
                      onClick={() => patchPost.mutate({ id: p.id, patch: { pinned: !p.pinned } })}>
                      {p.pinned ? t('feed.unpin') : t('feed.pin')}
                    </button>
                    <button className="secondary" style={{ marginTop: 0 }} data-testid="post-edit"
                      onClick={() => setEditing(editing === p.id ? null : p.id)}>{t('feed.edit')}</button>
                    <button className="danger" style={{ marginTop: 0 }} data-testid="post-del" aria-label={t('common.delete')}
                      onClick={() => { if (window.confirm(t('feed.deleteConfirm'))) delPost.mutate(p.id); }}>✕</button>
                  </>
                )}
              </div>
              <strong data-testid="feed-title">{p.title}</strong>
              {p.body && p.kind === 'announcement' && <p style={{ whiteSpace: 'pre-wrap' }}><NoteBodyView body={p.body} plain /></p>}
              {p.body && p.kind === 'material' && <p className="muted"><NoteBodyView body={p.body} /></p>}
              <Attachments posts={p} onPreview={openPreview} />
              <div className="muted">{p.authorName} · {fmtDateTime(p.createdAt, i18n.language)}</div>
              {editing === p.id && <MaterialEdit classId={classId} post={p} onDone={invalidate} />}
            </div>
          ))}
        </section>
      ))}
      {posts.length === 0 && !feed.isPending && <p className="muted">{t('feed.empty')}</p>}
      {err && <p className="error">{err}</p>}

      {preview && (
        <div
          role="presentation"
          onClick={() => { preview.revoke(); setPreview(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16,
          }}
        >
          <div className="card" role="dialog" aria-modal="true" aria-label={`${t('feed.preview')}: ${preview.name}`}
            ref={previewRef}
            style={{ maxWidth: '90vw', maxHeight: '90vh', width: 900, overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <strong>{preview.name}</strong>
              <div className="spacer" />
              <button className="danger" style={{ marginTop: 0 }} aria-label={t('common.close')}
                onClick={() => { preview.revoke(); setPreview(null); }}>✕</button>
            </div>
            {/*
              Размеры загруженного файла неизвестны на момент рендера, поэтому width/height у
              <img> поставить неоткуда — вместо этого место под изображение резервирует контейнер
              той же высоты, что у PDF-просмотра. Иначе позднее декодирование сдвигало заголовок
              окна (CLS; аудит 2026-10-28, пункт 10).
            */}
            {preview.mime.startsWith('image/') && (
              <div className="preview-media">
                <img src={preview.url} alt="" decoding="async"
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              </div>
            )}
            {preview.mime === 'application/pdf' && <iframe src={preview.url} title={`${t('feed.preview')}: ${preview.name}`} style={{ width: '100%', height: '70vh', border: 'none' }} />}
            {preview.mime.startsWith('audio/') && <audio src={preview.url} controls style={{ width: '100%' }} />}
            {preview.mime.startsWith('video/') && (
              <div className="preview-media">
                <video src={preview.url} controls style={{ maxWidth: '100%', maxHeight: '100%' }} />
              </div>
            )}
            {preview.mime.startsWith('text/') && <iframe src={preview.url} title={`${t('feed.preview')}: ${preview.name}`} style={{ width: '100%', height: '70vh', border: 'none', background: '#fff' }} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** attachment cards — YouTube only embeds through youtube-nocookie AFTER a click */
function Attachments({ posts: p, onPreview }: { posts: FeedPost; onPreview?: (f: FileRef) => void }) {
  const { t } = useTranslation();
  const [played, setPlayed] = useState<Record<string, boolean>>({});
  if (!p.attachments.length) return null;
  return (
    <div className="att-list" data-testid={`post-atts-${p.id}`}>
      {p.attachments.map((a) => {
        if (a.kind === 'file' && a.file) {
          const f = a.file;
          return (
            <span key={a.id} className="att-card" data-testid="att-file-card">
              <a href="#" onClick={(e) => { e.preventDefault(); void downloadFile(f.id, f.name); }}>📄 {f.name}</a>
              <span className="muted">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
              {onPreview && canPreview(f.mime) && (
                <button className="secondary" style={{ marginTop: 0 }} onClick={() => onPreview(f)}>{t('feed.preview')}</button>
              )}
            </span>
          );
        }
        if (a.kind === 'youtube') {
          const vid = a.url ? youtubeVideoId(a.url) : null;
          return (
            <span key={a.id} className="att-card att-yt" data-testid="att-youtube-card">
              {vid && played[a.id] ? (
                <iframe data-testid="att-yt-frame" title={a.title || 'YouTube'}
                  src={`https://www.youtube-nocookie.com/embed/${vid}`}
                  allow="accelerometer; encrypted-media; picture-in-picture" allowFullScreen
                  style={{ width: '100%', maxWidth: 560, aspectRatio: '16/9', border: 0 }} />
              ) : (
                <>
                  <span>▶ YouTube</span>
                  <a href={a.url ?? '#'} target="_blank" rel="noopener noreferrer" className="muted att-url">{a.title || a.url}</a>
                  {vid && (
                    <button className="secondary" style={{ marginTop: 0 }} data-testid="att-yt-play"
                      onClick={() => setPlayed((s) => ({ ...s, [a.id]: true }))}>{t('material.ytWatch')}</button>
                  )}
                </>
              )}
            </span>
          );
        }
        if (a.kind === 'drive') {
          return (
            <span key={a.id} className="att-card att-drive" data-testid="att-drive-card">
              <span>🗄 Google Drive</span>
              <a href={a.url ?? '#'} target="_blank" rel="noopener noreferrer" className="muted att-url">{a.title || a.url}</a>
              <span className="muted" style={{ fontSize: '.8rem' }}>{t('material.driveHint')}</span>
            </span>
          );
        }
        return (
          <span key={a.id} className="att-card" data-testid="att-link-card">
            <span>🔗</span>
            <a href={a.url ?? '#'} target="_blank" rel="noopener noreferrer">{a.title || a.url}</a>
          </span>
        );
      })}
    </div>
  );
}

/** inline editor for a material: text+topic+audience, add/remove attachments */
function MaterialEdit({ classId, post, onDone }: { classId: string; post: FeedPost; onDone: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [topicId, setTopicId] = useState(post.topicId ?? '');
  const [audience, setAudience] = useState<Set<string>>(new Set(post.audience));
  const [allAudience, setAllAudience] = useState(post.audience.length === 0);
  const [linkUrl, setLinkUrl] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const rtRef = useRef<EditorHandle | null>(null);
  // что реально ушло на сервер этим PATCH — по этому значию и убираем черновик
  const sentRef = useRef<string | null>(null);

  const topicsQ = useQuery({ queryKey: ['topics', classId], queryFn: () => api<TopicRow[]>(`/api/classes/${classId}/topics`) });
  const membersQ = useQuery({ queryKey: ['members', classId], queryFn: () => api<MemberRow[]>(`/api/classes/${classId}/members`) });

  const save = useMutation({
    mutationFn: () => {
      // последние символы могли ещё не дойти до состояния (дебаунс редактора)
      const html = rtRef.current?.flush() || body;
      sentRef.current = html;
      return api(`/api/posts/${post.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: title.trim() || post.title,
          body: html,
          topicId: topicId || null,
          audience: allAudience ? [] : [...audience],
        }),
      });
    },
    onSuccess: () => {
      // черновик убирается только если на сервер легло ровно то, что в нём: печатали во время
      // PATCH — значит есть ненабранное, и стирать его нельзя
      if (sentRef.current !== null) clearDraftIfSaved('post', post.id, sentRef.current);
      onDone();
    },
  });
  const addLink = useMutation({
    mutationFn: (u: string) => api(`/api/posts/${post.id}/attachments`, { method: 'POST', body: JSON.stringify({ url: u, title: '' }) }),
    onSuccess: () => { setLinkUrl(''); onDone(); },
  });
  const addFiles = useMutation({
    mutationFn: async (fs: File[]) => {
      const form = new FormData();
      for (const f of fs) form.append('file', f);
      await api(`/api/posts/${post.id}/files`, { method: 'POST', body: form });
    },
    onSuccess: () => onDone(),
  });
  const delAtt = useMutation({
    mutationFn: (aid: string) => api(`/api/posts/${post.id}/attachments/${aid}`, { method: 'DELETE' }),
    onSuccess: () => onDone(),
  });

  return (
    <div className="card material-edit" data-testid={`edit-${post.id}`} style={{ marginTop: 8 }}>
      <label>{t('common.name')}</label>
      <input data-testid="edit-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <label>{t('material.description')}</label>
      {/* scope='post' — черновик этого материала. serverRev не передаём: лента отдаёт только
          createdAt, а «версия неизвестна» по правилу decideOnOpen означает «локальный черновик
          важнее» — серверная копия никогда не затирает ненабранное молча. */}
      <RichText value={body} docId={post.id} scope="post" onChange={setBody} minHeight={90} handle={rtRef} />
      <label>{t('material.topic')}</label>
      <select data-testid="edit-topic" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
        <option value="">{t('material.noTopic')}</option>
        {(topicsQ.data ?? []).map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
      </select>
      <label>{t('material.assignTo')}</label>
      <div className="row" style={{ gap: 10 }}>
        <label className="chip-label"><input type="radio" name={`aud-${post.id}`} data-testid="edit-aud-all"
          checked={allAudience} onChange={() => setAllAudience(true)} /> {t('material.allStudents')}</label>
        <label className="chip-label"><input type="radio" name={`aud-${post.id}`} data-testid="edit-aud-some"
          checked={!allAudience} onChange={() => setAllAudience(false)} /> {t('material.selectedStudents')}</label>
      </div>
      {!allAudience && (membersQ.data ?? []).map((m) => (
        <label key={m.userId} className="row" style={{ gap: 6 }}>
          <input type="checkbox" data-testid={`edit-aud-${m.userId}`} checked={audience.has(m.userId)}
            onChange={(e) => setAudience((s) => { const n = new Set(s); if (e.target.checked) n.add(m.userId); else n.delete(m.userId); return n; })} />
          {m.name}
        </label>
      ))}
      <label>{t('material.attach')}</label>
      {post.attachments.map((a) => (
        <div key={a.id} className="row att-row" style={{ gap: 6 }}>
          <span className="muted">{a.kind === 'file' ? `📄 ${a.title}` : `${a.title || a.url}`}</span>
          <div className="spacer" />
          <button className="ghost danger-text" style={{ marginTop: 0 }} data-testid={`edit-att-del-${a.id}`}
            aria-label={t('common.delete')} onClick={() => delAtt.mutate(a.id)}>✕</button>
        </div>
      ))}
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <input style={{ flex: 1, margin: 0 }} data-testid="edit-link-url" placeholder={t('material.urlPh')}
          value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
        <button className="secondary" style={{ marginTop: 0 }} data-testid="edit-link-add"
          disabled={!safeExternalUrl(linkUrl) || addLink.isPending}
          onClick={() => {
            const u = safeExternalUrl(linkUrl);
            if (!u) { setErr(t('material.badLink')); return; }
            setErr('');
            addLink.mutate(u);
          }}>{classifyAttachmentUrl(safeExternalUrl(linkUrl) ?? 'https://x.io') === 'link' ? t('material.link') : t('material.attach')}</button>
        <button className="secondary" style={{ marginTop: 0 }} data-testid="edit-file-add" onClick={() => fileRef.current?.click()}>
          ⬆ {t('material.upload')}
        </button>
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }} data-testid="edit-files"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) addFiles.mutate(fs); e.target.value = ''; }} />
      </div>
      {err && <p className="error">{err}</p>}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button data-testid="edit-save" disabled={save.isPending || !title.trim()} onClick={() => save.mutate()}>{t('common.save')}</button>
      </div>
    </div>
  );
}
