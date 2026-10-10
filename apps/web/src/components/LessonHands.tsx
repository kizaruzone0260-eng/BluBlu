import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';

/**
 * Task 2Б (2026-10-10) — «поднять руку» and the teacher's «дать слово».
 *
 * The queue is deliberately small and boring: a student's button, a teacher's list. What makes it
 * worth its own file is WHO may do WHAT with it:
 *  - a hand is raised for the lesson that is running, by the person themselves — there is no
 *    endpoint that raises or lowers somebody else's hand (a student's DELETE is keyed by their own
 *    id, so another person's row is a 404, not a 403 that leaks);
 *  - «give the floor» is teacher-only, and it does two separate things: it records the fact, and it
 *    asks LiveKit for that ONE participant's permission. The client cannot assume the second part
 *    happened — the server answers 502 when the media server is unreachable and records nothing,
 *    because a floor the student cannot use would be a lie;
 *  - the microphone itself is turned on by the student's own browser (see Lesson.tsx,
 *    `handGranted`): LiveKit refuses a remote unmute (412 "remote unmute not enabled", measured in
 *    CI), and a client-side unmute is also the moment the student consents to being heard.
 */

export interface HandRow {
  userId: string;
  name: string;
  raisedAt: string;
  grantedAt: string | null;
}

interface HandsView {
  hands: HandRow[];
  lectureMode: boolean;
  mine: HandRow | null;
}

export function useHands(sessionId: string | null, enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['lesson-hands', sessionId],
    queryFn: () => api<HandsView>(`/api/lessons/${sessionId}/hands`),
    enabled: enabled && Boolean(sessionId),
    refetchInterval: 20_000, // the socket is the fast path; this is the safety net
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['lesson-hands', sessionId] });
  return { q, invalidate };
}

/** socket invalidation, same shape as the comments panel's */
export function useHandFrames(sessionId: string | null) {
  const qc = useQueryClient();
  return (type: string) => {
    if (!sessionId) return;
    if (type === 'handRaised' || type === 'handLowered' || type === 'handGranted'
      || type === 'handRevoked' || type === 'handsCleared') {
      void qc.invalidateQueries({ queryKey: ['lesson-hands', sessionId] });
    }
  };
}

/** The student's own button. Raising twice is an update, not a duplicate. */
export function RaiseHandButton({ sessionId, raised }: { sessionId: string; raised: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api(`/api/lessons/${sessionId}/hand`, { method: raised ? 'DELETE' : 'POST' }),
    // the socket frame usually arrives first; this only makes the local click feel immediate
    onSettled: () => qc.invalidateQueries({ queryKey: ['lesson-hands', sessionId] }),
  });
  return (
    <button
      className={`secondary${raised ? ' chip-active' : ''}`}
      style={{ marginTop: 0 }}
      data-testid="raise-hand"
      aria-pressed={raised}
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      ✋ {raised ? t('lesson.lowerHand') : t('lesson.raiseHand')}
    </button>
  );
}

/** The teacher's queue: give the floor, take it back, put every hand down at once. */
export default function LessonHands({ sessionId, hands, lectureMode }: {
  sessionId: string; hands: HandRow[]; lectureMode: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (v: { userId: string; on: boolean }) =>
      api(`/api/lessons/${sessionId}/hands/${v.userId}/${v.on ? 'grant' : 'revoke'}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['lesson-hands', sessionId] }),
  });
  const clear = useMutation({
    mutationFn: () => api(`/api/lessons/${sessionId}/hands/lower-all`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['lesson-hands', sessionId] }),
  });
  const granted = hands.filter((h) => h.grantedAt).length;

  return (
    <details className="peers" data-testid="hands-panel">
      <summary>
        ✋ {t('lesson.handsQueue')} · {hands.length}
        {granted > 0 && <span className="muted"> · 🎙 {granted}</span>}
      </summary>
      {hands.length === 0 && <p className="muted" data-testid="hands-empty">{t('lesson.handsNone')}</p>}
      {/* aria-live: the list changes while the teacher is looking at the stage, not at this panel */}
      <div className="hands-list" role="list" aria-live="polite">
        {hands.map((h) => {
          const short = h.userId.slice(0, 8);
          const label = h.grantedAt ? t('lesson.takeFloor') : t('lesson.giveFloor');
          return (
            <div key={h.userId} className="peer-row" data-testid={`hand-row-${short}`}>
              <span className="peer-name">{h.name}</span>
              {h.grantedAt && <span title={t('lesson.floorGiven')}>🎙</span>}
              {lectureMode && !h.grantedAt && <span className="muted" title={t('lesson.lectureOn')}>🔇</span>}
              {/*
                One button, two states, and a real accessible name: its text is an emoji, so without
                `aria-label` a screen reader would announce «🎙+» as the name of the control that
                hands somebody the microphone. The testid changes with the state for the same reason
                the label does — a test that clicked `hand-grant-*` twice would assert nothing.
              */}
              <button
                className="ghost" style={{ marginTop: 0, padding: '2px 6px' }}
                data-testid={`${h.grantedAt ? 'hand-revoke' : 'hand-grant'}-${short}`}
                aria-label={label} title={label}
                disabled={act.isPending}
                onClick={() => act.mutate({ userId: h.userId, on: !h.grantedAt })}
              >
                {h.grantedAt ? '⬇' : '🎙+'}
              </button>
            </div>
          );
        })}
      </div>
      {hands.length > 0 && (
        <button
          className="secondary" style={{ marginTop: 6 }} data-testid="hands-lower-all"
          disabled={clear.isPending} onClick={() => clear.mutate()}
        >
          {t('lesson.lowerAllHands')}
        </button>
      )}
    </details>
  );
}
