import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '../lib/api';
import { useAuth } from '../App';

interface Note {
  id: string; classId: string | null; eventId: string | null; pinned: boolean;
  title: string; body: string; sharedPostId: string | null; updatedAt: string;
}

function Tiptap({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value || '<p></p>',
    editorProps: { attributes: { class: 'tiptap' } },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
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
      style={{ margin: 2, padding: '4px 8px', minWidth: 36, minHeight: 36, fontWeight: active ? 700 : 400, marginTop: 4 }}
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
      {btn('↩', () => editor.chain().focus().undo().run())}
      {btn('↪', () => editor.chain().focus().redo().run())}
    </div>
  );
}

/** §3.4 + D — private teacher notes: create anytime, autosave, pin, class/lesson link, search & filters. */
export default function Notes() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [noteClass, setNoteClass] = useState('');       // binding of the ACTIVE note
  const [noteEvent, setNoteEvent] = useState('');
  const [filter, setFilter] = useState('');             // '' all | 'noclass' | <classId>
  const [search, setSearch] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const createdRef = useRef(false);

  const notes = useQuery({ queryKey: ['notes'], queryFn: () => api<Note[]>('/api/notes'), enabled: me?.role === 'teacher' });
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api<{ id: string; name: string }[]>('/api/classes') });
  const eventsQ = useQuery({
    queryKey: ['events-for-notes'],
    queryFn: () => api<{ eventId: string; classId: string; title: string; kind: string; startsAt: string }[]>(
      `/api/events?from=${new Date(Date.now() - 30 * 864e5).toISOString()}&to=${new Date(Date.now() + 120 * 864e5).toISOString()}`),
  });

  const create = useMutation({
    mutationFn: (p: { classId: string | null; eventId: string | null }) =>
      api<Note>('/api/notes', { method: 'POST', body: JSON.stringify({ title: '', body: '', ...p }) }),
    onSuccess: (n) => { setActiveId(n.id); void qc.invalidateQueries({ queryKey: ['notes'] }); },
  });
  const patchNote = useMutation({
    mutationFn: (p: { id: string; patch: Partial<Pick<Note, 'title' | 'body' | 'pinned' | 'classId' | 'eventId'>> }) =>
      api<Note>(`/api/notes/${p.id}`, { method: 'PATCH', body: JSON.stringify(p.patch) }),
    onSuccess: () => { setSavedAt(new Date().toLocaleTimeString()); void qc.invalidateQueries({ queryKey: ['notes'] }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setActiveId(null); void qc.invalidateQueries({ queryKey: ['notes'] }); },
  });
  const publish = useMutation({
    mutationFn: (id: string) => api(`/api/notes/${id}/publish`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notes'] }),
  });

  const list = useMemo(() => {
    let rows = notes.data ?? [];
    if (filter === 'noclass') rows = rows.filter((n) => !n.classId);
    else if (filter) rows = rows.filter((n) => n.classId === filter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((n) => n.title.toLowerCase().includes(q) || stripTags(n.body).toLowerCase().includes(q));
    }
    return rows;
  }, [notes.data, filter, search]);

  const active = (notes.data ?? []).find((n) => n.id === activeId) ?? null;
  const lessonOptions = useMemo(() => {
    const cid = noteClass || active?.classId;
    return (eventsQ.data ?? []).filter((e) => e.kind === 'lesson' && (!cid || e.classId === cid));
  }, [eventsQ.data, noteClass, active]);

  // load active note into local state
  useEffect(() => {
    if (active) {
      setTitle(active.title); setBody(active.body);
      setNoteClass(active.classId ?? ''); setNoteEvent(active.eventId ?? '');
    }
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // D.3 quick actions land on /notes?new=1[&classId=&eventId=]
  useEffect(() => {
    if (me?.role !== 'teacher' || createdRef.current) return;
    if (sp.get('new') === '1') {
      createdRef.current = true;
      create.mutate({ classId: sp.get('classId') || null, eventId: sp.get('eventId') || null });
      setSp({}, { replace: true });
    }
  }, [sp, me]); // eslint-disable-line react-hooks/exhaustive-deps

  function queueSave(next: { title?: string; body?: string; classId?: string | null; eventId?: string | null }) {
    if (!activeId) return;
    dirtyRef.current = true;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      patchNote.mutate({ id: activeId, patch: next });
    }, 800);
  }

  // save on unmount/switch too (real api() helper → keeps the Authorization header)
  useEffect(() => () => {
    if (dirtyRef.current && activeId) {
      void api(`/api/notes/${activeId}`, { method: 'PATCH', body: JSON.stringify({ title, body }), keepalive: true } as RequestInit)
        .catch(() => undefined);
    }
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (me?.role !== 'teacher') return <p className="error">{t('common.errorGeneric')}</p>;

  return (
    <div>
      <div className="row">
        <h1 style={{ margin: 0 }}>{t('notes.title')}</h1>
        <div className="spacer" />
        <button style={{ marginTop: 0 }} data-testid="notes-add" disabled={create.isPending}
          onClick={() => create.mutate({ classId: filter && filter !== 'noclass' ? filter : null, eventId: null })}>
          {t('notes.add')}
        </button>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <input placeholder={t('sheets.search')} value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 260 }} data-testid="notes-search" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }} data-testid="notes-filter">
          <option value="">{t('notes.filterAll')}</option>
          {(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="noclass">{t('notes.filterNoLesson')}</option>
        </select>
      </div>

      <div className="row" style={{ marginTop: 12, alignItems: 'flex-start' }}>
        <div style={{ width: 250, maxWidth: '100%' }} className="notes-list">
          {list.length === 0 && !notes.isPending && (
            <div className="empty-state card">
              <div className="big">📝</div>
              <p>{t('notes.pickNote')}</p>
              <button style={{ marginTop: 0 }} onClick={() => create.mutate({ classId: null, eventId: null })}>{t('notes.new')}</button>
            </div>
          )}
          {list.map((n) => (
            <button key={n.id} type="button" data-testid="note-item"
              className={n.id === activeId ? 'note-item active' : 'note-item'}
              onClick={() => setActiveId(n.id)}>
              <strong>{n.pinned && <span className="pin-star">★ </span>}{n.title || t('notes.untitled')}</strong>
              <span className="meta">
                {new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(n.updatedAt))}
                {n.sharedPostId ? ' · ✓' : ''}
              </span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 280, maxWidth: 720 }}>
          {active ? (
            <>
              <input data-testid="note-title"
                value={title}
                placeholder={t('notes.untitled')}
                onChange={(e) => { setTitle(e.target.value); queueSave({ title: e.target.value }); }}
              />
              <div className="row" style={{ marginTop: 8 }}>
                <label style={{ margin: 0 }} htmlFor="note-class">{t('classes.title')}</label>
                <select id="note-class" value={noteClass} data-testid="note-class"
                  onChange={(e) => {
                    const v = e.target.value;
                    setNoteClass(v); setNoteEvent('');
                    queueSave({ classId: v || null, eventId: null });
                  }}
                  style={{ width: 'auto' }}>
                  <option value="">{t('notes.noClass')}</option>
                  {(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <label style={{ margin: 0 }} htmlFor="note-event">{t('notes.linkedLesson')}</label>
                <select id="note-event" value={noteEvent} data-testid="note-event"
                  onChange={(e) => {
                    const v = e.target.value;
                    setNoteEvent(v);
                    const cid = v ? (eventsQ.data ?? []).find((x) => x.eventId === v)?.classId ?? noteClass : noteClass;
                    if (cid && cid !== noteClass) setNoteClass(cid);
                    queueSave({ eventId: v || null, classId: cid || null });
                  }}
                  style={{ width: 'auto' }}>
                  <option value="">—</option>
                  {lessonOptions.map((e) => (
                    <option key={e.eventId} value={e.eventId}>
                      {e.title} · {new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' }).format(new Date(e.startsAt))}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ marginTop: 8 }}>
                <Tiptap value={body} onChange={(html) => { setBody(html); queueSave({ body: html }); }} />
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="muted" data-testid="notes-saved">{savedAt ? `${t('notes.saved')} ${savedAt}` : t('notes.editing')}</span>
                <div className="spacer" />
                <button className="ghost" style={{ marginTop: 0 }} data-testid="note-pin"
                  onClick={() => patchNote.mutate({ id: active.id, patch: { pinned: !active.pinned } })}>
                  {active.pinned ? `★ ${t('notes.unpinNote')}` : `☆ ${t('notes.pinNote')}`}
                </button>
                <button className="secondary" style={{ marginTop: 0 }} onClick={() => publish.mutate(active.id)}
                  disabled={!active.classId || publish.isPending} data-testid="note-publish">
                  {t('notes.publish')}
                </button>
                <button className="danger" style={{ marginTop: 0 }} data-testid="note-delete"
                  onClick={() => { if (window.confirm(t('notes.deleteConfirm'))) del.mutate(active.id); }}>
                  {t('common.delete')}
                </button>
              </div>
            </>
          ) : <p className="muted">{t('notes.pickNote')}</p>}
        </div>
      </div>
    </div>
  );
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, ' ');
