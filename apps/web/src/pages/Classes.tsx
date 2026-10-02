import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../App';

interface ClassView {
  id: string; name: string; description: string; color: string;
  teacherName: string; memberCount: number; archived: boolean; role: 'teacher' | 'student';
}

export default function Classes() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinErr, setJoinErr] = useState('');

  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api<ClassView[]>('/api/classes') });

  const createClass = useMutation({
    mutationFn: () => api('/api/classes', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['classes'] }); },
  });

  const joinByCode = useMutation({
    mutationFn: () => api('/api/join-by-code', { method: 'POST', body: JSON.stringify({ code: joinCode }) }),
    onSuccess: () => { setJoinCode(''); setJoinErr(''); void qc.invalidateQueries({ queryKey: ['classes'] }); },
    onError: (e: unknown) => setJoinErr((e as { code?: string }).code ?? 'errorGeneric'),
  });

  return (
    <div>
      <h1>{t('classes.title')}</h1>
      {classes.isLoading && <p className="muted">{t('common.loading')}</p>}
      {(classes.data ?? []).map((c) => (
        <div key={c.id} data-testid="class-card" className="card" style={{ borderLeft: `6px solid ${c.color}` }}>
          <div className="row">
            <Link to={`/classes/${c.id}`} style={{ fontWeight: 600 }}>{c.name}</Link>
            <div className="spacer" />
            <span className="muted">{c.role === 'teacher' ? `${c.memberCount} ${t('classes.members').toLowerCase()}` : c.teacherName}</span>
          </div>
          {c.description && <p className="muted">{c.description}</p>}
        </div>
      ))}

      {me?.role === 'teacher' && (
        <div className="card">
          <h2>{t('classes.newClass')}</h2>
          <label>{t('classes.className')}</label>
          <input data-testid="new-class-name" value={name} onChange={(e) => setName(e.target.value)} minLength={2} />
          <button data-testid="create-class" onClick={() => createClass.mutate()} disabled={name.trim().length < 2 || createClass.isPending}>
            {t('common.create')}
          </button>
        </div>
      )}

      {me?.role === 'student' && (
        <div className="card">
          <h2>{t('classes.joinByCode')}</h2>
          <div className="row">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={9}
              placeholder="ABCD23EF"
              style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 2, flex: 1 }}
            />
            <button style={{ marginTop: 0 }} onClick={() => joinByCode.mutate()} disabled={joinCode.length < 8 || joinByCode.isPending}>
              {t('classes.joinByCode')}
            </button>
          </div>
          {joinErr && <p className="error">{t(`auth.${joinErr}`, { defaultValue: t('common.errorGeneric') })}</p>}
        </div>
      )}
    </div>
  );
}
