import { useTranslation } from 'react-i18next';
import { HandsQueue } from './LessonHands';
import { CommentsPanel } from './LessonComments';
import type { HandRow } from './LessonHands';

/**
 * Правая панель урока (задача 2026-10-10): вкладки «Участники» и «Комментарии».
 *
 * Здесь живут ВСЕ списки и действия модерации — раньше они были отдельными кнопками и
 * плавающими блоками над видео. Порядок внутри вкладки «Участники» именно такой, как в
 * списке дел: сначала поднятые руки (сразу «Дать слово» / «Опустить»), потом сами участники с
 * индикаторами микрофона и камеры, потом внизу ряд учителя — «Выключить всем звук», режим
 * лекции и «Опустить все руки».
 *
 * Панель ничего не решает: права проверяет сервер, здесь только видимость кнопок.
 */

export type PanelTab = 'people' | 'comments';

export interface PeerRow {
  identity: string; name: string; micOn: boolean; camOn: boolean; screenOn: boolean;
  /** часть 3: рисует ли этот ученик на доске прямо сейчас */
  canDraw?: boolean;
}

export default function LessonPanel({ tab, onTab, onClose, sessionId, isTeacher, lectureMode,
  muteAll, peers, hands, unread, onMuteOne, onScreen, onKick, onMuteAll, onLecture,
  drawAll, onDraw, onDrawAll, comments }: {
  tab: PanelTab; onTab: (t: PanelTab) => void; onClose: () => void;
  sessionId: string; isTeacher: boolean; lectureMode: boolean; muteAll: boolean;
  peers: PeerRow[]; hands: HandRow[]; unread: number;
  onMuteOne: (identity: string) => void; onScreen: (identity: string, allow: boolean) => void;
  onKick: (identity: string) => void; onMuteAll: () => void; onLecture: () => void;
  drawAll: boolean; onDraw: (identity: string, allow: boolean) => void; onDrawAll: () => void;
  comments: { isTeacher: boolean; lectureMode: boolean };
}) {
  const { t } = useTranslation();
  const tabs: { id: PanelTab; label: string; icon: string; badge?: number }[] = [
    { id: 'people', label: t('lesson.peersTitle'), icon: '👥', badge: hands.length },
    { id: 'comments', label: t('lesson.commentsTitle'), icon: '💬', badge: unread },
  ];

  return (
    <aside className="side-panel" data-testid="side-panel" aria-label={t('lesson.peersTitle')}>
      <div className="panel-tabs">
        {/* role=tablist принимает только вкладки — кнопка закрытия живёт рядом, но не внутри него */}
        <div className="panel-tablist" role="tablist" aria-label={t('lesson.barAria')}>
          {tabs.map((x) => (
            <button key={x.id} type="button" role="tab" id={`tab-${x.id}`} aria-selected={tab === x.id}
              aria-controls={`panel-${x.id}`} className="panel-tab" data-testid={`tab-${x.id}`}
              onClick={() => onTab(x.id)}>
              <span aria-hidden="true">{x.icon}</span> {x.label}
              {x.badge ? <span className="bar-badge" data-testid={`tab-badge-${x.id}`}>{x.badge > 99 ? '99+' : x.badge}</span> : null}
            </button>
          ))}
        </div>
        <button type="button" className="panel-tab panel-tab-close" data-testid="panel-close"
          aria-label={t('lesson.menuClose')}
          onClick={onClose}>✕</button>
      </div>

      {tab === 'people' && (
        <div className="panel-body" role="tabpanel" id="panel-people" aria-labelledby="tab-people" data-testid="peers-panel">
          <HandsQueue sessionId={sessionId} hands={hands} lectureMode={lectureMode} isTeacher={isTeacher} />
          <div className="panel-section">
            <div className="panel-section-title">👥 {t('lesson.peersTitle')} · {peers.length}</div>
            {peers.length === 0 && <p className="muted" data-testid="waiting-peers">{t('lesson.noStudentsYet')}</p>}
            {peers.map((p) => (
              <div key={p.identity} className="peer-row" data-testid={`peer-${p.identity.slice(0, 8)}`}>
                <span className="peer-name">{p.name}</span>
                <span title={t('lesson.toggleMic')} aria-label={t('lesson.toggleMic')}>{p.micOn ? '🎙' : '🔇'}</span>
                <span title={t('lesson.toggleCamera')} aria-label={t('lesson.toggleCamera')}>{p.camOn ? '📹' : '·'}</span>
                {p.screenOn && <span aria-label={t('lesson.shareScreen')}>🖥</span>}
                {isTeacher && (
                  <>
                    <button className="ghost" style={{ marginTop: 0, padding: '2px 6px' }}
                      aria-label={t('lesson.muteOne')} title={t('lesson.muteOne')}
                      data-testid={`peer-mute-${p.identity.slice(0, 8)}`}
                      onClick={() => onMuteOne(p.identity)}>🔇
                    </button>
                    <button className="ghost" style={{ marginTop: 0, padding: '2px 6px' }}
                      aria-label={t('lesson.allowScreenPeer')} title={t('lesson.allowScreenPeer')}
                      aria-pressed={p.screenOn}
                      data-testid={`peer-screen-${p.identity.slice(0, 8)}`}
                      onClick={() => onScreen(p.identity, !p.screenOn)}>🖥+
                    </button>
                    <button className="ghost" style={{ marginTop: 0, padding: '2px 6px' }}
                      aria-label={t('lesson.boardDrawToggle')} title={t('lesson.boardDrawToggle')}
                      aria-pressed={!!p.canDraw}
                      data-testid={`peer-draw-${p.identity.slice(0, 8)}`}
                      onClick={() => onDraw(p.identity, !p.canDraw)}>✏️
                    </button>
                    <button className="ghost" style={{ marginTop: 0, padding: '2px 6px' }}
                      aria-label={t('lesson.kickPeer')} title={t('lesson.kickPeer')}
                      data-testid={`peer-kick-${p.identity.slice(0, 8)}`}
                      onClick={() => onKick(p.identity)}>✕
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          {isTeacher && (
            <div className="panel-foot" data-testid="teacher-actions">
              <button type="button" className={`bar-item${muteAll ? ' bar-active' : ''}`} data-testid="mute-all"
                aria-pressed={muteAll} disabled={peers.length === 0}
                title={peers.length === 0 ? t('lesson.noStudentsYet') : undefined}
                onClick={onMuteAll}>
                🔇 {muteAll ? t('lesson.unmuteAll') : t('lesson.muteAll')}
              </button>
              <button type="button" className={`bar-item${lectureMode ? ' bar-active' : ''}`} data-testid="panel-lecture"
                aria-pressed={lectureMode} onClick={onLecture}>
                🎓 {lectureMode ? t('lesson.lectureOn') : t('lesson.lectureMode')}
              </button>
              {/* часть 3: «разрешить всем» — тот же охват, что у «выключить всем»: и для тех,
                  кто придёт после нажатия (право живёт на сессии, а не у конкретных сокетов) */}
              <button type="button" className={`bar-item${drawAll ? ' bar-active' : ''}`} data-testid="panel-draw-all"
                aria-pressed={drawAll} onClick={onDrawAll}>
                ✏️ {drawAll ? t('lesson.boardDrawAllOff') : t('lesson.boardDrawAll')}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'comments' && (
        <div className="panel-body" role="tabpanel" id="panel-comments" aria-labelledby="tab-comments" data-testid="comments-panel">
          <CommentsPanel
            sessionId={sessionId} isTeacher={comments.isTeacher} lectureMode={comments.lectureMode}
            onClose={onClose}
          />
        </div>
      )}
    </aside>
  );
}
