import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { replySnippet, type ReplyRef } from '@klass/shared';
import { api } from '../lib/api';
import { useChatUnread } from '../lib/chat';
import { fmtDateTime } from '../lib/format';
import { useAuth } from '../App';
import { usePopover } from '../lib/popover';

interface Msg {
  id: string; authorId: string; authorName: string; text: string; createdAt: string; editedAt: string | null;
  /** reply task 2: the message this one quotes, or null */
  replyTo: ReplyRef | null;
}

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
  // item 7 — per-message action menu (⋯), inline editor and the copy toast
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const menuPop = usePopover({ open: menuFor !== null, anchor: menuAnchor, align: 'end', onClose: () => setMenuFor(null) });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);
  const pressTimer = useRef<number | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<{ messages: Msg[]; hasMore: boolean }>({ messages: [], hasMore: false });
  const [older, setOlder] = useState<{ messages: Msg[]; hasMore: boolean }[]>([]);
  // ── reply task 2 (2026-10-08) ──
  /** the message the draft answers; local only, cleared on send / Esc / ✕ */
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  /** set while a quote's original is briefly highlighted */
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  /** true between «клик по цитате» and its highlight: the pin-to-bottom effect stands down */
  const revealPending = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** one touch-swipe gesture per pointer down, so a swipe cannot fire twice */
  const swipe = useRef<{ id: string; x: number; y: number; done: boolean } | null>(null);

  const summaries = useChatUnread();
  const meta = (summaries.data ?? []).find((s) => s.classId === id) ?? null;

  const latest = useQuery({
    queryKey: ['chat-latest', id],
    queryFn: () => api<{ messages: Msg[]; hasMore: boolean }>(`/api/classes/${id}/chat/messages?limit=30`),
    enabled: Boolean(id),
    refetchInterval: 30_000, // belt-and-braces if the socket is down
  });

  // reset the older-pages stack when the class changes
  useEffect(() => {
    pagesRef.current = { messages: [], hasMore: false }; setOlder([]); setBefore(null);
    revealPending.current = false;
  }, [id]);

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
      // PREPEND: every page fetched here is older than everything already stacked, and the thread
      // renders `older` in array order. With one page the old append looked right; clicking a
      // quote (which can load several pages) would have shown the second-oldest page last.
      setOlder((prev) => [page, ...prev]);
    },
  });

  const mapErr = (code?: string) => {
    const map: Record<string, string> = {
      chatEmpty: t('chat.errorEmpty'), chatDisabled: t('chat.errorDisabled'),
      chatAnnounceOnly: t('chat.errorAnnounce'), chatMuted: t('chat.errorMuted'),
      chatRateLimited: t('chat.errorRate'), invalidInput: t('chat.errorTooLong'),
    };
    return map[code ?? ''] ?? t('common.errorGeneric');
  };

  const send = useMutation({
    mutationFn: (text: string) => api<Msg>(`/api/classes/${id}/chat/messages`, {
      // reply task 2: the id only — the server validates it and builds the snippet itself
      method: 'POST', body: JSON.stringify({ text, ...(replyTo ? { replyToId: replyTo.id } : {}) }),
    }),
    onSuccess: () => {
      setDraft(''); setReplyTo(null); setError('');
      void qc.invalidateQueries({ queryKey: ['chat-latest', id] });
      void qc.invalidateQueries({ queryKey: ['chat-summary'] });
    },
    onError: (e: { code?: string }) => setError(mapErr(e.code)),
  });

  const edit = useMutation({
    mutationFn: (p: { msgId: string; text: string }) =>
      api<Msg>(`/api/classes/${id}/chat/messages/${p.msgId}`, { method: 'PATCH', body: JSON.stringify({ text: p.text }) }),
    onSuccess: () => { setEditingId(null); setError(''); void qc.invalidateQueries({ queryKey: ['chat-latest', id] }); },
    onError: (e: { code?: string }) => setError(mapErr(e.code)),
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
        // «в сети» only after the server's ready frame: the hub joins the room
        // before sending it, so a green badge really means broadcasts will reach us
        ws.onopen = () => { attempt = 0; };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data as string) as { type: string; message?: Msg; messageId?: string };
            if (msg.type === 'ready') setConnected(true);
            if (msg.type === 'message' && msg.message) {
              void qc.invalidateQueries({ queryKey: ['chat-latest', id] });
              void qc.invalidateQueries({ queryKey: ['chat-summary'] });
            }
            if (msg.type === 'deleted') void qc.invalidateQueries({ queryKey: ['chat-latest', id] });
            if (msg.type === 'edited') void qc.invalidateQueries({ queryKey: ['chat-latest', id] });
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
  useEffect(() => {
    // while a quote jump is in flight the thread must stay where it was taken, not snap back
    if (revealPending.current) return;
    scrollBottom();
  }, [latest.data, older.length, scrollBottom]);

  const flat = [...older.flatMap((p) => p.messages), ...(latest.data?.messages ?? [])];
  const seen = new Set<string>();
  const messages = flat.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  const hasMore = (latest.data?.hasMore ?? false) || (older[0]?.hasMore ?? false);
  const isTeacher = me?.role === 'teacher';
  const canPost = isTeacher ? meta?.chatMode !== 'off' : meta?.chatMode === 'on';
  /** the reply UI's author label — «Вы» for one's own message, in the bar AND the placeholder */
  const replyName = (m: { authorId: string; authorName: string }) =>
    (m.authorId === me?.id ? t('chat.you') : m.authorName);

  function showToast(msg: string) {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2_000);
  }
  async function copyText(txt: string) {
    try { await navigator.clipboard.writeText(txt); } catch {
      // http/old-browser fallback: a throwaway textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* nothing else to try */ }
      ta.remove();
    }
    setMenuFor(null);
    showToast(t('chat.copied'));
  }
  // Telegram-style long-press (touch) opens the same menu; any move cancels it
  function pressStart(msgId: string) {
    pressCancel();
    pressTimer.current = window.setTimeout(() => setMenuFor(msgId), 500);
  }
  function pressCancel() {
    if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = undefined; }
  }
  useEffect(() => () => {
    pressCancel();
    window.clearTimeout(toastTimer.current);
    window.clearTimeout(flashTimer.current);
  }, []);

  // ── reply task 2: starting an answer, and jumping to a quote ───────────────
  function startReply(m: Msg) {
    setMenuFor(null);
    setReplyTo(m);
    // the draft must keep working: focus goes to the input, its content is untouched
    inputRef.current?.focus();
  }
  function flash(msgId: string) {
    setFlashId(msgId);
    window.clearTimeout(flashTimer.current);
    // once the highlight is over the thread behaves normally again (a new message pins it down)
    flashTimer.current = window.setTimeout(() => { setFlashId(null); revealPending.current = false; }, 1_600);
  }
  function scrollToMsg(msgId: string) {
    // a jump to an original must not be undone by the "keep the thread pinned to the
    // bottom" effect that fires when the newly loaded page lands
    revealPending.current = true;
    document.getElementById(`chat-msg-${msgId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(msgId);
  }
  /**
   * Click on a quote: show its original. If it is not loaded yet, older pages are fetched until
   * it appears — capped at 8 pages, after which the user gets «Старое сообщение» instead of a
   * spinner that never ends or a crash.
   */
  async function revealQuote(msgId: string) {
    if (messages.some((m) => m.id === msgId)) { scrollToMsg(msgId); return; }
    let cursor = messages[0]?.createdAt ?? new Date().toISOString();
    for (let page = 0; page < 8; page++) {
      let got: { messages: Msg[]; hasMore: boolean } | null = null;
      try {
        got = await api<{ messages: Msg[]; hasMore: boolean }>(
          `/api/classes/${id}/chat/messages?limit=30&before=${encodeURIComponent(cursor)}`);
      } catch { got = null; }
      if (!got || got.messages.length === 0) break;
      setOlder((prev) => [got!, ...prev]);
      // «Сообщения раньше» continues from here; without this the button kept its old cursor and
      // re-fetched pages this click had already loaded
      setBefore(got.messages[0]!.createdAt);
      if (got.messages.some((m) => m.id === msgId)) {
        // one tick for React to paint the newly loaded page
        window.setTimeout(() => scrollToMsg(msgId), 150);
        return;
      }
      if (!got.hasMore) break;
      cursor = got.messages[0]!.createdAt;
    }
    showToast(t('chat.replyTooOld'));
  }
  // a right swipe on a message bubble answers it (touch only, and only when the move is
  // horizontal — a vertical drag must keep scrolling the thread)
  function swipeStart(e: React.PointerEvent, msgId: string) {
    if (e.pointerType === 'mouse') return;
    swipe.current = { id: msgId, x: e.clientX, y: e.clientY, done: false };
  }
  function swipeMove(e: React.PointerEvent, m: Msg) {
    const s = swipe.current;
    if (!s || s.done || s.id !== m.id) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (dx > 56 && Math.abs(dy) < 40) {
      s.done = true;
      swipe.current = null;
      if (canPost) {
        navigator.vibrate?.(10);   // absent on iOS — no error, the swipe still works
        startReply(m);
      }
    }
  }
  function swipeEnd() { swipe.current = null; }

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
          const canAct = mine || isTeacher; // author edits own; teacher moderates (copy/delete)
          // reply task 2: «Ответить» is for anybody who may post, on ANY message of the class —
          // so the ⋯ button opens for a student on the teacher's bubble too (with only that item)
          const canMenu = canAct || canPost;
          const editing = editingId === m.id;
          return (
            <div key={m.id} id={`chat-msg-${m.id}`}
              className={[mine ? 'chat-msg mine' : 'chat-msg', flashId === m.id ? 'chat-flash' : ''].filter(Boolean).join(' ')}
              data-testid="chat-msg"
              onContextMenu={(e) => { if (canMenu) { e.preventDefault(); setMenuFor(m.id); } }}>
              <div className="chat-msg-head">
                <strong>{mine ? t('chat.you') : m.authorName}</strong>
                <span className="muted">{fmtDateTime(m.createdAt, i18n.language)}</span>
                {m.editedAt && (
                  <span className="muted chat-edited-tag" data-testid="chat-edited">
                    {t('chat.edited')} · {fmtDateTime(m.editedAt, i18n.language)}
                  </span>
                )}
                <div className="spacer" />
                {isTeacher && !mine && !editing && (
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
                {canMenu && !editing && (
                  <button className="ghost chat-more" style={{ marginTop: 0, padding: 2 }} data-testid="chat-more"
                    aria-label={t('chat.menu')} aria-haspopup="menu" aria-expanded={menuFor === m.id}
                    onClick={(e) => { setMenuAnchor(e.currentTarget); setMenuFor(menuFor === m.id ? null : m.id); }}>⋯</button>
                )}
              </div>
              {editing ? (
                <div className="chat-edit">
                  <label className="sr-only" htmlFor={`chat-edit-${m.id}`}>{t('chat.edit')}</label>
                  <textarea id={`chat-edit-${m.id}`} data-testid="chat-edit-input" rows={3} value={editText} maxLength={2000}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setEditingId(null); return; }
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (editText.trim()) edit.mutate({ msgId: m.id, text: editText.trim() }); }
                    }}
                    style={{ width: '100%', resize: 'vertical' }} />
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <button type="button" data-testid="chat-edit-save" style={{ marginTop: 0 }}
                      disabled={!editText.trim() || edit.isPending}
                      onClick={() => edit.mutate({ msgId: m.id, text: editText.trim() })}>{t('common.save')}</button>
                    <button type="button" className="secondary" data-testid="chat-edit-cancel" style={{ marginTop: 0 }}
                      onClick={() => setEditingId(null)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : (
                <>
                  {/* reply task 2: the quoted original above the answer; plain text again, and it
                      is a real button for the keyboard */}
                  {m.replyTo && (
                    <div id={`chat-quote-${m.id}`} className="chat-quote" data-testid="chat-quote"
                      role="button" tabIndex={0}
                      aria-label={m.replyTo.deleted ? t('chat.replyDeleted') : `${m.replyTo.authorName}: ${m.replyTo.snippet}`}
                      onClick={() => void revealQuote(m.replyTo!.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void revealQuote(m.replyTo!.id); }
                      }}>
                      <span className="chat-quote-author">
                        {m.replyTo.deleted ? t('chat.replyDeleted') : m.replyTo.authorName}
                      </span>
                      {!m.replyTo.deleted && <span className="chat-quote-text">{m.replyTo.snippet}</span>}
                    </div>
                  )}
                  {/* plain text — React escapes it; the chat never renders HTML (XSS-safe by
                      construction). Kept as a JSX child comment on purpose: a bare C-style comment
                      in this position is text and would print inside every bubble. */}
                  <div className="chat-msg-text" data-testid="chat-text"
                    onPointerDown={(e) => { if (canMenu) pressStart(m.id); swipeStart(e, m.id); }}
                    onPointerMove={(e) => { pressCancel(); swipeMove(e, m); }}
                    onPointerUp={() => { pressCancel(); swipeEnd(); }}
                    onPointerLeave={() => { pressCancel(); swipeEnd(); }}
                    onPointerCancel={() => { pressCancel(); swipeEnd(); }}>{m.text}</div>
                </>
              )}
              {menuFor === m.id && !editing && (
                <div className="chat-menu card" role="menu" aria-label={t('chat.menu')} data-testid="chat-menu"
                  ref={menuPop.ref} style={menuPop.style}>
                  {canPost && (
                    <button type="button" role="menuitem" data-testid="chat-act-reply" style={{ marginTop: 0 }}
                      onClick={() => startReply(m)}>{t('chat.reply')}</button>
                  )}
                  {/* copy/delete keep the item-7 audience exactly (author or teacher) — the menu
                      now also opens for a member who may only answer, so they are gated here */}
                  {canAct && (
                    <button type="button" role="menuitem" data-testid="chat-act-copy" style={{ marginTop: 0 }}
                      onClick={() => void copyText(m.text)}>{t('chat.copy')}</button>
                  )}
                  {mine && (
                    <button type="button" role="menuitem" data-testid="chat-act-edit" style={{ marginTop: 0 }}
                      onClick={() => { setMenuFor(null); setEditingId(m.id); setEditText(m.text); }}>{t('chat.edit')}</button>
                  )}
                  {canAct && (
                    <button type="button" role="menuitem" className="danger-text" data-testid="chat-act-del" style={{ marginTop: 0 }}
                      onClick={() => {
                        setMenuFor(null);
                        if (window.confirm(t('chat.deleteConfirm'))) del.mutate(m.id);
                      }}>{t('common.delete')}</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {menuFor && <div className="chat-menu-backdrop" data-testid="chat-menu-backdrop" onClick={() => setMenuFor(null)} />}
      {toast && <div className="toast" role="status" data-testid="chat-toast">{toast}</div>}

      {error && <p className="error" data-testid="chat-error">{error}</p>}
      {meta && !canPost && (
        <p className="muted" data-testid="chat-locked">
          {meta.chatMode === 'off' ? t('chat.disabled') : t('chat.announceNote')}
        </p>
      )}
      {/* reply task 2: the bar above the composer — author, snippet, ✕, and Esc cancels */}
      {replyTo && (
        <div className="chat-reply-bar" data-testid="chat-reply-bar">
          <span className="chat-reply-bar-icon">↩</span>
          <span className="chat-reply-bar-author" data-testid="chat-reply-author">
            {replyName(replyTo)}
          </span>
          <span className="muted chat-reply-bar-text" data-testid="chat-reply-snippet">{replySnippet(replyTo.text)}</span>
          <div className="spacer" />
          <button type="button" className="ghost" data-testid="chat-reply-cancel" style={{ marginTop: 0, padding: 2 }}
            aria-label={t('chat.replyCancel')} onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}
      <form
        className="row"
        style={{ alignItems: 'flex-end', gap: 8 }}
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) send.mutate(draft.trim()); }}
      >
        {/* the name belongs to the accessible label, not the visible hint: «Ответить Вы» /
            «Reply You» read badly in every language, and the bar above already shows whose
            message is being answered */}
        <label className="sr-only" htmlFor="chat-input">
          {replyTo ? `${t('chat.reply')}: ${replyName(replyTo)}` : t('chat.placeholder')}
        </label>
        <textarea
          id="chat-input" ref={inputRef} data-testid="chat-input" rows={2} value={draft} maxLength={2000}
          placeholder={replyTo ? t('chat.reply') : t('chat.placeholder')}
          disabled={!canPost || send.isPending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Esc drops the answer first and leaves the draft (and the focus) alone
            if (e.key === 'Escape' && replyTo) { e.preventDefault(); setReplyTo(null); return; }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (draft.trim()) send.mutate(draft.trim()); }
          }}
          style={{ flex: 1, resize: 'vertical' }}
        />
        <button type="submit" data-testid="chat-send" disabled={!draft.trim() || !canPost || send.isPending} style={{ marginTop: 0 }}>
          {replyTo ? t('chat.sendReply') : t('chat.send')}
        </button>
      </form>
    </div>
  );
}
