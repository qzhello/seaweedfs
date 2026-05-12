"use client";
// Typed fetchers for the AI assistant API. The backend persists chats +
// messages per user, caps each thread at 50 messages, and assembles a
// system prompt from matching SOPs + the currently selected cluster on
// every POST. Tokens are read from localStorage like the rest of the
// app (see api.ts).

import useSWR from "swr";

const BASE = "/api/v1";

export interface AssistantChat {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  cluster_id?: string;
  page_path?: string;
  created_at: string;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window !== "undefined") {
    const t = window.localStorage.getItem("tier.token");
    if (t) h["Authorization"] = `Bearer ${t}`;
  }
  return h;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { ...authHeaders(), ...(init?.headers || {}) } });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.error || `${r.status}`);
  }
  return r.json() as Promise<T>;
}

export function useAssistantChats(enabled: boolean) {
  return useSWR<{ items: AssistantChat[] }>(enabled ? `${BASE}/ai/assistant/chats` : null, (url: string) =>
    fetch(url, { headers: authHeaders() }).then(r => r.json()),
  );
}

export function useAssistantMessages(chatID: string | null) {
  return useSWR<{ items: AssistantMessage[] }>(
    chatID ? `${BASE}/ai/assistant/chats/${chatID}/messages` : null,
    (url: string) => fetch(url, { headers: authHeaders() }).then(r => r.json()),
  );
}

export const assistantApi = {
  createChat: (title = "") =>
    http<AssistantChat>(`/ai/assistant/chats`, { method: "POST", body: JSON.stringify({ title }) }),
  deleteChat: (id: string) => http<{ ok: boolean }>(`/ai/assistant/chats/${id}`, { method: "DELETE" }),
  renameChat: (id: string, title: string) =>
    http<AssistantChat>(`/ai/assistant/chats/${id}`, { method: "PUT", body: JSON.stringify({ title }) }),
  postMessage: (chatID: string, body: { message: string; cluster_id?: string; page_path?: string }) =>
    http<{ user: AssistantMessage; assistant: AssistantMessage }>(`/ai/assistant/chats/${chatID}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
