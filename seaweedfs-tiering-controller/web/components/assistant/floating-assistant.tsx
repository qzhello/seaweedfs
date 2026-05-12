"use client";

// Floating AI assistant — a FAB bottom-right that opens a slide-up
// chat panel. The assistant knows: the user's currently selected
// cluster (from ClusterContext), the current page path, and the
// matching SOPs on the server side. Chat history is persisted
// per user; each thread auto-trims to 50 messages on the server.
//
// Not rendered on /login or /wall (Shell already short-circuits
// those routes, so mounting here is fine).

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Sparkles, X, Send, Plus, Trash2, Loader2, MessageSquare, AlertTriangle } from "lucide-react";
import { useCluster } from "@/lib/cluster-context";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import {
  useAssistantChats, useAssistantMessages, assistantApi,
  type AssistantMessage,
} from "@/lib/assistant-api";
import { mutate as swrMutate } from "swr";

const ACTIVE_CHAT_KEY = "tier.assistant.active";

export function FloatingAssistant() {
  const { t } = useT();
  const { has, loading: capsLoading } = useCaps();
  const path = usePathname();
  const { clusterID } = useCluster();
  const [open, setOpen] = useState(false);
  const [activeChat, setActiveChat] = useState<string | null>(null);

  // Hide entirely on login / NOC wall — they're rendered outside the
  // Shell wrapper, but defence-in-depth: skip them here too in case
  // someone mounts <FloatingAssistant/> elsewhere later.
  const hideRoutes = ["/login", "/wall", "/account/password"];
  const hidden = hideRoutes.some(p => path?.startsWith(p));

  useEffect(() => {
    try {
      const v = localStorage.getItem(ACTIVE_CHAT_KEY);
      if (v) setActiveChat(v);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try {
      if (activeChat) localStorage.setItem(ACTIVE_CHAT_KEY, activeChat);
    } catch { /* ignore */ }
  }, [activeChat]);

  if (hidden) return null;
  if (capsLoading) return null;
  // Soft-gate: if the user doesn't have ai.assistant the API would 403
  // anyway, but better to hide the button than show a broken affordance.
  if (!has("ai.assistant")) return null;

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-5 right-5 z-50 w-12 h-12 rounded-full bg-accent text-bg shadow-xl flex items-center justify-center hover:scale-105 transition-transform"
        title={t("AI Assistant")}
        aria-label={t("AI Assistant")}
      >
        {open ? <X size={18}/> : <Sparkles size={18}/>}
      </button>
      {open && (
        <AssistantPanel
          path={path || "/"}
          clusterID={clusterID}
          activeChat={activeChat}
          setActiveChat={setActiveChat}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface PanelProps {
  path: string;
  clusterID: string;
  activeChat: string | null;
  setActiveChat: (id: string | null) => void;
  onClose: () => void;
}

function AssistantPanel({ path, clusterID, activeChat, setActiveChat, onClose }: PanelProps) {
  const { t } = useT();
  const { data: chatsResp, mutate: mutateChats } = useAssistantChats(true);
  const chats = chatsResp?.items || [];
  const { data: msgsResp, mutate: mutateMsgs } = useAssistantMessages(activeChat);
  const messages: AssistantMessage[] = msgsResp?.items || [];
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the bottom when messages change so the latest reply
  // is always visible without manual scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, sending]);

  const createAndSelect = async () => {
    try {
      const c = await assistantApi.createChat();
      await mutateChats();
      setActiveChat(c.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const removeChat = async (id: string) => {
    try {
      await assistantApi.deleteChat(id);
      if (activeChat === id) setActiveChat(null);
      await mutateChats();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    let chatID = activeChat;
    setErr(null);
    setSending(true);
    try {
      if (!chatID) {
        const c = await assistantApi.createChat();
        await mutateChats();
        chatID = c.id;
        setActiveChat(c.id);
      }
      setInput("");
      // Optimistic user bubble — we re-fetch right after to pick up the
      // server-assigned IDs and the assistant reply in one go.
      await swrMutate(`/api/v1/ai/assistant/chats/${chatID}/messages`, async (cur: any) => {
        const items = [...(cur?.items || []), {
          id: `tmp-${Date.now()}`,
          chat_id: chatID,
          role: "user", content: text,
          created_at: new Date().toISOString(),
        }];
        return { items };
      }, { revalidate: false });
      await assistantApi.postMessage(chatID, {
        message: text,
        cluster_id: clusterID || undefined,
        page_path: path,
      });
      await mutateMsgs();
      await mutateChats();
    } catch (e) {
      setErr((e as Error).message);
      // Roll back the optimistic bubble by re-fetching authoritative state.
      await mutateMsgs();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed bottom-20 right-5 z-50 w-[640px] max-w-[calc(100vw-2.5rem)] h-[560px] max-h-[calc(100vh-7rem)] card flex shadow-2xl">
      {/* Left rail: chat list. Narrow to keep the main pane wide. */}
      <aside className="w-44 border-r border-border flex flex-col">
        <header className="p-2 border-b border-border flex items-center justify-between">
          <span className="text-xs text-muted inline-flex items-center gap-1">
            <MessageSquare size={12}/> {t("Chats")}
          </span>
          <button onClick={createAndSelect} className="p-1 text-muted hover:text-text" title={t("New chat")}>
            <Plus size={14}/>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
          {chats.length === 0 && (
            <div className="text-[10px] text-muted/70 px-2 py-3">{t("No chats yet.")}</div>
          )}
          {chats.map(c => (
            <div key={c.id}
              className={`group flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer ${
                activeChat === c.id ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
              }`}
              onClick={() => setActiveChat(c.id)}>
              <span className="flex-1 truncate" title={c.title}>{c.title || t("Untitled")}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeChat(c.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 text-rose-400 hover:text-rose-300"
                title={t("Delete chat")}
              >
                <Trash2 size={11}/>
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Right: header + messages + composer */}
      <section className="flex-1 flex flex-col min-w-0">
        <header className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold inline-flex items-center gap-1.5">
              <Sparkles size={13} className="text-accent"/>
              {t("AI Assistant")}
            </div>
            <div className="text-[10px] text-muted truncate">
              {clusterID ? <>{t("Scoped to cluster")}: <span className="text-text">{clusterID.slice(0, 8)}</span></> : t("No cluster scope")}
              {" · "}{path}
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-muted hover:text-text" title={t("Close")}>
            <X size={14}/>
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
          {!activeChat && messages.length === 0 && (
            <Welcome t={t}/>
          )}
          {messages.map(m => (
            <MessageBubble key={m.id} m={m}/>
          ))}
          {sending && (
            <div className="flex gap-1.5 text-xs text-muted items-center">
              <Loader2 size={12} className="animate-spin"/>
              {t("Thinking…")}
            </div>
          )}
        </div>

        {err && (
          <div className="px-3 py-1.5 text-[11px] text-rose-300 border-t border-border inline-flex items-center gap-1">
            <AlertTriangle size={11}/> {err}
          </div>
        )}

        <div className="border-t border-border p-2 flex items-end gap-1.5">
          <textarea
            className="input flex-1 text-sm resize-none min-h-[36px] max-h-[120px]"
            placeholder={t("Ask anything about this page or the selected cluster…")}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            rows={1}
          />
          <button
            onClick={send}
            disabled={!input.trim() || sending}
            className="btn bg-accent/15 text-accent border-accent/40 inline-flex items-center gap-1 h-9"
            title={t("Send (Enter)")}
          >
            {sending ? <Loader2 size={13} className="animate-spin"/> : <Send size={13}/>}
          </button>
        </div>
      </section>
    </div>
  );
}

function MessageBubble({ m }: { m: AssistantMessage }) {
  const isUser = m.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
          isUser
            ? "bg-accent/15 text-text border border-accent/30"
            : "bg-panel2 text-text border border-border"
        }`}
      >
        {m.content}
      </div>
    </div>
  );
}

function Welcome({ t }: { t: (s: string) => string }) {
  return (
    <div className="text-xs text-muted leading-relaxed space-y-2">
      <p>{t("Hi! I'm scoped to your active cluster and the SOPs for the current page.")}</p>
      <p>{t("Pick or create a chat on the left to get started. History caps at 50 messages per thread.")}</p>
    </div>
  );
}
