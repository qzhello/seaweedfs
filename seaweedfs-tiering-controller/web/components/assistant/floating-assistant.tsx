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
import { Sparkles, X, Send, Plus, Trash2, Loader2, MessageSquare, AlertTriangle, Maximize2, Minimize2, Copy, Check, RefreshCw } from "lucide-react";
import { useCluster } from "@/lib/cluster-context";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import {
  useAssistantChats, useAssistantMessages, assistantApi, streamAssistantMessage,
  type AssistantMessage, type AssistantStreamEvent,
} from "@/lib/assistant-api";
import { api } from "@/lib/api";
import { Wrench, Hammer, ChevronDown, ChevronUp } from "lucide-react";
import { mutate as swrMutate } from "swr";
import { renderToolResult } from "@/components/assistant/tool-result-renderers";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const ACTIVE_CHAT_KEY = "tier.assistant.active";
const POS_KEY = "tier.assistant.fab_pos";
const FAB_SIZE = 48;        // matches w-12 h-12
const DRAG_THRESHOLD = 4;   // px — below this counts as a click

interface FabPos { right: number; bottom: number; }
const DEFAULT_POS: FabPos = { right: 20, bottom: 20 };

function clampPos(p: FabPos): FabPos {
  if (typeof window === "undefined") return p;
  const maxRight = Math.max(8, window.innerWidth - FAB_SIZE - 8);
  const maxBottom = Math.max(8, window.innerHeight - FAB_SIZE - 8);
  return {
    right: Math.min(Math.max(8, p.right), maxRight),
    bottom: Math.min(Math.max(8, p.bottom), maxBottom),
  };
}

// --- Assistant panel geometry ----------------------------------------
// The chat panel is independently draggable (grab its header) and
// resizable (bottom-right grip, or the maximize button). The rect is
// persisted so the operator's preferred size/place survives reloads.
const PANEL_RECT_KEY = "tier.assistant.panel_rect";
const PANEL_MIN_W = 420;
const PANEL_MIN_H = 380;
const PANEL_DEF_W = 640;
const PANEL_DEF_H = 560;

interface PanelRect { x: number; y: number; w: number; h: number; }

// clampRect keeps the panel within the viewport and above the minimum
// usable size — used on every drag/resize tick and on window resize.
function clampRect(r: PanelRect): PanelRect {
  if (typeof window === "undefined") return r;
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(Math.max(PANEL_MIN_W, r.w), Math.max(PANEL_MIN_W, vw - 16));
  const h = Math.min(Math.max(PANEL_MIN_H, r.h), Math.max(PANEL_MIN_H, vh - 16));
  const x = Math.min(Math.max(8, r.x), Math.max(8, vw - w - 8));
  const y = Math.min(Math.max(8, r.y), Math.max(8, vh - h - 8));
  return { x, y, w, h };
}

// defaultRect places the panel just above the FAB, right-aligned —
// matching where it used to sit before it became free-floating.
function defaultRect(fab: FabPos): PanelRect {
  if (typeof window === "undefined") {
    return { x: 40, y: 40, w: PANEL_DEF_W, h: PANEL_DEF_H };
  }
  const rightEdge = window.innerWidth - fab.right;
  const bottomEdge = window.innerHeight - (fab.bottom + FAB_SIZE + 12);
  return clampRect({
    x: rightEdge - PANEL_DEF_W,
    y: bottomEdge - PANEL_DEF_H,
    w: PANEL_DEF_W,
    h: PANEL_DEF_H,
  });
}

export function FloatingAssistant() {
  const { t } = useT();
  const { has, loading: capsLoading } = useCaps();
  const path = usePathname();
  const { clusterID } = useCluster();
  const [open, setOpen] = useState(false);
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [pos, setPos] = useState<FabPos>(DEFAULT_POS);
  const [dragging, setDragging] = useState(false);
  // Tracks whether the current pointer-down sequence moved enough to
  // count as a drag. If not, pointer-up triggers the normal toggle.
  const dragState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origRight: number;
    origBottom: number;
    moved: boolean;
  } | null>(null);

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

  // Restore persisted FAB position, then keep it in-bounds on viewport
  // resize so the button never strands off-screen after window changes.
  useEffect(() => {
    try {
      const v = localStorage.getItem(POS_KEY);
      if (v) {
        const parsed = JSON.parse(v) as FabPos;
        if (typeof parsed?.right === "number" && typeof parsed?.bottom === "number") {
          setPos(clampPos(parsed));
        }
      }
    } catch { /* ignore */ }
    const onResize = () => setPos(p => clampPos(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Only left button / primary touch.
    if (e.button !== 0 && e.pointerType === "mouse") return;
    (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
    dragState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origRight: pos.right,
      origBottom: pos.bottom,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = dragState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!s.moved) {
      s.moved = true;
      setDragging(true);
    }
    // right/bottom anchored: dragging right (dx > 0) shrinks `right`.
    setPos(clampPos({
      right: s.origRight - dx,
      bottom: s.origBottom - dy,
    }));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = dragState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const wasDrag = s.moved;
    dragState.current = null;
    setDragging(false);
    if (wasDrag) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
    } else {
      setOpen(o => !o);
    }
  };

  if (hidden) return null;
  if (capsLoading) return null;
  // Soft-gate: if the user doesn't have ai.assistant the API would 403
  // anyway, but better to hide the button than show a broken affordance.
  if (!has("ai.assistant")) return null;

  return (
    <>
      <button
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ right: pos.right, bottom: pos.bottom, touchAction: "none" }}
        className={`fixed z-50 w-12 h-12 rounded-full bg-accent text-bg shadow-xl flex items-center justify-center select-none ${
          dragging ? "cursor-grabbing scale-105" : "cursor-grab hover:scale-105 transition-transform"
        }`}
        title={t("AI Assistant — drag to move")}
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
          fabPos={pos}
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
  fabPos: FabPos;
  onClose: () => void;
}

function AssistantPanel({ path, clusterID, activeChat, setActiveChat, fabPos, onClose }: PanelProps) {
  const { t } = useT();
  const { data: chatsResp, mutate: mutateChats } = useAssistantChats(true);
  const chats = chatsResp?.items || [];
  const { data: msgsResp, mutate: mutateMsgs } = useAssistantMessages(activeChat);
  const messages: AssistantMessage[] = msgsResp?.items || [];
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // `live` captures the streaming assistant turn while it's in flight:
  // partial text + executed tool calls. Cleared once the final
  // assistant_msg event arrives and the persisted history reflects
  // everything.
  const [liveText, setLiveText] = useState<string>("");
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);

  // --- Draggable / resizable panel geometry ---
  // Lazy init reads the persisted rect up front so the panel never
  // flashes at the default spot before the saved one applies.
  const [rect, setRect] = useState<PanelRect>(() => {
    try {
      const v = localStorage.getItem(PANEL_RECT_KEY);
      if (v) {
        const parsed = JSON.parse(v) as PanelRect;
        if (typeof parsed?.x === "number" && typeof parsed?.w === "number") {
          return clampRect(parsed);
        }
      }
    } catch { /* ignore */ }
    return defaultRect(fabPos);
  });
  // Pre-maximize rect, so the maximize button can toggle back. A manual
  // drag/resize clears it (the "restore" target is no longer meaningful).
  const preMaxRect = useRef<PanelRect | null>(null);
  const interaction = useRef<{
    mode: "drag" | "resize";
    pointerId: number;
    startX: number;
    startY: number;
    orig: PanelRect;
  } | null>(null);

  // Re-clamp on viewport resize so the panel never strands off-screen
  // after the window changes.
  useEffect(() => {
    const onResize = () => setRect(r => clampRect(r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistRect = (r: PanelRect) => {
    try { localStorage.setItem(PANEL_RECT_KEY, JSON.stringify(r)); } catch { /* ignore */ }
  };

  // beginInteraction returns a pointer-down handler for either the
  // header (drag) or the corner grip (resize). It captures the pointer
  // so move/up keep firing even if the cursor outruns the element.
  const beginInteraction = (mode: "drag" | "resize") =>
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      // Header drag must ignore clicks on its own buttons.
      if (mode === "drag" && (e.target as HTMLElement).closest("button")) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      preMaxRect.current = null; // a manual move/resize cancels "restore"
      interaction.current = {
        mode,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        orig: rect,
      };
    };

  const onInteractionMove = (e: React.PointerEvent) => {
    const s = interaction.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX, dy = e.clientY - s.startY;
    setRect(clampRect(
      s.mode === "drag"
        ? { ...s.orig, x: s.orig.x + dx, y: s.orig.y + dy }
        : { ...s.orig, w: s.orig.w + dx, h: s.orig.h + dy },
    ));
  };

  const onInteractionUp = (e: React.PointerEvent) => {
    const s = interaction.current;
    if (!s || s.pointerId !== e.pointerId) return;
    interaction.current = null;
    setRect(r => { persistRect(r); return r; });
  };

  // toggleMaximize fills the viewport, or restores the pre-maximize rect.
  const toggleMaximize = () => {
    if (preMaxRect.current) {
      const r = clampRect(preMaxRect.current);
      preMaxRect.current = null;
      setRect(r);
      persistRect(r);
    } else {
      preMaxRect.current = rect;
      const r = clampRect({ x: 8, y: 8, w: window.innerWidth, h: window.innerHeight });
      setRect(r);
      persistRect(r);
    }
  };

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

  // send streams one turn. `override` re-asks an earlier question (the
  // "Ask again" action) — it bypasses the input box and leaves any draft
  // the operator was typing untouched.
  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || sending) return;
    let chatID = activeChat;
    setErr(null);
    setSending(true);
    setLiveText("");
    setLiveTools([]);
    try {
      if (!chatID) {
        const c = await assistantApi.createChat();
        await mutateChats();
        chatID = c.id;
        setActiveChat(c.id);
      }
      if (!override) setInput("");
      // Consume the SSE stream. We update state per event so the UI
      // shows tokens trickling in, tool calls as cards, and their
      // results inline. On `done` we re-fetch the authoritative
      // message list and clear the live overlay.
      for await (const ev of streamAssistantMessage(chatID, {
        message: text,
        cluster_id: clusterID || undefined,
        page_path: path,
      })) {
        if (ev.kind === "user_msg") {
          // Show the persisted user turn immediately so the operator
          // sees their input even if the model takes a while.
          await swrMutate(`/api/v1/ai/assistant/chats/${chatID}/messages`, async (cur: any) => {
            const items = [...(cur?.items || []), ev.msg];
            return { items };
          }, { revalidate: false });
        } else if (ev.kind === "token") {
          setLiveText(prev => prev + ev.text);
        } else if (ev.kind === "tool_call") {
          setLiveTools(prev => [...prev, {
            id: ev.id, name: ev.name, arguments: ev.arguments,
            result: null, isError: false,
          }]);
        } else if (ev.kind === "tool_result") {
          setLiveTools(prev => prev.map(t => t.id === ev.call_id
            ? { ...t, result: ev.content, isError: !!ev.is_error }
            : t));
        } else if (ev.kind === "assistant_msg") {
          // Final persisted assistant message — refresh history so
          // navigating away and back shows the same content.
          await mutateMsgs();
          await mutateChats();
        } else if (ev.kind === "done") {
          // Clear live overlay; persisted state is now authoritative.
          setLiveText("");
          setLiveTools([]);
        } else if (ev.kind === "error") {
          setErr(ev.message);
        }
      }
    } catch (e) {
      setErr((e as Error).message);
      await mutateMsgs();
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      className="fixed z-50 card flex shadow-2xl"
    >
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
                className="opacity-0 group-hover:opacity-100 p-0.5 text-danger hover:text-danger"
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
        {/* The header doubles as the drag handle. */}
        <header
          onPointerDown={beginInteraction("drag")}
          onPointerMove={onInteractionMove}
          onPointerUp={onInteractionUp}
          onPointerCancel={onInteractionUp}
          style={{ touchAction: "none" }}
          className="px-3 py-2 border-b border-border flex items-center justify-between gap-2
                     cursor-grab active:cursor-grabbing select-none"
          title={t("Drag to move")}
        >
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
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={toggleMaximize}
              className="p-1 text-muted hover:text-text"
              title={preMaxRect.current ? t("Restore size") : t("Maximize")}
            >
              {preMaxRect.current ? <Minimize2 size={13}/> : <Maximize2 size={13}/>}
            </button>
            <button onClick={onClose} className="p-1 text-muted hover:text-text" title={t("Close")}>
              <X size={14}/>
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
          {!activeChat && messages.length === 0 && (
            <Welcome t={t}/>
          )}
          {messages.map(m => (
            <MessageBubble key={m.id} m={m} onReask={(q) => send(q)}/>
          ))}
          {/* Live overlay — tool calls executed by the model in this
              round, plus the streaming assistant text. Disappears
              once the `done` event clears it and the persisted
              message takes over the bubble below. */}
          {liveTools.map(tc => (
            <ToolCallCard key={tc.id} call={tc}/>
          ))}
          {liveText && (
            <div className="flex flex-col items-start">
              <div className="max-w-[92%] rounded-lg px-3 py-2 text-sm leading-relaxed bg-panel2 text-text border border-border">
                <Markdown content={liveText}/>
              </div>
            </div>
          )}
          {sending && !liveText && liveTools.length === 0 && (
            <div className="flex gap-1.5 text-xs text-muted items-center">
              <Loader2 size={12} className="animate-spin"/>
              {t("Thinking…")}
            </div>
          )}
        </div>

        {err && (
          err.includes("provider not configured") ? (
            <div className="px-3 py-2 text-[11px] text-warning border-t border-border space-y-1.5 bg-warning/5">
              <div className="inline-flex items-center gap-1 font-medium">
                <AlertTriangle size={11}/> {t("AI provider is not configured")}
              </div>
              <div className="text-muted">
                {t("Open the AI config page, add an OpenAI / Anthropic / Azure / local provider, and mark one as default.")}
              </div>
              <a
                href="/admin?tab=ai-config"
                className="btn inline-flex items-center gap-1 text-[11px] py-0.5 px-2"
              >
                {t("Open AI config")} →
              </a>
            </div>
          ) : (
            <div className="px-3 py-1.5 text-[11px] text-danger border-t border-border inline-flex items-center gap-1">
              <AlertTriangle size={11}/> {err}
            </div>
          )
        )}

        <div className="border-t border-border p-2 flex items-end gap-1.5">
          <textarea
            className="input flex-1 text-sm resize-none min-h-[36px] max-h-[120px]"
            placeholder={t("Ask anything about this page or the selected cluster…")}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              // Skip when the IME is composing (Chinese/Japanese/Korean
              // input): pressing Enter to confirm a candidate would
              // otherwise send a half-typed message. `isComposing` is
              // the standard signal; older browsers may only set
              // keyCode 229, so we check both.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            rows={1}
          />
          <button
            onClick={() => send()}
            disabled={!input.trim() || sending}
            className="btn bg-accent/15 text-accent border-accent/40 inline-flex items-center gap-1 h-9"
            title={t("Send (Enter)")}
          >
            {sending ? <Loader2 size={13} className="animate-spin"/> : <Send size={13}/>}
          </button>
        </div>
      </section>

      {/* Resize grip — bottom-right corner. */}
      <div
        onPointerDown={beginInteraction("resize")}
        onPointerMove={onInteractionMove}
        onPointerUp={onInteractionUp}
        onPointerCancel={onInteractionUp}
        style={{ touchAction: "none" }}
        className="absolute bottom-0 right-0 w-4 h-4 flex items-end justify-end p-[3px]
                   cursor-nwse-resize text-muted/40 hover:text-muted"
        title={t("Drag to resize")}
        aria-label={t("Drag to resize")}
      >
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
          <path d="M8.5 2 L2 8.5 M8.5 5.5 L5.5 8.5" stroke="currentColor"
            strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
      </div>
    </div>
  );
}

function MessageBubble({ m, onReask }: {
  m: AssistantMessage;
  onReask?: (text: string) => void;
}) {
  const { t } = useT();
  const isUser = m.role === "user";
  // Replay persisted tool calls above the assistant bubble. The
  // transcript is JSONB on the message row; old chats without it
  // simply skip this block.
  const transcript = !isUser ? (m.tool_transcript ?? []) : [];
  return (
    <div className={`group flex flex-col ${isUser ? "items-end" : "items-start"} gap-1`}>
      {transcript.map(item => (
        <ToolCallCard key={item.call_id} call={{
          id: item.call_id,
          name: item.name,
          arguments: item.arguments,
          result: item.content,
          isError: !!item.is_error,
        }}/>
      ))}
      <div
        className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? "max-w-[85%] bg-accent/15 text-text border border-accent/30 whitespace-pre-wrap"
            : "max-w-[92%] bg-panel2 text-text border border-border"
        }`}
      >
        {isUser ? m.content : <Markdown content={m.content} />}
      </div>
      {/* Copy the raw reply. Assistant turns only — that's the "result"
          operators want to paste into tickets / runbooks. */}
      {!isUser && m.content && (
        <div className="px-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <CopyButton text={m.content}/>
        </div>
      )}
      {/* Re-ask this question — re-runs it as a fresh turn. */}
      {isUser && m.content && onReask && (
        <div className="px-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            onClick={() => onReask(m.content)}
            className="inline-flex items-center gap-1 text-[10px] text-muted/70 hover:text-text transition-colors"
            title={t("Ask this question again")}
          >
            <RefreshCw size={11}/> {t("Ask again")}
          </button>
        </div>
      )}
    </div>
  );
}

// CopyButton copies plain text to the clipboard and flips to a check
// for ~1.5s as confirmation.
function CopyButton({ text }: { text: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked (insecure context) — ignore */ }
  };
  return (
    <button
      onClick={copy}
      className="inline-flex items-center gap-1 text-[10px] text-muted/70 hover:text-text transition-colors"
      title={t("Copy")}
    >
      {copied
        ? <Check size={11} className="text-success"/>
        : <Copy size={11}/>}
      {copied ? t("Copied") : t("Copy")}
    </button>
  );
}

// Lightweight Markdown renderer for assistant replies. Uses react-markdown +
// GFM (tables, task lists, strikethrough, autolinks). External links open in
// a new tab; inline + fenced code get monospace styling that respects the
// surrounding panel.
// Prose styling for assistant replies. Notable: Tailwind's preflight
// strips list-style, so `list-disc` / `list-decimal` are required or
// bullets/numbers render invisible. Headings get a real size ladder;
// blocks get consistent rhythm via space-y plus first/last margin trim.
const MD_PROSE = [
  "assistant-md leading-relaxed break-words space-y-2.5",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:m-0",
  "[&_ul]:my-1.5 [&_ul]:pl-5 [&_ul]:list-disc",
  "[&_ol]:my-1.5 [&_ol]:pl-5 [&_ol]:list-decimal",
  "[&_li]:my-1 [&_li]:marker:text-muted/70 [&_li>ul]:my-1 [&_li>ol]:my-1",
  "[&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1",
  "[&_h2]:text-[13.5px] [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1",
  "[&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-2.5 [&_h3]:mb-0.5",
  "[&_strong]:font-semibold [&_strong]:text-text [&_em]:italic",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:pl-3 [&_blockquote]:py-0.5 [&_blockquote]:my-2 [&_blockquote]:text-muted",
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-accent/40",
  "[&_hr]:my-3 [&_hr]:border-border",
  "[&_table]:w-full [&_table]:text-[12px] [&_table]:my-2 [&_table]:border-collapse",
  "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-bg/50 [&_th]:font-semibold [&_th]:text-left",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
].join(" ");

function Markdown({ content }: { content: string }) {
  return (
    <div className={MD_PROSE}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
          ),
          // react-markdown v10 dropped the `inline` prop — detect a fenced
          // block by its language class or an embedded newline instead.
          // Without this, every `inline code` span renders as a full-width
          // <pre> on its own line (the reported layout bug).
          code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) => {
            const text = String(children ?? "");
            const isBlock = /language-/.test(className || "") || text.includes("\n");
            if (isBlock) {
              // Sits inside the styled <pre> below — no inline pill.
              return <code className={`${className ?? ""} font-mono`} {...props}>{children}</code>;
            }
            return (
              <code className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-bg border border-border/70" {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="font-mono text-[12px] leading-relaxed p-2.5 rounded-md bg-bg border border-border/70 overflow-x-auto">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
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

// LiveTool tracks one tool call the model issued in the current
// streaming round, plus the executor's result once it arrives.
interface LiveTool {
  id: string;
  name: string;
  arguments: string; // JSON text the model produced
  result: string | null; // JSON text from the executor; null while pending
  isError: boolean;
}

// ProposalResult is the shape returned by the propose_skill tool.
interface ProposalResult {
  proposal?: boolean;
  task_id?: string;
  duplicate?: boolean;
  skill_key?: string;
  cluster?: string;
  volume_id?: number;
  status?: string;
  message?: string;
}

// SkillProposalCard renders a propose_skill result as an actionable
// confirmation: the SOP was queued as a PENDING task, and the operator
// confirms by approving + running it (or opening the Tasks page).
function SkillProposalCard({ result }: { result: ProposalResult }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");

  const approveRun = async () => {
    if (!result.task_id) return;
    setBusy(true);
    setErr("");
    try {
      await api.approveTask(result.task_id);
      await api.runTask(result.task_id);
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-accent/40 bg-accent/[0.04] text-[11px] overflow-hidden">
      <div className="px-2.5 py-1.5 flex items-center gap-1.5 border-b border-accent/20">
        <Wrench size={12} className="text-accent shrink-0"/>
        <span className="font-semibold">{t("SOP proposal")}</span>
        <span className="font-mono text-muted truncate">{result.skill_key}</span>
      </div>
      <div className="px-2.5 py-2 space-y-2">
        <div className="flex items-center gap-2 flex-wrap text-muted">
          {result.cluster && (
            <span>{t("Cluster")}: <span className="text-text">{result.cluster}</span></span>
          )}
          {!!result.volume_id && result.volume_id > 0 && (
            <span>{t("Volume")}: <span className="text-text font-mono">#{result.volume_id}</span></span>
          )}
          <span className={`badge text-[10px] ${
            done ? "border-success/40 text-success" : "border-warning/40 text-warning"
          }`}>
            {done ? t("Executing") : t("Pending approval")}
          </span>
        </div>
        {result.message && <p className="text-muted leading-relaxed">{result.message}</p>}
        {err && (
          <div className="text-danger inline-flex items-start gap-1">
            <AlertTriangle size={11} className="shrink-0 mt-0.5"/> {err}
          </div>
        )}
        {done ? (
          <div className="text-success inline-flex items-center gap-1">
            <Check size={11}/> {t("Approved — running. Watch Executions for progress.")}
          </div>
        ) : (
          <div className="flex items-center gap-3 pt-0.5">
            {!result.duplicate && result.task_id && (
              <button
                onClick={approveRun}
                disabled={busy}
                className="btn btn-primary text-[11px] py-1 px-2 inline-flex items-center gap-1 disabled:opacity-50"
              >
                {busy ? <Loader2 size={11} className="animate-spin"/> : <Check size={11}/>}
                {t("Approve & run")}
              </button>
            )}
            <a href="/activity?tab=tasks" className="text-accent hover:underline">
              {t("Open in Tasks")} →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ToolCallCard renders one tool invocation as a collapsible inline
// card so the operator can see what the model decided to look up and
// what came back. Compact by default; click to expand args + result.
function ToolCallCard({ call }: { call: LiveTool }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  // A finished propose_skill call renders as an actionable proposal
  // card instead of the raw JSON dump.
  if (call.name === "propose_skill" && call.result && !call.isError) {
    const parsed = safeParse(call.result);
    if (parsed && (parsed.task_id || parsed.duplicate)) {
      return <SkillProposalCard result={parsed}/>;
    }
  }

  // Per-tool deep-link cards — replaces the raw JSON dump for known
  // tools so the operator gets a summary + "Open <page>" button. Falls
  // through to the default expandable card when no renderer is
  // registered, the call errored, or it's still streaming.
  const customCard = renderToolResult(call);
  if (customCard) return customCard;

  const tone = call.isError
    ? "border-danger/40 bg-danger/5 text-danger"
    : call.result === null
      ? "border-warning/40 bg-warning/5 text-warning"
      : "border-border bg-panel2/50";
  const Icon = call.result === null ? Hammer : Wrench;
  const status = call.isError
    ? t("Tool failed")
    : call.result === null
      ? t("Running…")
      : t("Done");
  return (
    <div className={`rounded-md border text-[11px] ${tone}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full px-2.5 py-1.5 flex items-center justify-between gap-2 hover:brightness-110"
      >
        <span className="inline-flex items-center gap-1.5 min-w-0">
          {call.result === null
            ? <Hammer size={11} className="animate-pulse"/>
            : <Icon size={11}/>}
          <span className="font-mono truncate">{call.name}</span>
          <span className="text-muted">— {status}</span>
        </span>
        {open ? <ChevronUp size={11}/> : <ChevronDown size={11}/>}
      </button>
      {open && (
        <div className="px-2.5 py-1.5 border-t border-border/60 space-y-1.5">
          <div>
            <div className="text-muted text-[10px] mb-0.5">{t("Arguments")}</div>
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-bg/40 rounded px-1.5 py-1">
              {safeFormat(call.arguments)}
            </pre>
          </div>
          {call.result !== null && (
            <div>
              <div className="text-muted text-[10px] mb-0.5">
                {call.isError ? t("Error") : t("Result")}
              </div>
              <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-bg/40 rounded px-1.5 py-1 max-h-48 overflow-auto">
                {safeFormat(call.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// safeFormat pretty-prints JSON when possible; falls back to the raw
// string for partial/invalid payloads. Keeps the UI from crashing on
// streaming fragments.
function safeFormat(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// safeParse returns a parsed JSON object, or null for non-object /
// invalid payloads (e.g. a partial streaming fragment).
function safeParse(s: string): ProposalResult | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as ProposalResult) : null;
  } catch {
    return null;
  }
}
