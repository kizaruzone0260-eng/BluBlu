import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../App';

interface Sheet {
  id: string; classId: string; sessionId: string | null;
  title: string; body: string; updatedAt: string;
}

/** §3.8 — “Мои заметки” section after the lesson: search + export .md/.txt. */
export default function Sheets() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const sheets = useQuery({ queryKey: ['sheets-all'], queryFn: () => api<Sheet[]>('/api/student-notes'), enabled: me?.role === 'student' });
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api<{ id: string; name: string }[]>('/api/classes') });

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/student-notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sheets-all'] }),
  });

  if (me?.role !== 'student') return <p className="error">{t('common.errorGeneric')}</p>;

  const list = (sheets.data ?? [])
    .filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()) || s.body.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const exportSheet = (s: Sheet, ext: 'md' | 'txt') => {
    const content = ext === 'md' ? `# ${s.title}\n\n${s.body}` : s.body;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    a.download = `${s.title || 'sheet'}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  const className = (id: string) => (classes.data ?? []).find((c) => c.id === id)?.name ?? '';

  return (
    <div>
      <h1>{t('sheets.title')}</h1>
      <div className="card">
        <input placeholder={t('sheets.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.map((s) => (
        <div key={s.id} className="card">
          <div className="row">
            <strong>{s.title || t('sheets.untitled')}</strong>
            <span className="muted">{className(s.classId)} · {new Date(s.updatedAt).toLocaleString()}</span>
            <div className="spacer" />
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => setOpenId(openId === s.id ? null : s.id)}>≡</button>
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => exportSheet(s, 'md')}>.md</button>
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => exportSheet(s, 'txt')}>.txt</button>
            <button className="danger" style={{ marginTop: 0 }} onClick={() => del.mutate(s.id)}>✕</button>
          </div>
          {openId === s.id && <p style={{ whiteSpace: 'pre-wrap' }}>{s.body}</p>}
        </div>
      ))}
      {list.length === 0 && <p className="muted">{t('feed.empty')}</p>}
    </div>
  );
}
