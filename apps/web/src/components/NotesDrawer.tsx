import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';

interface Sheet {
  id: string; classId: string; sessionId: string | null;
  title: string; body: string; updatedAt: string;
}

const bufKey = (id: string) => `klass-sheet-${id}`;

/** §3.8 personal sheets: tabs, 1 s debounced autosave, localStorage buffer. */
export default function NotesDrawer({ classId, sessionId, open, onToggle }: {
  classId: string; sessionId: string | null; open: boolean; onToggle: () => void;
}) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const sheets = useQuery({
    queryKey: ['sheets', sessionId, classId],
    queryFn: () => api<Sheet[]>(`/api/student-notes?${sessionId ? `sessionId=${sessionId}` : `classId=${classId}`}`),
    refetchInterval: 20_000,
  });

  // restore local buffer for the offline case (server had a newer one → keep server, drop buffer only if equal)
  useEffect(() => {
    if (!activeId) return;
    const row = (sheets.data ?? []).find((s) => s.id === activeId);
    const raw = localStorage.getItem(bufKey(activeId));
    if (raw && row) {
      try {
        const buf = JSON.parse(raw) as { body: string; at: number };
        if (buf.body !== row.body) { setText(buf.body); flushNow(activeId, buf.body); return; }
      } catch { /* ignore */ }
      localStorage.removeItem(bufKey(activeId));
    }
    if (row) setText(row.body);
  }, [activeId, sheets.data]);

  const save = useMutation({
    mutationFn: (p: { id: string; body: string }) =>
      api(`/api/student-notes/${p.id}`, { method: 'PATCH', body: JSON.stringify({ body: p.body }) }),
    onSuccess: () => { if (activeRef.current) localStorage.removeItem(bufKey(activeRef.current)); },
  });

  function flushNow(id: string, body: string) {
    dirty.current = false;
    save.mutate({ id, body });
  }

  function onEdit(v: string) {
    setText(v);
    if (!activeId) return;
    localStorage.setItem(bufKey(activeId), JSON.stringify({ body: v, at: Date.now() }));
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (dirty.current && activeId) flushNow(activeId, v);
    }, 1000); // §3.8 debounce 1 s
  }

  const create = useMutation({
    mutationFn: () => api<Sheet>('/api/student-notes', {
      method: 'POST',
      body: JSON.stringify({ classId, sessionId: sessionId ?? null, title: `${t('sheets.sheet')} ${(sheets.data?.length ?? 0) + 1}`, body: '' }),
    }),
    onSuccess: (n) => { setActiveId(n.id); void sheets.refetch(); },
  });

  function exportSheet(s: Sheet) {
    const blob = new Blob([`# ${s.title}\n\n${s.body}`], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${s.title || 'sheet'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  const list = sheets.data ?? [];

  return (
    <>
      <button
        data-testid="sheet-fab"
        className="sheet-fab"
        onClick={onToggle}
        aria-label={t('sheets.title')}
      >📝 {t('sheets.title')}</button>
      {open && (
        <div className="sheet-panel">
          <div className="row">
            <strong>{t('sheets.title')}</strong>
            <div className="spacer" />
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => create.mutate()} disabled={create.isPending}>+ {t('sheets.new')}</button>
            <button className="danger" style={{ marginTop: 0 }} onClick={onToggle}>✕</button>
          </div>
          <div className="row" style={{ flexWrap: 'nowrap', overflowX: 'auto' }}>
            {list.map((s) => (
              <button key={s.id} className={s.id === activeId ? '' : 'secondary'}
                style={{ marginTop: 6, whiteSpace: 'nowrap' }} onClick={() => setActiveId(s.id)}>
                {s.title}
              </button>
            ))}
          </div>
          {activeId && (
            <>
              <textarea
                data-testid="sheet-body"
                value={text}
                onChange={(e) => onEdit(e.target.value)}
                placeholder={t('sheets.placeholder')}
                style={{ flex: 1, minHeight: 200, marginTop: 8 }}
              />
              <div className="row">
                <span className="muted">{save.isPending ? t('sheets.saving') : t('sheets.saved')}</span>
                <div className="spacer" />
                <button className="secondary" style={{ marginTop: 0 }}
                  onClick={() => exportSheet(list.find((s) => s.id === activeId) ?? { title: 'sheet', body: text } as Sheet)}>
                  ⤓ .md
                </button>
              </div>
            </>
          )}
          {!activeId && <p className="muted">{t('sheets.pick')}</p>}
        </div>
      )}
    </>
  );
}
