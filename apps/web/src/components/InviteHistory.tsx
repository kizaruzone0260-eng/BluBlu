import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';

/**
 * История приглашений класса (задача 2026-10-24, часть B) — отдельное окно, закрытое по умолчанию.
 *
 * Зачем унесли из карточки: карточка «Добавить ученика» — это место действия (создать ссылку,
 * скопировать, отправить), и учитель открывает её каждый урок. История — место разбора («кто вошёл
 * и когда»), и она занимала на главном экране класса больше места, чем само действие. Это чисто
 * презентационное решение: ни одна запись не удаляется, ни одна активная ссылка не гаснет, API и
 * права не тронуты — тот же `GET /api/classes/:id/invitations`, те же `usedByName` и `usedAt`.
 *
 * Данные приходят ТОЛЬКО когда окно открыто (`enabled: open`): раньше список класса тянул историю
 * на каждый рендер экрана, и это был лишний запрос к таблице приглашений при каждом посещении.
 *
 * Узкий экран: здесь не `<table>`, а список строк. Таблица на 390 px либо резала колонки, либо
 * заставляла экран скроллить по горизонтали — см. требование «нет горизонтального скролла»; ширина
 * здесь следует за содержимым, а не наоборот.
 */
interface InviteRow {
  id: string;
  kind: 'code' | 'link';
  label: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  usedByName: string | null;
  status: 'active' | 'used' | 'expired' | 'revoked';
}

export default function InviteHistory({ classId, open, onClose }: {
  classId: string; open: boolean; onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // кнопка, которая открыла окно: после закрытия фокус обязан вернуться к ней, а не исчезнуть
  const openerRef = useRef<Element | null>(null);

  const rows = useQuery({
    queryKey: ['invitations', classId],
    queryFn: () => api<InviteRow[]>(`/api/classes/${classId}/invitations`),
    enabled: open,
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) => api(`/api/classes/${classId}/invites/${inviteId}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invitations', classId] });
      void qc.invalidateQueries({ queryKey: ['invites', classId] });
    },
  });

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // возвращаем фокус туда, откуда пришли: закрыл — продолжил работу с того же места
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal invite-history" role="dialog" aria-modal="true"
        aria-labelledby="invite-history-title" data-testid="invite-history"
        onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <h2 id="invite-history-title" className="modal-title" style={{ marginRight: 'auto' }}>
            {t('classes.inviteHistory')}
          </h2>
          <button type="button" ref={closeRef} className="ghost" style={{ marginTop: 0 }}
            data-testid="invite-history-close" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        <p className="muted" style={{ fontSize: '.85rem', marginTop: 0 }}>{t('classes.inviteHistoryHint')}</p>

        {rows.isPending && <p className="muted" role="status" data-testid="invite-history-loading">{t('common.loading')}</p>}
        {rows.isError && (
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <p className="error" role="alert" data-testid="invite-history-error" style={{ margin: 0 }}>
              {t('classes.inviteHistoryError')}
            </p>
            <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="invite-history-retry"
              onClick={() => void rows.refetch()}>
              {t('classes.inviteHistoryRetry')}
            </button>
          </div>
        )}
        {rows.isSuccess && rows.data.length === 0 && (
          <p className="muted" data-testid="invite-history-empty">{t('classes.inviteHistoryEmpty')}</p>
        )}

        {(rows.data ?? []).map((r) => (
          <div className="invite-record" key={r.id} data-testid={`invite-record-${r.id}`}
            data-status={r.status} data-kind={r.kind}>
            <div className="invite-record__head">
              <span className={`badge ${r.status}`} data-testid={`invite-status-${r.id}`}>
                {t(`classes.invite.${r.status}`)}
              </span>
              <span className="invite-record__kind" data-testid={`invite-kind-${r.id}`}>
                {t(r.kind === 'link' ? 'classes.invite.kindLink' : 'classes.invite.kindCode')}
              </span>
              <span className="invite-record__label" data-testid={`invite-label-${r.id}`}>
                {r.label || t('classes.inviteHistoryNoLabel')}
              </span>
              {r.status === 'active' && (
                <button type="button" className="danger" style={{ marginTop: 0 }} data-testid={`invite-revoke-${r.id}`}
                  disabled={revoke.isPending}
                  onClick={() => {
                    if (window.confirm(t(r.kind === 'link' ? 'classes.invite.revokeConfirm' : 'classes.invite.revokeCodeConfirm'))) {
                      revoke.mutate(r.id);
                    }
                  }}>
                  {t('classes.invite.revoke')}
                </button>
              )}
            </div>
            <dl className="invite-record__facts">
              <div>
                <dt>{t('classes.invite.created')}</dt>
                <dd data-testid={`invite-created-${r.id}`}>{fmtDate(r.createdAt, i18n.language)}</dd>
              </div>
              <div>
                <dt>{t('classes.invite.expires')}</dt>
                <dd data-testid={`invite-expires-${r.id}`}>{fmtDateTime(r.expiresAt, i18n.language)}</dd>
              </div>
              <div>
                <dt>{t('classes.inviteHistoryWho')}</dt>
                <dd data-testid={`invite-used-by-${r.id}`}>
                  {/* ровно два факта, которые и нужны учителю: КТО вошёл и КОГДА именно; почта
                      ученика здесь не показывается — она есть в списке учеников класса */}
                  {r.usedByName
                    ? `${r.usedByName}${r.usedAt ? ` · ${fmtDateTime(r.usedAt, i18n.language)}` : ''}`
                    : t('classes.inviteHistoryNobody')}
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
