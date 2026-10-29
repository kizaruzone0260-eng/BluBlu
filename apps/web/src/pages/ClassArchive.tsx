import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { fmtDateTime, fmtDate } from '../lib/format';
import { FULL_SIDE, THUMB_SIDE, hasInk, renderBoardBlob } from '../lib/boardThumb';
import ErrorScreen from './ErrorScreen';

/**
 * Часть 4 (2026-10-14): архив завершённых уроков класса.
 *
 * Пустое полотно урока living-доской не открывается: архив — это обычные GET-запросы, без сокета
 * и без билета, и страницаExists без live-комнаты. Всё, что здесь решается, решает сервер
 * (`routes/lessonArchive.ts`): права, пагинацию и «что видно ученику» задаёт ответ, а не интерфейс.
 *
 * Миниатюры досок строятся на клиенте из сохранённой сцены и только когда карточка попала в поле
 * зрения: Excalidraw подгружается динамически (`lib/boardThumb.ts`), поэтому чанк архива сам по
 * себе остаётся маленьким.
 */
const BoardExportDialog = lazy(() => import('../components/BoardExportDialog'));

interface Row {
  id: string; startedAt: string; endedAt: string | null; eventId: string | null;
  durationMin: number; boards: number; comments?: number; participants?: number;
}
interface ListBody { items: Row[]; nextCursor: string | null; canManage: boolean }
interface Board {
  pageNo: number; title: string | null; updatedAt: string; bytes: number; elements: unknown[];
}
interface Comment { id: string; text: string; createdAt: string; author: string; pinned: boolean; answered: boolean }
interface Attendee { userId: string; name: string; role: string; joinedAt: string; leftAt: string | null }
interface Detail {
  session: { id: string; classId: string; eventId: string | null; startedAt: string; endedAt: string };
  boards: Board[]; comments?: Comment[]; attendance?: Attendee[]; canManage: boolean;
}
type RawEl = { id: string; isDeleted?: boolean; [k: string]: unknown };

export default function ClassArchive() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const lesson = params.get('lesson') ?? '';
  /** ссылка из календаря: `?event=` — по нему сервер сам находит урок этого события */
  const event = params.get('event') ?? '';

  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before: string | null) => {
    setBusy(true);
    setError('');
    try {
      const q = new URLSearchParams({ limit: '20' });
      if (before) q.set('before', before);
      if (event) q.set('event', event);
      const body = await api<ListBody>(`/api/classes/${id}/lessons/archive?${q.toString()}`);
      setRows((cur) => (before ? [...(cur ?? []), ...body.items] : body.items));
      setCursor(body.nextCursor);
      setCanManage(body.canManage);
      // глубокую ссылку «из события в архив» раскрываем один раз: урок того события
      if (event && !lesson && body.items[0]) {
        const next = new URLSearchParams(params);
        next.delete('event');
        next.set('lesson', body.items[0].id);
        setParams(next, { replace: true });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }, [id, event, lesson, params, setParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(null); }, [id, event]); // eslint-disable-line react-hooks/exhaustive-deps

  if (missing) return <ErrorScreen kind="404" />;

  const remove = async (rowId: string) => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/lessons/${rowId}/archive`, { method: 'DELETE' });
      setRows((cur) => (cur ?? []).filter((r) => r.id !== rowId));
      if (lesson === rowId) {
        const next = new URLSearchParams(params);
        next.delete('lesson');
        setParams(next, { replace: true });
      }
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p><Link to={`/classes/${id}`}>← {t('classes.title')}</Link></p>
      <div className="row" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }} data-testid="archive-title">{t('archive.title')}</h1>
        <div className="spacer" />
        {canManage && <span className="muted" data-testid="archive-manage">{t('archive.teacherView')}</span>}
      </div>
      {error && <p className="error" data-testid="archive-error">{error}</p>}
      {!rows && !error && <p className="muted" data-testid="archive-loading">{t('common.loading')}</p>}
      {rows && rows.length === 0 && (
        <p className="muted" data-testid="archive-empty">{t('archive.empty')}</p>
      )}
      {rows && rows.length > 0 && (
        <table className="archive-table" data-testid="archive-list">
          <thead>
            <tr>
              <th>{t('archive.when')}</th>
              <th>{t('archive.duration')}</th>
              <th>{t('archive.boards')}</th>
              {canManage && <th>{t('archive.comments')}</th>}
              {canManage && <th>{t('archive.participants')}</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid={`archive-row-${r.id.slice(0, 8)}`}>
                <td data-testid={`archive-date-${r.id.slice(0, 8)}`}>{fmtDateTime(r.startedAt, i18n.language)}</td>
                <td>{t('archive.min', { n: r.durationMin })}</td>
                <td data-testid={`archive-boards-count-${r.id.slice(0, 8)}`}>{r.boards}</td>
                {canManage && <td data-testid={`archive-comments-count-${r.id.slice(0, 8)}`}>{r.comments ?? 0}</td>}
                {canManage && <td data-testid={`archive-people-count-${r.id.slice(0, 8)}`}>{r.participants ?? 0}</td>}
                <td className="archive-actions">
                  <button type="button" className="secondary" style={{ marginTop: 0 }}
                    data-testid={`archive-open-${r.id.slice(0, 8)}`}
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.delete('event');
                      next.set('lesson', r.id);
                      setParams(next, { replace: false });
                    }}>{t('archive.open')}
                  </button>
                  {canManage && <ArchiveDelete row={r} onConfirm={() => void remove(r.id)} disabled={busy} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && cursor && (
        <button type="button" className="ghost" style={{ marginTop: 8 }} data-testid="archive-more"
          disabled={busy} onClick={() => void load(cursor)}>
          {t('archive.more')}
        </button>
      )}

      {lesson && (
        <ArchiveEntry
          classId={id} sessionId={lesson}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete('lesson');
            setParams(next, { replace: false });
          }}
        />
      )}
    </div>
  );
}

/** Удаление с подтверждением в самой строке: `window.confirm` блокирует рендер (см. ClassDetail). */
function ArchiveDelete({ row, onConfirm, disabled }: { row: Row; onConfirm: () => void; disabled: boolean }) {
  const { t, i18n } = useTranslation();
  const [ask, setAsk] = useState(false);
  if (!ask) {
    return (
      <button type="button" className="danger" style={{ marginTop: 0 }}
        data-testid={`archive-delete-${row.id.slice(0, 8)}`} disabled={disabled}
        onClick={() => setAsk(true)}>{t('archive.delete')}
      </button>
    );
  }
  return (
    <span className="archive-confirm" role="group" aria-label={t('archive.deleteConfirm')}
      data-testid={`archive-confirm-${row.id.slice(0, 8)}`}>
      <span className="muted">{t('archive.deleteAsk', { date: fmtDate(row.startedAt, i18n.language) })}</span>
      <button type="button" className="danger" style={{ marginTop: 0 }} data-testid="archive-delete-yes"
        disabled={disabled} onClick={onConfirm}>{t('common.delete')}
      </button>
      <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="archive-delete-no"
        onClick={() => setAsk(false)}>{t('common.cancel')}
      </button>
    </span>
  );
}

type EntryTab = 'boards' | 'comments' | 'people';

/** Запись архива: вкладки «Доски» / «Комментарии» / «Участники». Ученику доступна одна вкладка. */
function ArchiveEntry({ classId, sessionId, onClose }: {
  classId: string; sessionId: string; onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<EntryTab>('boards');
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null); setError(''); setMissing(false); setTab('boards');
    void (async () => {
      try {
        const d = await api<Detail>(`/api/lessons/${sessionId}/archive`);
        if (alive) setData(d);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(String((e as Error).message));
      }
    })();
    return () => { alive = false; };
  }, [sessionId]);

  const tabs: { id: EntryTab; label: string; n?: number }[] = data ? [
    { id: 'boards', label: t('archive.boards'), n: data.boards.length },
    ...(data.comments ? [{ id: 'comments' as EntryTab, label: t('archive.comments'), n: data.comments.length }] : []),
    ...(data.attendance ? [{ id: 'people' as EntryTab, label: t('archive.participants'), n: data.attendance.length }] : []),
  ] : [];

  return (
    <section className="card archive-entry" data-testid="archive-entry" aria-label={t('archive.title')}>
      <div className="row">
        <h2 style={{ margin: 0 }} data-testid="archive-entry-when">
          {data ? fmtDateTime(data.session.startedAt, i18n.language) : t('common.loading')}
        </h2>
        <div className="spacer" />
        {data && !data.canManage && <span className="muted">👁 {t('lesson.readonly')}</span>}
        <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="archive-entry-close"
          aria-label={t('common.close')} onClick={onClose}>✕
        </button>
      </div>
      {missing && <p className="muted" data-testid="archive-entry-gone">{t('archive.empty')}</p>}
      {error && <p className="error" data-testid="archive-entry-error">{error}</p>}
      {!data && !error && !missing && <p className="muted">{t('common.loading')}</p>}

      {data && (
        <>
          <div className="panel-tablist" role="tablist" aria-label={t('archive.tabsAria')}>
            {tabs.map((x) => (
              <button key={x.id} type="button" role="tab" className="panel-tab" data-testid={`archive-tab-${x.id}`}
                id={`archive-tabbtn-${x.id}`} aria-controls={`archive-panel-${x.id}`}
                aria-selected={tab === x.id} onClick={() => setTab(x.id)}>
                {x.label}{x.n !== undefined ? ` · ${x.n}` : ''}
              </button>
            ))}
          </div>

          {tab === 'boards' && (
            <div role="tabpanel" id="archive-panel-boards" aria-labelledby="archive-tabbtn-boards" data-testid="archive-boards">
              {data.boards.length === 0 && <p className="muted" data-testid="archive-no-boards">{t('archive.noBoards')}</p>}
              <div className="archive-boards">
                {data.boards.map((b, i) => (
                  <BoardCard key={b.pageNo} board={b} name={boardLabel(t, b, i)} />
                ))}
              </div>
              {/* экспорт учителю: ученику положены доски для просмотра, а не скачивание (часть 1д) */}
              {data.canManage && data.boards.length > 0 && (
                <button type="button" className="secondary" style={{ marginTop: 8 }} data-testid="archive-pdf"
                  onClick={() => setExportOpen(true)}>📄 {t('lesson.boardPdf')}
                </button>
              )}
              {exportOpen && (
                <Suspense fallback={<p className="muted">{t('common.loading')}</p>}>
                  <BoardExportDialog sessionId={sessionId} classId={classId} onClose={() => setExportOpen(false)} />
                </Suspense>
              )}
            </div>
          )}

          {tab === 'comments' && data.comments && (
            <div role="tabpanel" id="archive-panel-comments" aria-labelledby="archive-tabbtn-comments" data-testid="archive-comments">
              {data.comments.length === 0 && <p className="muted">{t('archive.noComments')}</p>}
              <ul className="archive-comments">
                {data.comments.map((c) => (
                  <li key={c.id}>
                    <span className="muted">
                      {c.author} · {fmtDateTime(c.createdAt, i18n.language)}
                      {c.pinned ? ` · ${t('archive.pinned')}` : ''}
                      {c.answered ? ` · ${t('archive.answered')}` : ''}
                    </span>
                    {/* пользовательский текст — простой текстом, не HTML (XSS-тесты фазы 1) */}
                    <p className="archive-comment-text">{c.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === 'people' && data.attendance && (
            <div role="tabpanel" id="archive-panel-people" aria-labelledby="archive-tabbtn-people" data-testid="archive-people">
              {data.attendance.length === 0 && <p className="muted">{t('archive.noPeople')}</p>}
              <table className="archive-table">
                <thead>
                  <tr><th>{t('archive.who')}</th><th>{t('archive.joined')}</th><th>{t('archive.left')}</th></tr>
                </thead>
                <tbody>
                  {data.attendance.map((a) => (
                    <tr key={a.userId} data-testid={`archive-person-${a.userId.slice(0, 8)}`}>
                      <td>{a.name} <span className="muted">{a.role === 'teacher' ? `· ${t('common.roleTeacher')}` : `· ${t('common.roleStudent')}`}</span></td>
                      <td>{fmtDateTime(a.joinedAt, i18n.language)}</td>
                      <td>{a.leftAt ? fmtDateTime(a.leftAt, i18n.language) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Локализованное имя доски: своё имя учителя важнее номера вкладки (как в уроке). */
const boardLabel = (t: (k: string, o?: Record<string, unknown>) => string, b: Board, i: number) =>
  (b.title ?? '').trim() || t('lesson.boardNamed', { n: i + 1 });

/**
 * Карточка доски: миниатюра рисуется, только когда карточка вошла в поле зрения, и ещё раз —
 * в полный размер, когда её раскрыли. Пустую доску не рисуем вовсе.
 */
function BoardCard({ board, name }: { board: Board; name: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  const urls = useRef<string[]>([]);
  const [thumb, setThumb] = useState('');
  const [full, setFull] = useState('');
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const ink = hasInk(board.elements as RawEl[]);

  useEffect(() => () => { for (const u of urls.current) URL.revokeObjectURL(u); urls.current = []; }, []);

  useEffect(() => {
    if (!ink || failed) return;
    const want = open ? FULL_SIDE : THUMB_SIDE;
    if (open ? full : thumb) return;
    const el = ref.current;
    if (!el) return;
    // ждём, пока карточка станет видимой: двадцать досок не должны рисоваться все сразу
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void (async () => {
        try {
          const blob = await renderBoardBlob(board.elements as RawEl[], want, open ? 2 : 1);
          const url = URL.createObjectURL(blob);
          urls.current.push(url);
          (open ? setFull : setThumb)(url);
        } catch {
          setFailed(true);
        }
      })();
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [board, ink, open, thumb, full, failed]);

  const shown = open ? (full || thumb) : thumb;
  return (
    <div className="archive-board" ref={ref} data-testid={`archive-board-${board.pageNo}`}>
      <button type="button" className="archive-board-open" data-testid={`archive-board-open-${board.pageNo}`}
        aria-expanded={open} aria-label={t('archive.openBoard', { name })}
        onClick={() => setOpen((v) => !v)}>
        {shown
          ? <img src={shown} alt="" data-testid={`archive-thumb-${board.pageNo}`}
            loading="lazy" decoding="async"
            className={`archive-thumb${open ? ' archive-thumb-full' : ''}`} />
          : <span className="archive-thumb archive-thumb-empty" data-testid={`archive-thumb-${board.pageNo}`}
            aria-hidden="true" />}
      </button>
      <div className="archive-board-meta">
        <span data-testid={`archive-board-name-${board.pageNo}`}>{name}</span>
        <span className="muted" data-testid={`archive-board-size-${board.pageNo}`}>
          {t('archive.kb', { n: Math.max(1, Math.round(board.bytes / 1024)) })}
        </span>
      </div>
      {!ink && <span className="muted">{t('archive.blank')}</span>}
      {failed && <span className="muted">{t('archive.noThumb')}</span>}
    </div>
  );
}
