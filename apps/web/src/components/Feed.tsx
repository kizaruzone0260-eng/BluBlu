import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { blobUrlFor, downloadFile } from '../lib/preview';
import { NoteBodyView } from './NoteInk';
import { useAuth } from '../App';

interface FileItem { id: string; name: string; mime: string; size: number }
interface FeedPost {
  id: string; kind: 'material' | 'announcement'; title: string; body: string;
  pinned: boolean; topic: string | null; createdAt: string; authorName: string; files: FileItem[];
}

function canPreview(mime: string) {
  return (mime.startsWith('image/') || mime === 'application/pdf'
    || mime.startsWith('audio/') || mime.startsWith('video/') || mime.startsWith('text/'))
    && mime !== 'image/svg+xml';
}

export default function Feed({ classId }: { classId: string }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const feed = useQuery({ queryKey: ['feed', classId], queryFn: () => api<FeedPost[]>(`/api/classes/${classId}/feed`) });
  const [preview, setPreview] = useState<{ url: string; mime: string; name: string; revoke: () => void } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isTeacher = me?.role === 'teacher';
  const invalidate = () => qc.invalidateQueries({ queryKey: ['feed', classId] });

  const createMaterial = useMutation({
    mutationFn: async (form: FormData) => api(`/api/classes/${classId}/materials`, { method: 'POST', body: form }),
    onSuccess: invalidate,
  });
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
  const delPost = useMutation({
    mutationFn: (id: string) => api(`/api/posts/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const [showForm, setShowForm] = useState<'none' | 'material' | 'announce'>('none');
  const [err, setErr] = useState('');

  async function submitMaterial(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr('');
    const form = new FormData(e.currentTarget);
    const files = fileRef.current?.files;
    if (!files || files.length === 0) { setErr(t('feed.needFile')); return; }
    for (const f of Array.from(files)) form.append('file', f);
    try {
      await createMaterial.mutateAsync(form);
      setShowForm('none');
      (e.target as HTMLFormElement).reset();
    } catch (e2) {
      setErr(t(`feed.${(e2 as { code?: string }).code}`, { defaultValue: t('common.errorGeneric') }));
    }
  }

  async function openPreview(f: FileItem) {
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
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => setShowForm(showForm === 'material' ? 'none' : 'material')}>
              {t('feed.newMaterial')}
            </button>
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => setShowForm(showForm === 'announce' ? 'none' : 'announce')}>
              {t('feed.newAnnouncement')}
            </button>
          </>
        )}
      </div>

      {isTeacher && showForm === 'material' && (
        <form onSubmit={submitMaterial} style={{ marginTop: 8 }}>
          <label>{t('common.name')}</label>
          <input name="title" required maxLength={200} />
          <label>{t('feed.description')}</label>
          <textarea name="description" rows={3} maxLength={4000} />
          <label>{t('feed.topic')}</label>
          <input name="topic" maxLength={120} />
          <label>{t('feed.files')}</label>
          <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.pptx,.xlsx,.txt,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tiff,.mp3,.m4a,.mp4" />
          {err && <p className="error">{err}</p>}
          <button type="submit" disabled={createMaterial.isPending}>{t('common.create')}</button>
        </form>
      )}
      {isTeacher && showForm === 'announce' && (
        <form
          style={{ marginTop: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            await createAnnouncement.mutateAsync({ title: String(fd.get('title')), body: String(fd.get('body') ?? '') });
            setShowForm('none');
          }}
        >
          <label>{t('common.name')}</label>
          <input name="title" required maxLength={200} />
          <label>{t('feed.text')}</label>
          <textarea name="body" rows={3} maxLength={4000} />
          <button disabled={createAnnouncement.isPending}>{t('common.create')}</button>
        </form>
      )}

      {(feed.data ?? []).map((p) => (
        <div key={p.id} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
          <div className="row">
            <span className={`badge ${p.kind === 'announcement' ? 'used' : 'active'}`}>
              {t(p.kind === 'announcement' ? 'feed.announcement' : 'feed.material')}
            </span>
            {p.pinned && <span className="badge">📌</span>}
            {p.topic && <span className="muted">{p.topic}</span>}
            <div className="spacer" />
            {isTeacher && (
              <>
                <button className="secondary" style={{ marginTop: 0 }}
                  onClick={() => patchPost.mutate({ id: p.id, patch: { pinned: !p.pinned } })}>
                  {p.pinned ? t('feed.unpin') : t('feed.pin')}
                </button>
                <button className="danger" style={{ marginTop: 0 }} onClick={() => { if (window.confirm(t('feed.deleteConfirm'))) delPost.mutate(p.id); }}>✕</button>
              </>
            )}
          </div>
          <strong>{p.title}</strong>
          {p.body && p.kind === 'announcement' && <p style={{ whiteSpace: 'pre-wrap' }}><NoteBodyView body={p.body} plain /></p>}
          {p.body && p.kind === 'material' && <p className="muted"><NoteBodyView body={p.body} /></p>}
          {p.files.map((f) => (
            <span key={f.id} className="row" style={{ marginTop: 4 }}>
              <a href="#" onClick={(e) => { e.preventDefault(); void downloadFile(f.id, f.name); }}>
                📎 {f.name}
              </a>
              <span className="muted">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
              {canPreview(f.mime) && (
                <button className="secondary" style={{ marginTop: 0 }} onClick={() => openPreview(f)}>{t('feed.preview')}</button>
              )}
            </span>
          ))}
          <div className="muted">{p.authorName} · {new Date(p.createdAt).toLocaleString()}</div>
        </div>
      ))}
      {feed.data?.length === 0 && <p className="muted">{t('feed.empty')}</p>}

      {preview && (
        <div
          onClick={() => { preview.revoke(); setPreview(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: '90vw', maxHeight: '90vh', width: 900, overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <strong>{preview.name}</strong>
              <div className="spacer" />
              <button className="danger" style={{ marginTop: 0 }} onClick={() => { preview.revoke(); setPreview(null); }}>✕</button>
            </div>
            {preview.mime.startsWith('image/') && <img src={preview.url} alt="" style={{ maxWidth: '100%' }} />}
            {preview.mime === 'application/pdf' && <iframe src={preview.url} title="" style={{ width: '100%', height: '70vh', border: 'none' }} />}
            {preview.mime.startsWith('audio/') && <audio src={preview.url} controls style={{ width: '100%' }} />}
            {preview.mime.startsWith('video/') && <video src={preview.url} controls style={{ width: '100%' }} />}
            {preview.mime.startsWith('text/') && <iframe src={preview.url} title="" style={{ width: '100%', height: '70vh', border: 'none', background: '#fff' }} />}
          </div>
        </div>
      )}
    </div>
  );
}
