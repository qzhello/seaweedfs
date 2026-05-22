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

// TranscriptItem mirrors internal/api/assistant_stream.go::transcriptItem.
// Present on assistant messages produced by the streaming endpoint
// when the LLM used at least one tool. Empty/missing for pure-text
// turns and legacy non-streaming messages.
export interface TranscriptItem {
  call_id: string;
  name: string;
  arguments: string;
  content: string;
  is_error?: boolean;
}

export interface AssistantMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  cluster_id?: string;
  page_path?: string;
  created_at: string;
  tool_transcript?: TranscriptItem[];
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window !== "undefined") {
    const t = window.localStorage.getItem("tier.token");
    if (t) h["Authorization"] = `Bearer ${t}`;
    // Pass the operator's current UI locale so AI-backed endpoints can
    // localize the assistant's responses to match what the user sees.
    try {
      const lang = window.localStorage.getItem("tier.lang");
      h["X-Tier-Lang"] = lang === "en" ? "en" : "zh";
    } catch { /* ignore */ }
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

// --- Streaming variant ------------------------------------------------------

// AssistantStreamEvent is one parsed event off the SSE stream. We use a
// tagged union keyed by `kind` so the consumer can switch and TypeScript
// narrows correctly. The shape mirrors what the backend emits in
// internal/api/assistant_stream.go.
export type AssistantStreamEvent =
  | { kind: "user_msg"; msg: AssistantMessage }
  | { kind: "token"; text: string }
  | { kind: "tool_call"; id: string; name: string; arguments: string }
  | { kind: "tool_result"; call_id: string; content: string; is_error?: boolean }
  | { kind: "assistant_msg"; msg: AssistantMessage }
  | { kind: "done"; reason: string }
  | { kind: "error"; message: string };

// streamAssistantMessage POSTs the user message and yields parsed
// SSE events as an async iterator. The caller is responsible for
// updating UI state per event (token append, tool bubble insert, etc).
//
// Why fetch + manual parsing instead of EventSource: EventSource
// doesn't support custom headers (we need the Bearer token), so we
// stream the response body and split on the standard SSE delimiter.
export async function* streamAssistantMessage(
  chatID: string,
  body: { message: string; cluster_id?: string; page_path?: string },
): AsyncGenerator<AssistantStreamEvent> {
  const r = await fetch(`${BASE}/ai/assistant/chats/${chatID}/messages/stream`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.error || `${r.status}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE event boundary: a blank line. Each event is two-or-more
    // lines: `event: <name>` then `data: <json>`.
    let nl = buf.indexOf("\n\n");
    while (nl >= 0) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const ev = parseSSEBlock(block);
      if (ev) yield ev;
      nl = buf.indexOf("\n\n");
    }
  }
}

function parseSSEBlock(block: string): AssistantStreamEvent | null {
  let event = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event || !data) return null;
  let payload: unknown;
  try { payload = JSON.parse(data); } catch { return null; }
  const p = payload as Record<string, unknown>;
  switch (event) {
    case "user_msg":      return { kind: "user_msg", msg: p as unknown as AssistantMessage };
    case "token":         return { kind: "token", text: String(p.text ?? "") };
    case "tool_call":     return { kind: "tool_call",
                                    id: String(p.id ?? ""),
                                    name: String(p.name ?? ""),
                                    arguments: typeof p.arguments === "string"
                                      ? p.arguments
                                      : JSON.stringify(p.arguments) };
    case "tool_result":   return { kind: "tool_result",
                                    call_id: String(p.call_id ?? ""),
                                    content: String(p.content ?? ""),
                                    is_error: Boolean(p.is_error) };
    case "assistant_msg": return { kind: "assistant_msg", msg: p as unknown as AssistantMessage };
    case "done":          return { kind: "done", reason: String(p.reason ?? "") };
    case "error":         return { kind: "error", message: String(p.message ?? "") };
    default:              return null;
  }
}
