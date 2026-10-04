import { useQuery } from '@tanstack/react-query';
import { api, getToken } from './api';

export interface ChatSummaryRow {
  classId: string; name: string; chatMode: 'on' | 'off' | 'announce';
  lastMessage: string | null; lastAuthor: string | null; lastAt: string | null; unread: number;
}

/**
 * item 8 — shared chat summary query (lives in lib to avoid a Nav ⇄ pages cycle).
 * 30 s poll keeps the sidebar/tabbar badge fresh; the room socket refreshes it
 * on every message anyway.
 */
export function useChatUnread(enabled = true) {
  return useQuery({
    queryKey: ['chat-summary'],
    queryFn: () => api<ChatSummaryRow[]>('/api/chat/summary'),
    enabled: enabled && Boolean(getToken()),
    refetchInterval: 30_000,
  });
}
