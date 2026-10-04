import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useChatUnread } from '../lib/chat';
import { fmtDateTime } from '../lib/format';
import { useAuth } from '../App';

interface Msg { id: string; authorId: string; authorName: string; text: string; createdAt: string }

/** item 8 — «Чат»: one shared thread per class, members only. */

export function ChatList() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const summary = useChatUnread();
  if (me?.role !== 'teacher' && me?.role !== 'student') return <p className="error">{t('common.errorGeneric')}</p>;
  const rows = summary.data ?? [];
  return (
    <div>
      <h1>{t('chat.title')}</h1>
      {rows.length === 0 && !summary.isPending && (
        <div className="empty-state card">
          <div className="big">💬</div>
          <p>{t('chat.noChats')}</p>
        </div>
      )}
      {rows.map((s) => (
        <Link key={s.classId} to={`/chat/${s.classId}`} className="card" style={{ display: 'block', color: 'var(--text)' }} data-testid="chat-item">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <strong>{s.name}</strong>
            <div className="spacer" />
            {s.unread > 0 && <span className="badge chat-unread" data-testid={`chat-unread-${s.classId}`}>{s.unread > 99 ? '99+' : s.unread}</span>}
          </div>
          <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.lastMessage
              ? `${s.lastAuthor ?? ''}: ${s.lastMessage}`
              : t('chat.empty')}
          </div>
        </Link>
      ))}
    </div>
  );
}

export default function ChatRoom() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<{ messages: Msg[]; hasMore: boolean }>({ messages: [], hasMore: false });
  const [older, setOlder] = useState<{ messages: Msg[]; hasMore: boolean }[]>([]);

  const summaries = useChatUnread();
  const meta = (summaries.data ?? []).find((s) => s.classId === id) ?? null;

  const latest = useQuery({
    queryKey: ['chat-latest', id],
    queryFn: () => api<{ messages: Msg[]; hasMore: boolean }>(`/api/classes/${id}/chat/messages?limit=30`),
    enabled: Boolean(id),
    refetchInterval: 30_000, // belt-and-braces if the socket is down
  });

  // reset the older-pages stack when the class changes
  useEffect(() => { pagesRef.current = { messages: [], hasMore: false }; setOlder([]); setBefore(null); }, [id]);

  const loadEarlier = useMutation({
    mutationFn: async () => {
      const list = latest.data?.messages ?? [];
      const cursor = before ?? (list[0]?.createdAt ?? new Date().toISOString());
      const page = await api<{ messages: Msg[]; hasMore: boolean }>(
        `/api/classes/${id}/chat/messages?limit=30&before=${encodeURIComponent(cursor)}`);
      return page;
    },
    onSuccess: (page) => {
      setBefore(page.messages[0]?.createdAt ?? before);
      setOlder((prev) => [...prev, page]);
    },
  });

  const send = useMutation({
    mutationFn: (text: string) => api<Msg>(`/api/classes/${id}/chat/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
    onSuccess: () => {
      setDraft(''); setError('');
      void qc.invalidateQueries({ queryKey: ['chat-latest', id] });
      void qc.invalidateQueries({ queryKey: ['chat-summary'] });
    },
    onError: (e: { code?: string }) => {
      const map: Record<string, string> = {
        chatEmpty: t('chat.errorEmpty'), chatDisabled: t('chat.errorDisabled'),
        chatAnnounceOnly: t('chat.errorAnnounce'), chatMuted: t('chat.errorMuted'),
        chatRateLimited: t('chat.errorRate'), invalidInput: t('chat.errorTooLong'),
      };
      setError(map[e.code ?? ''] ?? t('common.errorGeneric'));
    },
  });

  const del = useMutation({
    mutationFn: (msgId: string) => api(`/api/classes/${id}/chat/messages/${msgId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat-latest', id] });
      void qc.invalidateQueries({ queryKey: ['chat-summary'] });
    },
  });

  const mute = useMutation({
    mutationFn: (p: { userId: string; until: string | null }) =>
      api(`/api/classes/${id}/chat/mutes`, { method: 'POST', body: JSON.stringify(p) }),
    onSuccess: () => void latest.refetch(),
  });

  // ── realtime socket: one-time ticket, fresh on every (re)connect ───────────
  useEffect(() => {
    if (!id || !me) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let attempt = 0;
    const connect = async () => {
      try {
        const { ticket } = await api<{ ticket: string }>(`/api/classes/${id}/chat/ticket`, { method: 'POST' });
        if (disposed) return;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${location.host}/api/ws/chat/${id}?ticket=${encodeURIComponent(ticket)}`);
        ws.onopen = () => { attempt = 0; setConnected(true); };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data as string) as { type: string; message?: Msg; messageId?: string };
            if (msg.type === 'message' && msg.message) {
              void qc.invalidateQueries({ queryKey: ['chat-latest', id] });
              void qc.invalidateQueries({ queryKey: ['chat-summary'] });
            }
            if (msg.type === 'deleted') void qc.invalidateQueries({ queryKey: ['chat-latest', id] });
          } catch { /* ignore malformed frames */ }
        };
        ws.onclose = (ev) => {
          setConnected(false);
          if (disposed || ev.code === 4404) return;
          attempt++;
          timer = window.setTimeout(() => void connect(), Math.min(1000 * 2 ** (attempt - 1), 10_000));
        };
        ws.onerror = () => { /* close follows */ };
      } catch {
        if (!disposed) {
          attempt++;
          timer = window.setTimeout(() => void connect(), Math.min(1000 * 2 ** attempt, 10_000));
        }
      }
    };
    void connect();
    return () => { disposed = true; clearTimeout(timer); try { ws?.close(); } catch { /* already closed */ } };
  }, [id, me, qc]);

  const scrollBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, []);
  useEffect(() => { scrollBottom(); }, [latest.data, older.length, scrollBottom]);

  const flat = [...older.flatMap((p) => p.messages), ...(latest.data?.messages ?? [])];
  const seen = new Set<string>();
  const messages = flat.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  const hasMore = (latest.data?.hasMore ?? false) || (older[older.length - 1]?.hasMore ?? false);
  const isTeacher = me?.role === 'teacher';
  const canPost = isTeacher ? meta?.chatMode !== 'off' : meta?.chatMode === 'on';

  return (
    <div className="chat-room">
      <div className="row" style={{ alignItems: 'center' }}>
        <Link to="/chat" className="ghost" style={{ marginTop: 0 }}>← {t('chat.back')}</Link>
        <strong style={{ marginLeft: 8 }}>{meta?.name ?? t('chat.title')}</strong>
        <div className="spacer" />
        <span className="muted" data-testid="chat-conn">{connected ? t('chat.online') : t('chat.reconnecting')}</span>
      </div>

      <div className="chat-thread card" data-testid="chat-thread" role="log" aria-live="polite">
        {hasMore && (
          <button className="secondary" style={{ margin: '0 auto 10px', display: 'block' }} data-testid="chat-earlier"
            onClick={() => loadEarlier.mutate()} disabled={loadEarlier.isPending}>{t('chat.loadEarlier')}</button>
        )}
        {messages.length === 0 && !latest.isPending && <p className="muted" style={{ textAlign: 'center' }}>{t('chat.empty')}</p>}
        {messages.map((m) => {
          const mine = m.authorId === me?.id;
          return (
            <div key={m.id} className={mine ? 'chat-msg mine' : 'chat-msg'} data-testid="chat-msg">
              <div className="chat-msg-head">
                <strong>{mine ? t('chat.you') : m.authorName}</strong>
                <span className="muted">{fmtDateTime(m.createdAt, i18n.language)}</span>
                {(mine || isTeacher) && (
                  <button className="ghost danger-text" style={{ marginTop: 0, padding: 2 }} data-testid="chat-del"
                    aria-label={t('common.delete')}
                    onClick={() => { if (window.confirm(t('chat.deleteConfirm'))) del.mutate(m.id); }}>✕</button>
                )}
                {isTeacher && !mine && (
                  <button className="ghost" style={{ marginTop: 0, padding: 2 }} data-testid="chat-mute"
                    aria-label={t('chat.mute')}
                    onClick={() => {
                      // 0/empty ⇒ forever, otherwise N minutes (item 8: temp or permanent)
                      const v = window.prompt(t('chat.muteAsk'), '10');
                      if (v === null) return;
                      const mins = Number(v);
                      const until = Number.isFinite(mins) && mins > 0
                        ? new Date(Date.now() + mins * 60_000).toISOString()
                        : null;
                      mute.mutate({ userId: m.authorId, until });
                    }}>🔇</button>
                )}
              </div>
              {/* plain text — React escapes; chat never renders HTML (XSS-safe by construction) */}
              <div className="chat-msg-text">{m.text}</div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="error" data-testid="chat-error">{error}</p>}
      {meta && !canPost && (
        <p className="muted" data-testid="chat-locked">
          {meta.chatMode === 'off' ? t('chat.disabled') : t('chat.announceNote')}
        </p>
      )}
      <form
        className="row"
        style={{ alignItems: 'flex-end', gap: 8 }}
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) send.mutate(draft.trim()); }}
      >
        <label className="sr-only" htmlFor="chat-input">{t('chat.placeholder')}</label>
        <textarea
          id="chat-input" data-testid="chat-input" rows={2} value={draft} maxLength={2000}
          placeholder={t('chat.placeholder')} disabled={!canPost || send.isPending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (draft.trim()) send.mutate(draft.trim()); } }}
          style={{ flex: 1, resize: 'vertical' }}
        />
        <button type="submit" data-testid="chat-send" disabled={!draft.trim() || !canPost || send.isPending} style={{ marginTop: 0 }}>
          {t('chat.send')}
        </button>
      </form>
    </div>
  );
}
