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

  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api<ClassView[]>('/api/classes') });

  const createClass = useMutation({
    mutationFn: () => api('/api/classes', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['classes'] }); },
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
          <label htmlFor="new-class-name">{t('classes.className')}</label>
          <input id="new-class-name" data-testid="new-class-name" value={name} onChange={(e) => setName(e.target.value)} minLength={2} />
          <button data-testid="create-class" onClick={() => createClass.mutate()} disabled={name.trim().length < 2 || createClass.isPending}>
            {t('common.create')}
          </button>
        </div>
      )}

      {/* 2026-10-27: поле «присоединиться по коду» убрано вместе со способом. Ученик, у которого
          ещё нет класса, не может взять его ниоткуда: класс либо дают ссылкой-приглашением, либо
          в него добавляет учитель. Эта карточка — не заглушка, а ответ на вопрос «и что мне
          делать», тот же, что и на странице «Как попасть в класс». */}
      {me?.role === 'student' && (classes.data ?? []).length === 0 && (
        <div className="card" data-testid="no-class-hint">
          <h2>{t('classes.noClassYet')}</h2>
          <p className="muted" style={{ fontSize: '.9rem' }}>{t('classes.noClassYetHint')}</p>
          <p><Link to="/register">{t('auth.howToJoin')}</Link></p>
        </div>
      )}
    </div>
  );
}
