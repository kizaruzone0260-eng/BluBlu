import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../App';
import { InkEditor, NoteBodyView, composeInk, extractInk, type InkData } from '../components/NoteInk';

interface Sheet {
  id: string; classId: string; sessionId: string | null;
  title: string; body: string; updatedAt: string;
}

/** §3.8 + D — student's private sheets: create anytime, autosave edit, search, export, delete (confirm). */
export default function Sheets() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [ink, setInk] = useState<InkData | null>(null);
  const inkRef = useRef<InkData | null>(null);
  inkRef.current = ink;
  const draftRef = useRef('');
  draftRef.current = draft;
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const createdRef = useRef(false);

  const sheets = useQuery({ queryKey: ['sheets-all'], queryFn: () => api<Sheet[]>('/api/student-notes'), enabled: me?.role === 'student' });
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api<{ id: string; name: string }[]>('/api/classes') });

  const create = useMutation({
    mutationFn: (classId: string) => api<Sheet>('/api/student-notes', {
      method: 'POST', body: JSON.stringify({ classId, title: `${t('sheets.sheet')} ${(sheets.data?.length ?? 0) + 1}`, body: '' }),
    }),
    onSuccess: (s) => { openSheet(s); void qc.invalidateQueries({ queryKey: ['sheets-all'] }); },
  });
  const patch = useMutation({
    mutationFn: (p: { id: string; body: string }) => api(`/api/student-notes/${p.id}`, { method: 'PATCH', body: JSON.stringify({ body: p.body }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sheets-all'] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/student-notes/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => { if (openId === id) setOpenId(null); void qc.invalidateQueries({ queryKey: ['sheets-all'] }); },
  });

  // D.3 quick action «Новая заметка» from Home (/sheets?new=1)
  useEffect(() => {
    if (me?.role !== 'student' || createdRef.current) return;
    if (sp.get('new') === '1') {
      const cid = (classes.data ?? [])[0]?.id;
      if (cid) {
        createdRef.current = true;
        create.mutate(cid);
        setSp({}, { replace: true });
      }
    }
  }, [sp, me, classes.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (me?.role !== 'student') return <p className="error">{t('common.errorGeneric')}</p>;

  const list = (sheets.data ?? [])
    .filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()) || s.body.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const exportSheet = (s: Sheet, ext: 'md' | 'txt') => {
    const { rest } = extractInk(s.body); // drawings don't travel into .md/.txt
    const content = ext === 'md' ? `# ${s.title}\n\n${rest}` : rest;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    a.download = `${s.title || 'sheet'}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  const className = (id: string) => (classes.data ?? []).find((c) => c.id === id)?.name ?? '';

  function openSheet(s: Sheet) {
    const { rest, ink: i } = extractInk(s.body);
    setDraft(rest); setInk(i); inkRef.current = i;
    setOpenId(s.id);
  }

  function onEdit(v: string) {
    if (!openId) return;
    setDraft(v);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (dirty.current && openId) { dirty.current = false; patch.mutate({ id: openId, body: composeInk(v, inkRef.current) }); }
    }, 1000); // §3.8 autosave 1 s
  }

  function onInkChange(next: InkData | null) {
    setInk(next); inkRef.current = next;
    if (!openId) return;
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (dirty.current && openId) { dirty.current = false; patch.mutate({ id: openId, body: composeInk(draftRef.current, next) }); }
    }, 1000);
  }

  return (
    <div>
      <div className="row">
        <h1 style={{ margin: 0 }}>{t('sheets.title')}</h1>
        <div className="spacer" />
        <button style={{ marginTop: 0 }} data-testid="sheets-add" disabled={create.isPending || !(classes.data ?? []).length}
          onClick={() => { const cid = (classes.data ?? [])[0]?.id; if (cid) create.mutate(cid); }}>
          + {t('sheets.new')}
        </button>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <input placeholder={t('sheets.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="sheets-search" />
      </div>
      {!list.length && !sheets.isPending && (
        <div className="empty-state card">
          <div className="big">📄</div>
          <p>{t('sheets.pick')}</p>
        </div>
      )}
      {list.map((s) => (
        <div key={s.id} className="card" data-testid="sheet-card">
          <div className="row">
            <strong>{s.title || t('sheets.untitled')}</strong>
            <span className="muted">{className(s.classId)} · {new Date(s.updatedAt).toLocaleString()}</span>
            <div className="spacer" />
            <button className="secondary" style={{ marginTop: 0 }} data-testid="sheet-edit"
              onClick={() => {
                if (openId === s.id) {
                  if (dirty.current) patch.mutate({ id: s.id, body: composeInk(draft, inkRef.current) });
                  setOpenId(null);
                } else { openSheet(s); }
              }}>{openId === s.id ? t('common.save') : '≡'}</button>
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => exportSheet(s, 'md')}>.md</button>
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => exportSheet(s, 'txt')}>.txt</button>
            <button className="danger" style={{ marginTop: 0 }} data-testid="sheet-del"
              onClick={() => { if (window.confirm(t('notes.deleteConfirm'))) del.mutate(s.id); }}>✕</button>
          </div>
          {openId === s.id && (
            <>
              <textarea data-testid="sheet-textarea" value={draft} onChange={(e) => onEdit(e.target.value)}
                placeholder={t('sheets.placeholder')} style={{ minHeight: 160, marginTop: 8 }} />
              {/* item 3 — drawing on the student sheet, stored in the same body */}
              <InkEditor ink={openId === s.id ? ink : null} onChange={onInkChange} />
            </>
          )}
          {openId !== s.id && s.body && (
            <div style={{ maxHeight: '12em', overflow: 'auto' }}><NoteBodyView body={s.body} plain /></div>
          )}
        </div>
      ))}
    </div>
  );
}
