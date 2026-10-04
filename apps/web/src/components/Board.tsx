import { useEffect, useRef, useState } from 'react';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useTranslation } from 'react-i18next';
import { api, getToken, wsTicket } from '../lib/api';
import { useAuth } from '../App';

type Api = NonNullable<Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['excalidrawAPI']>>[0]>;

interface RawEl { id: string; version: number; versionNonce: number; isDeleted?: boolean; [k: string]: unknown }

/**
 * §3.7 whiteboard: teacher draws, students are view-only. The client only ever
 * sends edits when canEdit, and the SERVER ignores non-teacher writes anyway.
 * Changes are sent as deltas (id/version/versionNonce) throttled to ~30 ms.
 */
export default function Board({ sessionId, height = '60vh' }: { sessionId: string; height?: string }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [canEdit, setCanEdit] = useState(false);
  const [pages, setPages] = useState<number[]>([1]);
  const [current, setCurrentPage] = useState(1);
  const [error, setError] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const apiRef = useRef<Api | null>(null);
  const sentRef = useRef<Map<string, { version: number; versionNonce: number }>>(new Map());
  const lastSentRef = useRef(0);

  useEffect(() => {
    const token = getToken();
    if (!token || !me) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    const connect = async () => {
      if (disposed) return;
      try {
        const ticket = await wsTicket(sessionId); // one-time ticket — fresh on every reconnect
        if (disposed) return;
        ws = new WebSocket(`ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/api/ws/board/${sessionId}?ticket=${encodeURIComponent(ticket)}`);
        wsRef.current = ws;
        ws.onopen = () => { attempt = 0; };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data as string) as {
            type: string; canEdit?: boolean; page?: number; pages?: number[]; elements?: RawEl[];
          };
          if (msg.type === 'init') {
            setCanEdit(!!msg.canEdit);
            setPages(msg.pages ?? [1]);
            setCurrentPage(msg.page ?? 1);
            sentRef.current.clear();
            replaceScene(msg.elements ?? []);
          } else if (msg.type === 'edits') {
            mergeIncoming(msg.elements ?? []);
          } else if (msg.type === 'current') {
            setCurrentPage(msg.page ?? 1);
            sentRef.current.clear();
            replaceScene(msg.elements ?? []);
          } else if (msg.type === 'pages') {
            setPages(msg.pages ?? [1]);
            setCurrentPage(msg.page ?? msg.pages?.[0] ?? 1);
          }
        };
        ws.onclose = (ev) => {
          if (disposed) return;
          if (ev.code === 4404) return; // session gone — lesson status WS clears the page
          attempt++; // dropped connection (render restart, wifi blip, expired ticket) → reconnect
          retryTimer = window.setTimeout(() => void connect(), Math.min(1000 * 2 ** (attempt - 1), 10_000));
        };
      } catch {
        if (!disposed) {
          attempt++;
          retryTimer = window.setTimeout(() => void connect(), Math.min(1000 * 2 ** (attempt - 1), 10_000));
        }
      }
    };
    void connect();
    return () => { disposed = true; window.clearTimeout(retryTimer); ws?.close(); };
  }, [sessionId, me]);

  function replaceScene(elements: RawEl[]) {
    apiRef.current?.updateScene({ elements: elements as never });
  }

  function mergeIncoming(incoming: RawEl[]) {
    const a = apiRef.current;
    if (!a) return;
    const byId = new Map<string, RawEl>((a.getSceneElements() as unknown as RawEl[]).map((e) => [e.id, e]));
    let changed = false;
    for (const el of incoming) {
      const cur = byId.get(el.id);
      if (!cur || el.version > cur.version || (el.version === cur.version && el.versionNonce > cur.versionNonce)) {
        if (el.isDeleted) byId.delete(el.id);
        else byId.set(el.id, el);
        changed = true;
      }
    }
    if (changed) a.updateScene({ elements: [...byId.values()] as never });
  }

  function onChange(elements: readonly RawEl[]) {
    if (!canEdit) return;
    const now = Date.now();
    if (now - lastSentRef.current < 30) return; // §3.7 throttle ≈30 ms
    lastSentRef.current = now;
    const changed: RawEl[] = [];
    for (const el of elements) {
      const prev = sentRef.current.get(el.id);
      if (!prev || prev.version !== el.version || prev.versionNonce !== el.versionNonce) {
        changed.push(el);
        sentRef.current.set(el.id, { version: el.version, versionNonce: el.versionNonce });
      }
    }
    if (changed.length && wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'edits', page: current, elements: changed }));
    }
  }

  const send = (msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(msg));
  };

  async function publishAs(kind: 'png' | 'svg') {
    const a = apiRef.current;
    if (!a) return;
    try {
      const blob = await exportToBlob({
        elements: a.getSceneElements(),
        appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false } as never,
        files: a.getFiles(),
        mimeType: kind === 'png' ? 'image/png' : 'image/svg+xml',
      });
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error('export failed'));
        fr.readAsDataURL(blob);
      });
      await api(`/api/lessons/${sessionId}/board/publish`, {
        method: 'POST', body: JSON.stringify({ dataUrl, kind, title: `${t('lesson.board')} ${current}` }),
      });
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  return (
    <div className="card" data-testid="board">
      <div className="row">
        <h2 style={{ margin: 0 }}>{t('lesson.board')}</h2>
        {canEdit ? (
          <>
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => send({ type: 'newpage' })}>+ {t('lesson.page')}</button>
            {pages.map((p) => (
              <button key={p} className={p === current ? '' : 'secondary'} style={{ marginTop: 0 }}
                onClick={() => send({ type: 'switch', page: p })}>{p}</button>
            ))}
            {pages.length > 1 && (
              <button className="danger" style={{ marginTop: 0 }} onClick={() => send({ type: 'delpage', page: current })}>✕</button>
            )}
            <div className="spacer" />
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => void publishAs('png')}>→ PNG</button>
            <button className="secondary" style={{ marginTop: 0 }} onClick={() => void publishAs('svg')}>→ SVG</button>
          </>
        ) : <span className="muted">👁 {t('lesson.readonly')}</span>}
      </div>
      {error && <p className="error">{error}</p>}
      <div style={{ height }}>
        <Excalidraw
          viewModeEnabled={!canEdit}
          zenModeEnabled={!canEdit}
          gridModeEnabled={false}
          excalidrawAPI={(a) => { apiRef.current = a; }}
          onChange={(elements) => onChange(elements as unknown as RawEl[])}
          initialData={{ elements: [], appState: { viewModeEnabled: !canEdit }, scrollToContent: false }}
        />
      </div>
    </div>
  );
}
