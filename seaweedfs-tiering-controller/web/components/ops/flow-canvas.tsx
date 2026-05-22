"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodesChange,
  type OnEdgesChange,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Connection,
  Handle,
  Position,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { OpsStep } from "@/lib/api";
import { CheckCircle2, Loader2, AlertTriangle, Sparkles, SkipForward, Circle, X } from "lucide-react";

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/** Per-step runtime status drives node coloring in the live runner view.
 *  In editor mode every node is "idle". */
export type StepRunStatus =
  | "idle"
  | "pending"
  | "running"
  | "awaiting"
  | "done"
  | "error"
  | "skipped";

export interface FlowStepStatus {
  status: StepRunStatus;
  /** Truncated output preview shown on hover/click — full output lives
   *  in the side panel, not the node. */
  outputPreview?: string;
  error?: string;
}

/** Data carried on each ReactFlow node. Kept JSON-serialisable so
 *  ReactFlow's internal change-batching doesn't fight with React. */
interface StepNodeData extends Record<string, unknown> {
  step: OpsStep;
  status: StepRunStatus;
  outputPreview?: string;
  error?: string;
  editable: boolean;
  selected?: boolean;
  onClick?: (id: string) => void;
  /** Inline-delete from the canvas. Wired only when editable=true. */
  onDelete?: (id: string) => void;
}

// ---------------------------------------------------------------------
// Layout — simple level-based BFS
// ---------------------------------------------------------------------

const NODE_W = 240;
const NODE_H = 90;
const COL_GAP = 110; // gap between dependency levels
const ROW_GAP = 30;  // gap between sibling nodes in the same level

/** Compute a deterministic (x,y) position for each step based on its
 *  depth in the DAG. Steps with explicit `position` are honoured;
 *  everything else fans out by topological level. */
function layoutSteps(steps: OpsStep[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  // Honour saved positions first.
  for (const s of steps) {
    if (s.id && s.position) {
      out.set(s.id, { x: s.position.x, y: s.position.y });
    }
  }
  // BFS by depends_on depth for nodes without saved positions.
  const idToStep = new Map(steps.filter(s => s.id).map(s => [s.id!, s]));
  const depth = new Map<string, number>();
  const compute = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // shouldn't happen (cycle), guard
    seen.add(id);
    const step = idToStep.get(id);
    if (!step || !step.depends_on || step.depends_on.length === 0) {
      depth.set(id, 0);
      return 0;
    }
    let d = 0;
    for (const dep of step.depends_on) {
      d = Math.max(d, compute(dep, seen) + 1);
    }
    depth.set(id, d);
    return d;
  };
  for (const s of steps) {
    if (s.id) compute(s.id, new Set());
  }
  // Bucket by depth, lay rows.
  const buckets = new Map<number, string[]>();
  for (const [id, d] of depth.entries()) {
    if (out.has(id)) continue; // already placed (saved position)
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d)!.push(id);
  }
  for (const [d, ids] of buckets.entries()) {
    const totalH = ids.length * NODE_H + (ids.length - 1) * ROW_GAP;
    const startY = -totalH / 2;
    ids.forEach((id, i) => {
      out.set(id, {
        x: d * (NODE_W + COL_GAP),
        y: startY + i * (NODE_H + ROW_GAP),
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Custom step node
// ---------------------------------------------------------------------

function StepNode({ id, data }: NodeProps) {
  const d = data as StepNodeData;
  const { step, status, error, outputPreview, editable, selected, onClick, onDelete } = d;
  const ICON: Record<StepRunStatus, React.ReactNode> = {
    idle:     <Circle size={12} className="text-muted"/>,
    pending:  <Circle size={12} className="text-muted"/>,
    running:  <Loader2 size={12} className="animate-spin text-amber-300"/>,
    awaiting: <Sparkles size={12} className="text-amber-300"/>,
    done:     <CheckCircle2 size={12} className="text-emerald-400"/>,
    error:    <AlertTriangle size={12} className="text-rose-400"/>,
    skipped:  <SkipForward size={12} className="text-muted"/>,
  };
  const RING: Record<StepRunStatus, string> = {
    idle:     "border-border",
    pending:  "border-border",
    running:  "border-amber-400/60 shadow-[0_0_0_3px_oklch(82%_0.17_82_/_0.15)]",
    awaiting: "border-amber-400/60",
    done:     "border-emerald-400/40",
    error:    "border-rose-400/60",
    skipped:  "border-border opacity-60",
  };
  return (
    <div
      onClick={() => onClick?.(id)}
      className={`group bg-panel border ${RING[status]} ${selected ? "ring-2 ring-accent/40" : ""}
                  rounded-lg p-3 shadow-soft cursor-pointer
                  transition-all hover:border-accent/60 relative`}
      style={{ width: NODE_W, minHeight: NODE_H }}
    >
      {/* Targets accept incoming edges; sources emit them. ReactFlow
          renders the actual SVG handles — we just position them. */}
      <Handle type="target" position={Position.Left} style={{ background: "oklch(var(--c-muted))" }} />
      <Handle type="source" position={Position.Right} style={{ background: "oklch(var(--c-accent))" }} />

      {/* Inline delete button on hover. Only in editor mode. Stops
          propagation so a click on the X doesn't also select the
          node. */}
      {editable && onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(id); }}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-panel border border-border
                     text-muted hover:text-rose-300 hover:border-rose-400/60
                     opacity-0 group-hover:opacity-100 transition-opacity
                     flex items-center justify-center shadow-soft"
          title="Delete step"
          aria-label="Delete step"
        >
          <X size={11}/>
        </button>
      )}

      <div className="flex items-center gap-2 mb-1">
        {ICON[status]}
        <div className="font-mono text-[11px] text-muted shrink-0">{step.id}</div>
        {step.confirm_before && (
          <span className="text-[9px] px-1 rounded bg-amber-400/15 text-amber-300">confirm</span>
        )}
      </div>
      <div className="text-xs font-medium truncate" title={step.command}>
        {step.command}
      </div>
      {step.args && (
        <div className="text-[10px] text-muted font-mono truncate mt-0.5" title={step.args}>
          {step.args}
        </div>
      )}
      {status === "error" && error && (
        <div className="text-[10px] text-rose-300 mt-1 line-clamp-2" title={error}>
          {error}
        </div>
      )}
      {status === "running" && outputPreview && (
        <div className="text-[10px] text-muted mt-1 line-clamp-1 font-mono" title={outputPreview}>
          {outputPreview}
        </div>
      )}
      {!editable && status === "idle" && <></>}
    </div>
  );
}

const nodeTypes = { step: StepNode };

// ---------------------------------------------------------------------
// FlowCanvas
// ---------------------------------------------------------------------

export interface FlowCanvasProps {
  steps: OpsStep[];
  /** Per-step runtime status keyed by step.id. Missing keys default
   *  to "idle". */
  statuses?: Record<string, FlowStepStatus>;
  /** When true the canvas allows drag, connect, and surfaces edits
   *  back via onChange. When false the canvas is view-only (run view). */
  editable?: boolean;
  /** Currently-selected step id (for editor side panel). */
  selectedId?: string;
  onSelect?: (id: string | null) => void;
  /** Called on any structural change: position moves, new edges,
   *  removed nodes. The canvas hands back the full updated step
   *  array so the parent can persist it as one atomic state. */
  onChange?: (steps: OpsStep[]) => void;
  /** Height for the canvas container. Defaults to 480px. */
  height?: number | string;
}

function FlowCanvasInner({
  steps, statuses, editable = false, selectedId, onSelect, onChange, height = 480,
}: FlowCanvasProps) {
  const { setViewport } = useReactFlow();

  // Layout cache — recompute when steps array changes structurally.
  const layoutKey = useMemo(
    () => steps.map(s => `${s.id}:${(s.depends_on || []).join(",")}:${s.position ? `${s.position.x},${s.position.y}` : ""}`).join("|"),
    [steps],
  );
  const layout = useMemo(() => layoutSteps(steps), [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remove a step by id, plus any depends_on references pointing at
  // it on the remaining steps so we never end with dangling edges.
  // Used by both the inline X button on each node and the Delete-key
  // handler in onNodesChange below.
  const deleteStep = useCallback((stepId: string) => {
    if (!editable || !onChange) return;
    onChange(
      steps
        .filter(s => s.id !== stepId)
        .map(s => ({
          ...s,
          depends_on: (s.depends_on ?? []).filter(d => d !== stepId),
        })),
    );
    if (selectedId === stepId) onSelect?.(null);
  }, [editable, onChange, steps, selectedId, onSelect]);

  // Map steps + statuses → ReactFlow nodes/edges every render. Cheap
  // because each render produces stable shapes; React diffing keeps
  // DOM updates minimal.
  const nodes: Node[] = useMemo(() => {
    return steps.filter(s => s.id).map(s => {
      const pos = s.position ?? layout.get(s.id!) ?? { x: 0, y: 0 };
      const st = statuses?.[s.id!];
      return {
        id: s.id!,
        type: "step",
        position: pos,
        data: {
          step: s,
          status: st?.status ?? "idle",
          outputPreview: st?.outputPreview,
          error: st?.error,
          editable,
          selected: selectedId === s.id,
          onClick: (id: string) => onSelect?.(id),
          onDelete: editable ? deleteStep : undefined,
        } as StepNodeData,
        draggable: editable,
        // Lets ReactFlow include this node in "remove" change events
        // when the operator hits Delete/Backspace with it selected.
        deletable: editable,
      };
    });
  }, [steps, statuses, editable, selectedId, layout, onSelect, deleteStep]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const s of steps) {
      if (!s.id) continue;
      for (const dep of s.depends_on || []) {
        const targetStatus = statuses?.[s.id]?.status;
        const sourceStatus = statuses?.[dep]?.status;
        // Animate when the upstream is done and the downstream is
        // about to start — gives a visual cue of "in transit".
        const animated =
          sourceStatus === "done" && (targetStatus === "running" || targetStatus === "awaiting");
        out.push({
          id: `${dep}->${s.id}`,
          source: dep,
          target: s.id,
          animated,
          style: {
            stroke:
              sourceStatus === "error" || sourceStatus === "skipped"
                ? "oklch(70% 0.18 22 / 0.4)"
                : sourceStatus === "done"
                ? "oklch(var(--c-accent) / 0.7)"
                : "oklch(var(--c-border))",
            strokeWidth: 2,
          },
        });
      }
    }
    return out;
  }, [steps, statuses]);

  // Track position changes via onNodesChange. We don't store nodes in
  // local state (would fight with parent ownership); instead, when a
  // drag finishes (type:"position" + dragging:false) we emit a step
  // update to the parent. Also handles "remove" changes fired by
  // ReactFlow when the operator presses Delete/Backspace on a
  // selected node.
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      if (!editable || !onChange) return;
      // 1. Removals first (Delete / Backspace).
      const removedIds: string[] = [];
      for (const c of changes) {
        if (c.type === "remove") removedIds.push(c.id);
      }
      if (removedIds.length > 0) {
        const removedSet = new Set(removedIds);
        onChange(
          steps
            .filter(s => !s.id || !removedSet.has(s.id))
            .map(s => ({
              ...s,
              depends_on: (s.depends_on ?? []).filter(d => !removedSet.has(d)),
            })),
        );
        if (selectedId && removedSet.has(selectedId)) onSelect?.(null);
        return; // ignore concurrent position changes on the removed nodes
      }
      // 2. Position changes (drag end).
      const updates = new Map<string, { x: number; y: number }>();
      for (const c of changes) {
        if (c.type === "position" && c.dragging === false && c.position) {
          updates.set(c.id, c.position);
        }
      }
      if (updates.size === 0) return;
      onChange(
        steps.map(s =>
          s.id && updates.has(s.id) ? { ...s, position: updates.get(s.id)! } : s
        )
      );
    },
    [editable, onChange, steps, selectedId, onSelect],
  );

  // Drawing a new edge: add depends_on on the target step. We never
  // create cycles — block self-edges and duplicates.
  const onConnect = useCallback(
    (conn: Connection) => {
      if (!editable || !onChange) return;
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      onChange(
        steps.map(s => {
          if (s.id !== conn.target) return s;
          const existing = new Set(s.depends_on ?? []);
          if (existing.has(conn.source!)) return s;
          return { ...s, depends_on: [...existing, conn.source!] };
        })
      );
    },
    [editable, onChange, steps],
  );

  // Deleting an edge removes the depends_on entry on the target.
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      if (!editable || !onChange) return;
      const toRemove: { src: string; tgt: string }[] = [];
      for (const c of changes) {
        if (c.type === "remove") {
          const m = c.id.match(/^(.+)->(.+)$/);
          if (m) toRemove.push({ src: m[1], tgt: m[2] });
        }
      }
      if (toRemove.length === 0) return;
      onChange(
        steps.map(s => {
          if (!s.id) return s;
          const drops = toRemove.filter(r => r.tgt === s.id);
          if (drops.length === 0) return s;
          return {
            ...s,
            depends_on: (s.depends_on ?? []).filter(d => !drops.some(r => r.src === d)),
          };
        })
      );
    },
    [editable, onChange, steps],
  );

  // Auto-fit on first render so a fresh template doesn't open with
  // nodes off-screen.
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current) return;
    if (nodes.length === 0) return;
    fittedRef.current = true;
    // Defer to next tick so ReactFlow has laid out.
    requestAnimationFrame(() => setViewport({ x: 80, y: 200, zoom: 0.85 }));
  }, [nodes.length, setViewport]);

  return (
    // Outer wrapper: thick enough border that the canvas reads as a
    // distinct surface against the page background — without this the
    // MiniMap (also light) blended into the canvas and operators
    // missed it. Inner shadow gives the dot-grid background some
    // perceived depth.
    <div
      style={{ height, width: "100%" }}
      className="rounded-lg border-2 border-border bg-panel2/60 shadow-inner overflow-hidden relative"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={() => onSelect?.(null)}
        nodesDraggable={editable}
        nodesConnectable={editable}
        edgesReconnectable={editable}
        elementsSelectable={true}
        // Built-in delete-on-key for selected nodes/edges. We still
        // process the "remove" change in onNodesChange so depends_on
        // gets cleaned up.
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1.5} color="oklch(var(--c-border) / 0.7)" />
        <Controls
          showInteractive={false}
          // Match the MiniMap chrome so the two corner widgets feel
          // like a set rather than two random floats.
          style={{
            border: "1px solid oklch(var(--c-border))",
            borderRadius: 8,
            overflow: "hidden",
            boxShadow: "0 2px 8px oklch(0% 0 0 / 0.08)",
          }}
        />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const st = (n.data as StepNodeData).status;
            if (st === "done") return "oklch(var(--c-success))";
            if (st === "error") return "oklch(var(--c-danger))";
            if (st === "running" || st === "awaiting") return "oklch(var(--c-warning))";
            return "oklch(var(--c-muted))";
          }}
          maskColor="oklch(var(--c-bg) / 0.55)"
          // Strong border + soft shadow + small radius so the MiniMap
          // visibly floats above the canvas and is discoverable. On
          // light themes the previous bare-panel rendering was almost
          // invisible against the dot grid.
          style={{
            backgroundColor: "oklch(var(--c-panel))",
            border: "1px solid oklch(var(--c-border))",
            borderRadius: 8,
            boxShadow: "0 4px 12px oklch(0% 0 0 / 0.12)",
          }}
        />
      </ReactFlow>
      {editable && (
        // Quiet bottom-left hint so first-time editors know the delete
        // affordances. Pointer-events:none so it can't intercept canvas
        // gestures (pan/select).
        <div
          className="absolute left-3 bottom-3 text-[10px] text-muted/70 pointer-events-none
                     bg-panel/80 backdrop-blur px-2 py-1 rounded border border-border/60"
        >
          hover a node to delete · ⌫ removes selection
        </div>
      )}
    </div>
  );
}

/** FlowCanvas is the shared graph renderer used by both the template
 *  editor (editable=true) and the live run view (editable=false). */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

// Suppress unused imports when consumer hosts don't use them.
void applyNodeChanges; void applyEdgeChanges; void addEdge;
