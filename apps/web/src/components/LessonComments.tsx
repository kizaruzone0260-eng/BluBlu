import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';

/**
 * Task 2 (2026-10-09) — comments during a lesson.
 *
 * One query (`useLessonComments`) shared by the tab next to «Участники» and by the compact button
 * that stays visible over the full-screen stage: react-query dedupes by key, so both read the
 * same cache and the socket invalidation in Lesson.tsx refreshes both.
 *
 * Text is rendered as a React child, never with dangerouslySetInnerHTML, which is why the server
 * stores it verbatim and the XSS payload stays a string.
 */

export interface LComment {
  id: string; authorId: string; authorName: string; text: string; createdAt: string;
  pinned: boolean; answered: boolean;
}

interface CommentsView {
  comments: LComment[];
  unread: number;
  mode: 'on' | 'off' | 'slow';
  ended: boolean;
  /** the server's answer to «is the person reading this muted for this lesson?» */
  mutedSelf: boolean;
  mutes?: string[];
}

export function useLessonComments(sessionId: string | null, enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['lesson-comments', sessionId],
    queryFn: () => api<CommentsView>(`/api/lessons/${sessionId}/comments`),
    enabled: enabled && Boolean(sessionId),
    refetchInterval: 20_000, // the socket is the fast path; this is the safety net
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['lesson-comments', sessionId] });
  return { q, invalidate };
}

/** the same invalidation the chat page uses for its socket frames */
export function useCommentFrames(sessionId: string | null) {
  const qc = useQueryClient();
  return (type: string) => {
    if (!sessionId) return;
    if (type === 'comment' || type === 'commentDeleted' || type === 'commentPinned'
      || type === 'commentAnswered' || type === 'commentsMode' || type === 'commentMuted') {
      void qc.invalidateQueries({ queryKey: ['lesson-comments', sessionId] });
    }
  };
}

export default function LessonComments({ sessionId, isTeacher, lectureMode, open, onToggle }: {
  sessionId: string; isTeacher: boolean; lectureMode: boolean;
  open: boolean; onToggle: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const { q, invalidate } = useLessonComments(sessionId);
  const [draft, setDraft] = useState('');
  const [errKey, setErrKey] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const view = q.data;
  const unread = view?.unread ?? 0;
  const ended = Boolean(view?.ended);
  const muted = Boolean(view?.mutedSelf);

  /** the server's error key IS the i18n key (`commentRateLimited`, `commentsDisabled`, …) */
  const fail = (e: unknown) => setErrKey((e as ApiError).code ?? 'errorGeneric');

  const send = useMutation({
    mutationFn: (text: string) => api<LComment>(`/api/lessons/${sessionId}/comments`, {
      method: 'POST', body: JSON.stringify({ text }),
    }),
    onSuccess: () => { setDraft(''); setErrKey(''); invalidate(); },
    onError: fail,
  });

  const moderate = useMutation({
    mutationFn: (p: { path: string; body?: unknown; method?: string }) =>
      api(p.path, { method: p.method ?? 'POST', body: p.body ? JSON.stringify(p.body) : undefined }),
    onSuccess: () => { setErrKey(''); invalidate(); },
    onError: fail,
  });

  const ordered = useMemo(() => {
    const list = [...(view?.comments ?? [])];
    // pinned first, then the conversation in the order it happened
    return list.sort((a, b) => (a.pinned === b.pinned ? a.createdAt.localeCompare(b.createdAt) : a.pinned ? -1 : 1));
  }, [view?.comments]);

  /** the teacher's panel is the only place that sees `mutes`, and it is the only one that can change it */
  const mutedAuthor = (authorId: string) => Boolean(view?.mutes?.includes(authorId));

  // a new comment should be visible without the panel being scrolled back down by hand
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ordered.length, open]);

  // opening the panel is a read: the query itself stays mounted (the button is always rendered),
  // so without this the unread badge would only refresh on the 20 s safety poll
  const refetch = q.refetch;
  useEffect(() => { if (open) void refetch(); }, [open, refetch]);

  const canWrite = !ended && view?.mode !== 'off' && !(muted);
  const placeholder = ended ? t('lesson.commentsEnded')
    : view?.mode === 'off' ? t('lesson.commentsOffPlaceholder')
      : muted ? t('lesson.commentsMutedPlaceholder')
        : t('lesson.commentsPlaceholder');

  function submit() {
    const text = draft.trim();
    if (!text || !canWrite) return;
    send.mutate(text.slice(0, 500));
  }

  return (
    <div className="lc-wrap" data-testid="comments-tab">
      <button
        type="button" className={`secondary lc-summary${open ? ' chip-active' : ''}`}
        style={{ marginTop: 0 }} aria-expanded={open} aria-controls="lc-panel"
        data-testid="comments-open" onClick={() => onToggle(!open)}
      >
        💬 {t('lesson.commentsTitle')}
        {unread > 0 && <span className="badge lc-unread" data-testid="comments-unread">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className="lc-panel" id="lc-panel" data-testid="comments-panel">
          <div className="row lc-topbar" style={{ alignItems: 'center' }}>
            <strong>{t('lesson.commentsTitle')}</strong>
            {view?.mode === 'slow' && <span className="badge" data-testid="comments-slow-badge">{t('lesson.commentsSlowMode')}</span>}
            <div className="spacer" />
            {isTeacher && (
              <select
                style={{ width: 'auto', marginTop: 0 }} data-testid="comments-mode"
                aria-label={t('lesson.commentsModeAria')}
                value={view?.mode ?? 'on'}
                onChange={(e) => moderate.mutate({
                  path: `/api/lessons/${sessionId}/comments/mode`, method: 'PUT', body: { mode: e.target.value },
                })}
              >
                <option value="on">{t('lesson.commentsModeOn')}</option>
                <option value="slow">{t('lesson.commentsModeSlow')}</option>
                <option value="off">{t('lesson.commentsModeOff')}</option>
              </select>
            )}
            <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="comments-close"
              aria-label={t('lesson.commentsClose')} onClick={() => onToggle(false)}>✕</button>
          </div>

          {lectureMode && !isTeacher && (
            <p className="banner" role="status" data-testid="comments-lecture-banner">{t('lesson.commentsLectureHint')}</p>
          )}
          {view?.mode === 'off' && isTeacher && (
            <p className="banner" role="status" data-testid="comments-off-banner">{t('lesson.commentsOffBanner')}</p>
          )}

          <div
            className="lc-list" ref={listRef} role="log" aria-live="polite" aria-label={t('lesson.commentsTitle')}
            data-testid="comments-list"
          >
            {ordered.length === 0 && <p className="muted" data-testid="comments-empty">{t('lesson.commentsEmpty')}</p>}
            {ordered.map((c) => (
              <div key={c.id} className={`lc-item${c.pinned ? ' lc-pinned' : ''}${c.answered ? ' lc-answered' : ''}`}
                data-testid={`comment-${c.id}`}>
                <div className="lc-head">
                  <span className="lc-author">{c.authorName}</span>
                  <span className="muted lc-time">{new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {c.pinned && <span aria-label={t('lesson.commentsPinned')} data-testid={`comment-pin-${c.id}`}>📌</span>}
                  {c.answered && <span className="badge" data-testid={`comment-answered-${c.id}`}>{t('lesson.commentsAnswered')}</span>}
                </div>
                {/* a React child, not HTML: the text is never markup */}
                <div className="lc-text" data-testid={`comment-text-${c.id}`}>{c.text}</div>
                <div className="lc-actions">
                  {isTeacher && (
                    <>
                      <button type="button" className="ghost" style={{ marginTop: 0, padding: '2px 6px' }}
                        aria-label={c.pinned ? t('lesson.commentsUnpin') : t('lesson.commentsPin')}
                        title={c.pinned ? t('lesson.commentsUnpin') : t('lesson.commentsPin')}
                        data-testid={`comment-pin-btn-${c.id}`}
                        onClick={() => moderate.mutate({ path: `/api/lessons/${sessionId}/comments/${c.id}/pin`, body: { on: !c.pinned } })}
                      >📌</button>
                      <button type="button" className="ghost" style={{ marginTop: 0, padding: '2px 6px' }}
                        aria-label={t('lesson.commentsMarkAnswered')}
                        title={t('lesson.commentsMarkAnswered')}
                        data-testid={`comment-answer-btn-${c.id}`}
                        onClick={() => moderate.mutate({ path: `/api/lessons/${sessionId}/comments/${c.id}/answered`, body: { on: !c.answered } })}
                      >✓</button>
                      <button type="button" className="ghost" style={{ marginTop: 0, padding: '2px 6px' }}
                        aria-label={mutedAuthor(c.authorId) ? t('lesson.commentsUnmuteStudent') : t('lesson.commentsMuteStudent')}
                        title={mutedAuthor(c.authorId) ? t('lesson.commentsUnmuteStudent') : t('lesson.commentsMuteStudent')}
                        aria-pressed={mutedAuthor(c.authorId)}
                        data-testid={`comment-mute-btn-${c.id}`} data-author={c.authorId}
                        onClick={() => moderate.mutate(mutedAuthor(c.authorId)
                          ? { path: `/api/lessons/${sessionId}/comments/mutes/${c.authorId}`, method: 'DELETE' }
                          : { path: `/api/lessons/${sessionId}/comments/mutes`, body: { userId: c.authorId } })}
                      >{mutedAuthor(c.authorId) ? '🔊' : '🔇'}</button>
                    </>
                  )}
                  {/* anyone can press it; the server decides — a student reaching for another
                      person's comment is answered with the same 404 as a comment that is not here */}
                  {!ended && (
                    <button type="button" className="ghost" style={{ marginTop: 0, padding: '2px 6px' }}
                      aria-label={t('lesson.commentsDelete')} title={t('lesson.commentsDelete')}
                      data-testid={`comment-delete-btn-${c.id}`}
                      onClick={() => moderate.mutate({ path: `/api/lessons/${sessionId}/comments/${c.id}`, method: 'DELETE' })}
                    >🗑</button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {errKey && <p className="error" data-testid="comments-error">{t(`lesson.${errKey}`)}</p>}

          {!ended && (
            <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
              <textarea
                data-testid="comments-input" value={draft} aria-label={t('lesson.commentsTitle')}
                placeholder={placeholder} disabled={!canWrite || send.isPending} rows={2}
                style={{ flex: 1, marginTop: 0, minHeight: 44 }}
                maxLength={500}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
                  if (e.key === 'Escape') { onToggle(false); }
                }}
              />
              <button type="button" data-testid="comments-send" disabled={!canWrite || !draft.trim() || send.isPending}
                onClick={submit}>{t('lesson.commentsSend')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** the compact button that stays over the full-screen stage and the board-as-main-window */
export function CommentsFab({ sessionId, open, onToggle }: {
  sessionId: string; open: boolean; onToggle: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const { q } = useLessonComments(sessionId);
  const unread = q.data?.unread ?? 0;
  // while the panel is open the button is behind it (the drawer and the bottom sheet both cover
  // that corner), and a control you cannot reach is worse than no control: the panel has its own ✕
  if (open) return null;
  return (
    <button
      type="button" className="lc-fab" style={{ marginTop: 0 }}
      data-testid="comments-fab" aria-label={t('lesson.commentsTitle')} aria-expanded={open}
      onClick={() => onToggle(true)}
    >
      💬{unread > 0 && <span className="badge lc-unread" data-testid="comments-fab-unread">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}
