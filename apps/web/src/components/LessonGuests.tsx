import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';

/**
 * «Поделиться уроком» (задача 2026-10-28, часть 3) — учительская панель гостевой ссылки.
 *
 * Одна активная ссылка на урок: создать (прежняя закроется), скопировать, отозвать; ниже —
 * заявки гостей с именами и решением «Пустить»/«Отклонить». Токен ссылки показывается ТОЛЬКО
 * сразу после создания: сервер его больше не отдаёт и в базе держит хеш. Поэтому закрыть окно,
 * не скопировав ссылку, — значит выпустить новую (старая закроется вместе с доступом гостей).
 *
 * Панель не решает права: каждый запрос проверяет сервер по владельцу сессии. Здесь только
 * видимость кнопок и опрос списка — плюс кадры сокета урока инвалидируют кэш, когда приходит
 * новая заявка (см. обработчик `guestRequest` в Lesson.tsx).
 */
interface GuestRow {
  id: string; name: string; status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired' | 'ended';
  createdAt: string;
}
interface GuestsData {
  link: { active: boolean; createdAt: string; expiresAt: string } | null;
  requests: GuestRow[];
  pending: number;
}

const STATUS_KEY: Record<GuestRow['status'], string> = {
  pending: 'lesson.guestStatusPending',
  approved: 'lesson.guestStatusApproved',
  rejected: 'lesson.guestStatusRejected',
  revoked: 'lesson.guestStatusRevoked',
  expired: 'lesson.guestStatusExpired',
  ended: 'lesson.guestStatusEnded',
};

export default function LessonGuests({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const queryKey = ['lesson-guests', sessionId];

  const q = useQuery({
    queryKey,
    queryFn: () => api<GuestsData>(`/api/lessons/${sessionId}/guests`),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: () => api<{ url: string; expiresAt: string }>(`/api/lessons/${sessionId}/guest-link`, { method: 'POST' }),
    onSuccess: (d) => { setUrl(d.url); setCopied(false); setError(''); invalidate(); },
    onError: () => setError(t('common.errorGeneric')),
  });
  const revoke = useMutation({
    mutationFn: () => api(`/api/lessons/${sessionId}/guest-link/revoke`, { method: 'POST' }),
    onSuccess: () => { setUrl(''); setCopied(false); setError(''); invalidate(); },
    onError: () => setError(t('common.errorGeneric')),
  });
  const decide = useMutation({
    mutationFn: (p: { requestId: string; approve: boolean }) => api(
      `/api/lessons/${sessionId}/guests/${p.requestId}/${p.approve ? 'approve' : 'reject'}`,
      { method: 'POST' },
    ),
    onSuccess: () => { setError(''); invalidate(); },
    onError: () => setError(t('common.errorGeneric')),
  });

  const link = q.data?.link ?? null;
  const requests = q.data?.requests ?? [];

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError(t('lesson.guestCopyFailed'));
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="guests-title"
        data-testid="guests-modal" onClick={(e) => e.stopPropagation()}>
        <h2 id="guests-title" className="modal-title">🔗 {t('lesson.shareLesson')}</h2>
        <p className="muted">{t('lesson.guestLinkHint')}</p>

        {!link && !url && (
          <button type="button" data-testid="guest-link-create" disabled={create.isPending}
            onClick={() => create.mutate()}>
            {create.isPending ? '…' : t('lesson.guestLinkCreate')}
          </button>
        )}

        {(link || url) && (
          <div className="panel-section" data-testid="guest-link-section">
            <p className="muted">
              {link?.active ? t('lesson.guestLinkActive', { when: new Date(link.expiresAt).toLocaleTimeString() })
                : t('lesson.guestLinkInactive')}
            </p>
            {url ? (
              <>
                <div className="invite-url" dir="ltr"><code data-testid="guest-link-url">{url}</code></div>
                <p className="invite-warn">{t('lesson.guestLinkOnce')}</p>
                <div className="row invite-actions">
                  <button type="button" data-testid="guest-link-copy" onClick={() => void copy()}>
                    {copied ? t('lesson.guestLinkCopied') : t('lesson.guestLinkCopy')}
                  </button>
                  <button type="button" className="ghost" style={{ marginTop: 0 }}
                    data-testid="guest-link-new" disabled={create.isPending} onClick={() => create.mutate()}>
                    {t('lesson.guestLinkNew')}
                  </button>
                  <button type="button" className="danger" style={{ marginTop: 0 }}
                    data-testid="guest-link-revoke" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                    {t('lesson.guestLinkRevoke')}
                  </button>
                </div>
              </>
            ) : (
              <div className="row invite-actions">
                <button type="button" data-testid="guest-link-new" disabled={create.isPending}
                  onClick={() => create.mutate()}>{t('lesson.guestLinkNew')}</button>
                {link?.active && (
                  <button type="button" className="danger" style={{ marginTop: 0 }}
                    data-testid="guest-link-revoke" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                    {t('lesson.guestLinkRevoke')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="panel-section" data-testid="guest-requests">
          <div className="panel-section-title">👤 {t('lesson.guestRequestsTitle')} · {requests.length}</div>
          {requests.length === 0 && <p className="muted" data-testid="guest-requests-empty">{t('lesson.guestNoRequests')}</p>}
          {requests.map((r) => (
            <div key={r.id} className="peer-row" data-testid={`guest-request-${r.id}`}>
              <span className="peer-name">{r.name}</span>
              <span className={`badge${r.status === 'pending' ? ' badge-wait' : ''}`} data-testid={`guest-status-${r.id}`}>
                {t(STATUS_KEY[r.status])}
              </span>
              {(r.status === 'pending' || r.status === 'approved') && (
                <>
                  {r.status === 'pending' && (
                    <button type="button" className="ghost" style={{ marginTop: 0, padding: '2px 8px' }}
                      data-testid={`guest-approve-${r.id}`} disabled={decide.isPending}
                      onClick={() => decide.mutate({ requestId: r.id, approve: true })}>
                      ✔ {t('lesson.guestApprove')}
                    </button>
                  )}
                  <button type="button" className="ghost" style={{ marginTop: 0, padding: '2px 8px' }}
                    data-testid={`guest-reject-${r.id}`} disabled={decide.isPending}
                    onClick={() => decide.mutate({ requestId: r.id, approve: false })}>
                    ✕ {r.status === 'approved' ? t('lesson.guestRemove') : t('lesson.guestReject')}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="ghost" data-testid="guests-close" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
