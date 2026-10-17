import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { noteHasContent } from '@klass/shared';
import { api } from '../lib/api';
import { editorIsAlive } from '../lib/tiptapSafe';
import { keepFocus } from '../lib/keepFocus';
import { useDraftEditor, clearDraft, clearDraftIfSaved, moveDraft, type EditorHandle } from '../lib/uncontrolledEditor';
import { DraftBar } from '../components/RichText';
import { useAuth } from '../App';
import { InkEditor, composeInk, extractInk, type InkData } from '../components/NoteInk';

const DRAFT = '__draft__';
/** Область локального черновика заметок: ключ = `klass.draft.note.<docId>`. */
const SCOPE = 'note';

/** Stable identity for `useEditor` — see components/RichText.tsx and lib/tiptapSafe.ts. */
const EXTENSIONS = [StarterKit];

interface Note {
  id: string; classId: string | null; eventId: string | null; pinned: boolean;
  title: string; body: string; sharedPostId: string | null; updatedAt: string;
}

/**
 * Редактор заметки — тот же неконтролируемый редактор, что и в форме материала: значение
 * возвращается в документ только при смене заметки (и по кнопке «вернуть черновик»), а
 * набранное немедленно пишется в локальный черновик (см. lib/uncontrolledEditor). `handle`
 * даёт странице flush: отдать последние символы перед переключением заметки, перед
 * публикацией и при закрытии вкладки.
 */
function Tiptap({ value, docId, draftId, serverRev, onChange, handle }: {
  value: string; docId: string; draftId: string; serverRev?: number;
  onChange: (html: string) => void;
  handle?: { current: EditorHandle | null };
}) {
  // Stable options (see components/RichText.tsx): the notes editor is the other place that
  // used to call getHTML() on an instance @tiptap/react had already destroyed, which put the
  // whole page behind the 500 screen.
  const editorProps = useMemo(() => ({ attributes: { class: 'tiptap' } }), []);
  const { editor, notice, applyKept } = useDraftEditor({
    value, docId, draftId, scope: SCOPE, serverRev, extensions: EXTENSIONS, editorProps, onChange, handle,
  });
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
      <MenuBar editor={editor} />
      <EditorContent editor={editor} />
      <DraftBar notice={notice} onApply={applyKept} />
    </div>
  );
}

function MenuBar({ editor }: { editor: Editor | null }) {
  const { t } = useTranslation();
  // an un-mounted-but-alive instance still gets its toolbar (EditorContent mounts it);
  // a destroyed one has no commands left to build buttons from.
  if (!editorIsAlive(editor)) return null;
  // Доступное имя обязательно: «B», «•» и «1.» экранному диктору ничего не говорят.
  // testid — те же, что у панели формы материала, чтобы одна проверка прошла по обоим.
  const btn = (label: string, title: string, testid: string, fn: () => void, active = false) => (
    <button
      key={label} type="button" className="secondary" aria-label={title} title={title}
      data-testid={testid} aria-pressed={active}
      style={{ margin: 2, padding: '4px 8px', minWidth: 36, minHeight: 36, fontWeight: active ? 700 : 400, marginTop: 4 }}
      onMouseDown={keepFocus}
      onClick={fn}
    >{label}</button>
  );
  return (
    <div style={{ padding: 4, borderBottom: '1px solid var(--border)' }}>
      {btn('B', t('material.bold'), 'rt-bold', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
      {btn('I', t('material.italic'), 'rt-italic', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
      {btn('H2', t('material.heading'), 'rt-h2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
      {btn('•', t('material.bullet'), 'rt-ul', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
      {btn('1.', t('material.ordered'), 'rt-ol', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {btn('↩', t('material.undo'), 'rt-undo', () => editor.chain().focus().undo().run())}
      {btn('↪', t('material.redo'), 'rt-redo', () => editor.chain().focus().redo().run())}
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
  // item 2/3: the editor must NOT remount when a draft is promoted to a real
  // note (the POST happens mid-typing); it only changes on user-driven switches
  const [editorSeed, setEditorSeed] = useState('none');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [noteClass, setNoteClass] = useState('');       // binding of the ACTIVE note
  const [noteEvent, setNoteEvent] = useState('');
  const [filter, setFilter] = useState('');             // '' all | 'noclass' | <classId>
  const [search, setSearch] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<number | undefined>(undefined);
  const createdRef = useRef(false);

  const notes = useQuery({ queryKey: ['notes'], queryFn: () => api<Note[]>('/api/notes'), enabled: me?.role === 'teacher' });
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api<{ id: string; name: string }[]>('/api/classes') });
  const eventsQ = useQuery({
    queryKey: ['events-for-notes'],
    queryFn: () => api<{ eventId: string; classId: string; title: string; kind: string; startsAt: string }[]>(
      `/api/events?from=${new Date(Date.now() - 30 * 864e5).toISOString()}&to=${new Date(Date.now() + 120 * 864e5).toISOString()}`),
  });

  // latest field values for the debounced save (state closures go stale)
  const titleRef = useRef(''); const bodyRef = useRef('');
  const metaRef = useRef<{ cls: string; ev: string }>({ cls: '', ev: '' });
  const [ink, setInk] = useState<InkData | null>(null);
  const inkRef = useRef<InkData | null>(null);
  titleRef.current = title; bodyRef.current = body;
  metaRef.current = { cls: noteClass, ev: noteEvent };
  inkRef.current = ink;
  const creatingRef = useRef(false);
  const skipLoadRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  // редактор заметки: страница забирает у него последние символы перед сменой заметки,
  // перед публикацией и при закрытии вкладки (дебаунс см. в lib/uncontrolledEditor)
  const rtRef = useRef<EditorHandle | null>(null);
  // какой ПРОСТОЙ html (без чернил) реально ушёл на сервер последним PATCH-ом: по нему и
  // убирается черновик; сверять с ответом сервера нельзя — серверный санитайзер вправе
  // изменить разметку, и равенство перестало бы означать «сохранено»
  const sentHtmlRef = useRef<string | null>(null);
  // для какой заметки накоплен pendingRef: переключение не должно перелить текст в другую
  const pendingOwner = useRef<string | null>(null);
  const fireRef = useRef<(() => void) | null>(null);

  // D.1/§2: a note exists only once it has content — «add» opens a client-side
  // draft; the POST fires at the first autosave with non-blank title/body.
  const create = useMutation({
    mutationFn: (p: { classId: string | null; eventId: string | null; title: string; body: string }) =>
      api<Note>('/api/notes', { method: 'POST', body: JSON.stringify(p) }),
    onSuccess: (n) => {
      creatingRef.current = false;
      skipLoadRef.current = n.id; // the note we just made — do not clobber the in-progress editor
      if (pendingOwner.current === DRAFT) pendingOwner.current = n.id;
      setActiveId(n.id);
      // черновик лежит под ключом «ещё не созданной» заметки, а с этого момента редактор
      // пишет его под настоящим id. ПЕРЕНОСИМ, а не стираем: нажатия, сделанные пока шёл
      // POST, ещё не на сервере, и этот перенос — их единственная копия на диске.
      // Лишним он не останется: при следующем открытии decideOnOpen видит равенство с
      // сервером и убирает ключ сам, а PATCH-дочистка делает это сразу.
      moveDraft(SCOPE, DRAFT, n.id);
      // the POST itself IS a save — without this a draft written in one burst
      // (title+body together) would never show «Сохранено»
      setSavedAt(new Date().toLocaleTimeString());
      void qc.invalidateQueries({ queryKey: ['notes'] });
      // edits made while the POST was in flight still belong to the note
      const leftover = { ...pendingRef.current };
      pendingRef.current = {};
      if (Object.keys(leftover).length > 0) {
        patchNote.mutate({ id: n.id, patch: leftover as Partial<Pick<Note, 'title' | 'body' | 'classId' | 'eventId'>> });
      }
    },
    onError: () => { creatingRef.current = false; },
  });
  const patchNote = useMutation({
    mutationFn: (p: { id: string; patch: Partial<Pick<Note, 'title' | 'body' | 'pinned' | 'classId' | 'eventId'>> }) =>
      api<Note>(`/api/notes/${p.id}`, { method: 'PATCH', body: JSON.stringify(p.patch) }),
    onSuccess: (_n, p) => {
      setSavedAt(new Date().toLocaleTimeString());
      // черновик убираем только когда на сервер легло ровно то, что в нём лежит: если человек
      // печатал, пока шёл PATCH, стирать было бы потерей тех самых последних символов
      if (sentHtmlRef.current !== null) clearDraftIfSaved(SCOPE, p.id, sentHtmlRef.current);
      void qc.invalidateQueries({ queryKey: ['notes'] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/notes/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => { clearDraft(SCOPE, id); setActiveId(null); void qc.invalidateQueries({ queryKey: ['notes'] }); },
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

  const realActive = (notes.data ?? []).find((n) => n.id === activeId) ?? null;
  /*
   * Чем редактор ОТКРЫВАЕТСЯ. `value` и `serverRev` берутся из строки списка по идентификатору
   * открытого документа, а НЕ из локального `body`: неконтролируемый редактор читает `value`
   * ровно в том рендере, где поменялся `docId`, а эффект загрузки заметки догоняет состояние
   * уже ПОСЛЕ этого рендера — открывать из `body` значило бы «заметка открылась текстом
   * предыдущей». Локальное `body` остаётся рабочей копией страницы (автосейв, признак
   * «есть что публиковать»), но редактор её не слушает.
   *
   * Строки нет в двух случаях: ещё не созданная заметка (тогда серверного текста и правда нет,
   * rev = 0) и окно сразу после POST, когда `editorSeed` ещё черновиковый, а строка уже под
   * настоящим id. Во втором случае документ не меняется, поэтому `value` редактором игнорируется.
   */
  const seedRow = editorSeed === DRAFT ? null : (notes.data ?? []).find((n) => n.id === editorSeed) ?? null;
  const serverBody = seedRow ? extractInk(seedRow.body).rest : '';
  const serverRev = seedRow ? (Date.parse(seedRow.updatedAt) || 0) : 0;
  const draftOrReal: Note | null = activeId === DRAFT
    ? { id: DRAFT, classId: noteClass || null, eventId: noteEvent || null, pinned: false, title, body: composeInk(body, ink), sharedPostId: null, updatedAt: new Date().toISOString() }
    : realActive;
  // D.3 switch window: between the POST landing (setActiveId(real id)) and the
  // ['notes'] refetch, the new note is momentarily absent from the list. Returning
  // null here would unmount the whole editor subtree — losing drawing mode, the
  // canvas view and any in-flight stroke. Keep showing the last note (under the
  // fresh id, so PATCH/publish target the real row) until the list catches up.
  const lastNoteRef = useRef<Note | null>(null);
  if (draftOrReal) lastNoteRef.current = draftOrReal;
  const active: Note | null = draftOrReal
    ?? (activeId && lastNoteRef.current ? { ...lastNoteRef.current, id: activeId } : null);
  const lessonOptions = useMemo(() => {
    const cid = noteClass || active?.classId;
    return (eventsQ.data ?? []).filter((e) => e.kind === 'lesson' && (!cid || e.classId === cid));
  }, [eventsQ.data, noteClass, active]);

  function openDraft(classId?: string | null, eventId?: string | null) {
    if (activeId === DRAFT) return; // repeated clicks reuse the one open draft
    dirtyRef.current = false;
    pendingRef.current = {};
    creatingRef.current = false;
    setActiveId(DRAFT);
    // идентичность «ещё не созданной» заметки постоянна: именно поэтому её ненабранный текст
    // переживает перезагрузку вкладки (ключ черновика = note.__draft__) и приходит обратно
    // с подсказкой. Меняется только активный документ, а не ключ.
    setEditorSeed(DRAFT);
    setTitle(''); setBody(''); setInk(null);
    setNoteClass(classId ?? ''); setNoteEvent(eventId ?? '');
    setSavedAt(null);
  }
  function discardDraft() {
    dirtyRef.current = false;
    pendingRef.current = {};
    clearDraft(SCOPE, DRAFT);
    setActiveId(null);
  }

  // load active note into local state (drawing split out of the body — item 3)
  useEffect(() => {
    if (realActive) {
      // right after the draft POST created this note the SERVER copy is older
      // than what the user is typing — re-loading it would wipe the keystrokes
      if (skipLoadRef.current === activeId) { skipLoadRef.current = null; return; }
      const { rest, ink: fromBody } = extractInk(realActive.body);
      setTitle(realActive.title); setBody(rest); setInk(fromBody);
      setNoteClass(realActive.classId ?? ''); setNoteEvent(realActive.eventId ?? '');
    }
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // D.3 quick actions land on /notes?new=1[&classId=&eventId=]
  useEffect(() => {
    if (me?.role !== 'teacher' || createdRef.current) return;
    if (sp.get('new') === '1') {
      createdRef.current = true;
      openDraft(sp.get('classId'), sp.get('eventId'));
      setSp({}, { replace: true });
    }
  }, [sp, me]); // eslint-disable-line react-hooks/exhaustive-deps

  function queueSave(next: { title?: string; body?: string; classId?: string | null; eventId?: string | null }) {
    if (!activeId) return;
    if (!dirtyRef.current) pendingOwner.current = activeId;   // чей это текст, если успеют переключиться
    // merge, don't replace: a fast edit of two fields must not lose the first one
    Object.assign(pendingRef.current, next);
    dirtyRef.current = true;
    window.clearTimeout(timerRef.current);
    const fire = () => {
      if (!dirtyRef.current) return;
      const curId = activeIdRef.current; // may have moved DRAFT→real since scheduling
      // если успели открыть ДРУГУЮ заметку, писать надо туда, откуда набрали, а не в новую;
      // DRAFT остаётся текущим — его продвижение в реальную заметку обновляет владельца само
      const owner = pendingOwner.current;
      const id = owner && owner !== DRAFT && owner !== curId ? owner : curId;
      const mine = id === curId;
      const patch = { ...pendingRef.current };
      const mergedTitle = (patch.title as string | undefined) ?? (mine ? titleRef.current : '');
      const mergedBody = (patch.body as string | undefined) ?? (mine ? composeInk(bodyRef.current, inkRef.current) : '');
      // §2: an empty DRAFT is never sent to the API at all; the note is created
      // at the first save that has content.
      if (id === DRAFT) {
        if (!noteHasContent(mergedTitle, mergedBody)) return;
        // the promoting POST is still in flight → retry shortly; once it lands,
        // activeIdRef holds the real id and the next fire takes the PATCH path
        timerRef.current = creatingRef.current ? window.setTimeout(fire, 400) : undefined;
        if (creatingRef.current) return;
        dirtyRef.current = false;
        pendingRef.current = {};
        pendingOwner.current = null;
        creatingRef.current = true;
        create.mutate({
          classId: (patch.classId as string | null | undefined) ?? (noteClass || null),
          eventId: (patch.eventId as string | null | undefined) ?? (noteEvent || null),
          title: mergedTitle, body: mergedBody,
        });
        return;
      }
      dirtyRef.current = false;
      pendingRef.current = {};
      pendingOwner.current = null;
      // запоминаем ОТДАННЫЙ простой html: по нему убирается черновик после успеха
      sentHtmlRef.current = extractInk(mergedBody).rest;
      if (id) patchNote.mutate({ id, patch: patch as Partial<Pick<Note, 'title' | 'body' | 'pinned' | 'classId' | 'eventId'>> });
    };
    fireRef.current = fire;
    timerRef.current = window.setTimeout(fire, 800);
  }

  /** Сохранить накопленное СЕЙЧАС — вызывается до смены заметки, пока id ещё старый. */
  function saveNow() {
    window.clearTimeout(timerRef.current);
    const f = fireRef.current;
    fireRef.current = null;
    if (f) f();
  }

  // save on unmount/switch too (real api() helper → keeps the Authorization header)
  useEffect(() => () => {
    if (!dirtyRef.current) return;
    const plain = rtRef.current?.flush() || bodyRef.current;
    const fullBody = composeInk(plain, inkRef.current);
    // Идентикатор берём СВЕЖИЙ. React запускает этот cleanup на каждый рендер, и его замыкание
    // могло остаться на черновике, который к этому моменту уже стал реальной заметкой, — такой
    // cleanup повторно ПОСТИЛ заметку и удваивал её (это и поймал redesign: две «Заметка
    // проверки» с одним заголовком). Накопленное при этом снимается с очереди, чтобы таймер
    // автосейва не написал то же самое вторично.
    const owner = pendingOwner.current;
    const id = owner && owner !== DRAFT ? owner : (activeIdRef.current ?? activeId);
    dirtyRef.current = false;
    pendingRef.current = {};
    pendingOwner.current = null;
    window.clearTimeout(timerRef.current);
    if (id === DRAFT) {
      // leaving an empty draft discards it silently; a draft WITH content is created
      if (noteHasContent(titleRef.current, fullBody)) {
        void api('/api/notes', {
          method: 'POST',
          body: JSON.stringify({
            title: titleRef.current, body: fullBody,
            classId: metaRef.current.cls || null, eventId: metaRef.current.ev || null,
          }),
          keepalive: true,
        } as RequestInit)
          // ключ ещё не созданной заметки: черновик с тем же текстом больше не нужен
          .then(() => clearDraftIfSaved(SCOPE, DRAFT, plain))
          .catch(() => undefined);
      }
      return;
    }
    if (id) {
      void api(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ title: titleRef.current, body: fullBody }), keepalive: true } as RequestInit)
        .then(() => clearDraftIfSaved(SCOPE, id, plain))
        .catch(() => undefined);
    }
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (me?.role !== 'teacher') return <p className="error">{t('common.errorGeneric')}</p>;
  const isDraft = activeId === DRAFT;

  return (
    <div>
      <div className="row">
        <h1 style={{ margin: 0 }}>{t('notes.title')}</h1>
        <div className="spacer" />
        <button style={{ marginTop: 0 }} data-testid="notes-add" disabled={create.isPending}
          onClick={() => openDraft(filter && filter !== 'noclass' ? filter : null)}>
          {t('notes.add')}
        </button>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <input placeholder={t('sheets.search')} aria-label={t('sheets.search')} value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 260 }} data-testid="notes-search" />
        <select value={filter} aria-label={t('notes.filterAll')} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }} data-testid="notes-filter">
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
              <button style={{ marginTop: 0 }} onClick={() => openDraft(null)}>{t('notes.new')}</button>
            </div>
          )}
          {activeId === DRAFT && (
            <button type="button" data-testid="note-item-draft" className="note-item active">
              <strong>{title || t('notes.untitled')}</strong>
              <span className="meta">{t('notes.editing')}</span>
            </button>
          )}
          {list.map((n) => (
            <button key={n.id} type="button" data-testid="note-item"
              className={n.id === activeId ? 'note-item active' : 'note-item'}
              onClick={() => { rtRef.current?.flush(); saveNow(); setActiveId(n.id); setEditorSeed(n.id); }}>
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
                <Tiptap key={editorSeed} value={serverBody} docId={editorSeed} draftId={activeId ?? editorSeed}
                  serverRev={serverRev} handle={rtRef}
                  onChange={(html) => { setBody(html); queueSave({ body: composeInk(html, inkRef.current) }); }} />
                {/* item 3 — drawing (pen/eraser/colors/thickness/undo/redo/clear), stored in the body */}
                <InkEditor ink={ink} onChange={(next) => {
                  setInk(next); inkRef.current = next;
                  queueSave({ body: composeInk(bodyRef.current, next) });
                }} />
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="muted" data-testid="notes-saved">{savedAt ? `${t('notes.saved')} ${savedAt}` : t('notes.editing')}</span>
                <div className="spacer" />
                <button className="ghost" style={{ marginTop: 0 }} data-testid="note-pin" disabled={isDraft}
                  onClick={() => patchNote.mutate({ id: active.id, patch: { pinned: !active.pinned } })}>
                  {active.pinned ? `★ ${t('notes.unpinNote')}` : `☆ ${t('notes.pinNote')}`}
                </button>
                {/* §2: publishing an empty note is impossible — the button itself knows */}
                <button className="secondary" style={{ marginTop: 0 }} onClick={() => publish.mutate(active.id)}
                  disabled={isDraft || !active.classId || publish.isPending || !noteHasContent(title, composeInk(body, ink))} data-testid="note-publish">
                  {t('notes.publish')}
                </button>
                <button className="danger" style={{ marginTop: 0 }} data-testid="note-delete"
                  onClick={() => {
                    if (isDraft) { discardDraft(); return; }
                    if (window.confirm(t('notes.deleteConfirm'))) del.mutate(active.id);
                  }}>
                  {isDraft ? t('common.cancel') : t('common.delete')}
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
