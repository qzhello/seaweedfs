"use client";

// Generic sortable row used by the dashboard. Wraps a set of card
// nodes in a dnd-kit SortableContext and exposes a small drag handle
// that appears on hover. Order persists via localStorage (see
// lib/dashboard-layout). The PointerSensor has a 4px activation
// distance so accidental clicks on the handle don't kick off a drag.

import {
  DndContext, KeyboardSensor, PointerSensor,
  closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, arrayMove,
  rectSortingStrategy, sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { loadOrder, saveOrder } from "@/lib/dashboard-layout";

// One card / chart panel in a sortable row.
export interface SortableItem {
  id: string;
  // Skip a card entirely (e.g. Clusters card when a single cluster is
  // scoped). We accept it on the item rather than filtering upstream so
  // the saved order doesn't churn just because a card temporarily hides.
  visible?: boolean;
  node: ReactNode;
}

interface Props {
  rowKey: string;
  items: SortableItem[];
  className?: string;
}

export function SortableRow({ rowKey, items, className }: Props) {
  // Currently-visible items, in the order they were declared. The list
  // we hand to dnd-kit / persistence is a derived "saved order, filtered
  // to visible + any new ids appended" computation.
  const visibleIds = useMemo(
    () => items.filter(it => it.visible !== false).map(it => it.id),
    [items],
  );
  const nodeById = useMemo(() => {
    const m = new Map<string, ReactNode>();
    for (const it of items) m.set(it.id, it.node);
    return m;
  }, [items]);

  const [order, setOrder] = useState<string[]>(visibleIds);
  useEffect(() => {
    setOrder(loadOrder(rowKey, visibleIds));
  }, [rowKey, visibleIds]);

  const sensors = useSensors(
    // 4px activation distance — keeps the handle clickable / focusable
    // without immediately starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = order.indexOf(String(active.id));
    const newIdx = order.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(order, oldIdx, newIdx);
    setOrder(next);
    saveOrder(rowKey, next);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={rectSortingStrategy}>
        <div className={className}>
          {order.map(id => {
            const node = nodeById.get(id);
            if (!node) return null;
            return <SortableCard key={id} id={id}>{node}</SortableCard>;
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableCard({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 20 : "auto",
      }}
      className="relative group/sortable h-full"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
        className="absolute left-1 top-1 p-1 rounded text-muted/50 hover:text-text bg-panel/90 backdrop-blur opacity-0 group-hover/sortable:opacity-100 transition-opacity cursor-grab active:cursor-grabbing z-10"
      >
        <GripVertical size={12}/>
      </button>
      {children}
    </div>
  );
}
