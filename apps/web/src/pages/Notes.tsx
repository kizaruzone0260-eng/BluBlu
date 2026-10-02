import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '../lib/api';
import { useAuth } from '../App';

interface Note {
  id: string; classId: string; title: string; body: string;
  sharedPostId: string | null; updatedAt: string;
}

function Tiptap({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value || '<p></p>',
    editorProps: { attributes: { class: 'tiptap' } },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
      <MenuBar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

function MenuBar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  const btn = (label: string, fn: () => void, active = false) => (
    <button
      key={label} type="button" className="secondary"
      style={{ margin: 2, padding: '4px 8px', fontWeight: active ? 700 : 400, marginTop: 4 }}
      onClick={fn}
    >{label}</button>
  );
  return (
    <div style={{ padding: 4, borderBottom: '1px solid var(--border)' }}>
      {btn('B', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
      {btn('I', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
      {btn('H2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
      {btn('•', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
      {btn('1.', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {btn('⌫ undo', () => editor.chain().focus().undo().run())}
      {btn('redo ↪', () => editor.chain().focus().redo().run())}
    </div>
  );
}

/** §3.4 — private notes of the teacher, autosave debounced, publish to feed. */
export default function Notes() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [classId, setClassId] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);

  const notes = useQuery({ queryKey: ['notes'], queryFn: () => api<Note[]>('/api/notes'), enabled: me?.role === 'teacher' });
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api<{ id: string; name: string }[]>('/api/classes') });

  const createNote = useMutation({
    mutationFn: () => api<Note>('/api/notes', { method: 'POST', body: JSON.stringify({ classId, title: '', body: '' }) }),
    onSuccess: (n) => { setActiveId(n.id); void qc.invalidateQueries({ queryKey: ['notes'] }); },
  });
  const patchNote = useMutation({
    mutationFn: (p: { id: string; patch: { title?: string; body?: string } }) =>
      api(`/api/notes/${p.id}`, { method: 'PATCH', body: JSON.stringify(p.patch) }),
    onSuccess: () => setSavedAt(new Date().toLocaleTimeString()),
  });
  const publish = useMutation({
    mutationFn: (id: string) => api(`/api/notes/${id}/publish`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notes'] }),
  });

  const active = (notes.data ?? []).find((n) => n.id === activeId) ?? null;

  // load active note into local state
  useEffect(() => {
    if (active) { setTitle(active.title); setBody(active.body); }
  }, [activeId]);

  function queueSave(next: { title?: string; body?: string }) {
    if (!activeId) return;
    dirtyRef.current = true;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      patchNote.mutate({ id: activeId, patch: next });
    }, 800);
  }

  // save on unmount/switch too
  useEffect(() => () => {
    if (dirtyRef.current && activeId) {
      void fetch(`/api/notes/${activeId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, body }),
        keepalive: true,
      }).catch(() => undefined);
    }
  }, [activeId]);

  if (me?.role !== 'teacher') return <p className="error">{t('common.errorGeneric')}</p>;

  return (
    <div>
      <h1>{t('notes.title')}</h1>
      <div className="row">
        <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ width: 'auto' }}>
          <option value="">{t('notes.pickClass')}</option>
          {(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button style={{ marginTop: 0 }} disabled={!classId || createNote.isPending} onClick={() => createNote.mutate()}>
          {t('notes.new')}
        </button>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <div style={{ width: 220 }}>
          {(notes.data ?? []).map((n) => (
            <div
              key={n.id}
              className="card"
              style={{ padding: 8, cursor: 'pointer', background: n.id === activeId ? '#eef0fb' : undefined }}
              onClick={() => setActiveId(n.id)}
            >
              <strong>{n.title || t('notes.untitled')}</strong>
              <div className="muted">{new Date(n.updatedAt).toLocaleString()} {n.sharedPostId ? '· ✓' : ''}</div>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 280 }}>
          {active ? (
            <>
              <input
                value={title}
                placeholder={t('notes.untitled')}
                onChange={(e) => { setTitle(e.target.value); queueSave({ title: e.target.value }); }}
              />
              <div style={{ marginTop: 8 }}>
                <Tiptap value={body} onChange={(html) => { setBody(html); queueSave({ body: html }); }} />
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="muted">{savedAt ? `${t('notes.saved')} ${savedAt}` : t('notes.editing')}</span>
                <div className="spacer" />
                <button className="secondary" style={{ marginTop: 0 }} onClick={() => publish.mutate(active.id)} disabled={publish.isPending}>
                  {t('notes.publish')}
                </button>
              </div>
            </>
          ) : <p className="muted">{t('notes.pickNote')}</p>}
        </div>
      </div>
    </div>
  );
}
