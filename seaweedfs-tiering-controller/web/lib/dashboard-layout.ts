"use client";

// Per-user dashboard layout. Order of cards / charts inside each row is
// saved to localStorage so reloads remember "the operator put pending
// before total size". When the app ships a new card the saved order
// won't contain its id, so we append the new id at the end rather than
// silently dropping it.

const KEY_PREFIX = "tier.dashboard.layout.";

export function loadOrder(rowKey: string, currentIds: string[]): string[] {
  if (typeof window === "undefined") return currentIds;
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + rowKey);
    if (!raw) return currentIds;
    const saved = JSON.parse(raw) as unknown;
    if (!Array.isArray(saved)) return currentIds;
    const savedStr = saved.filter((x): x is string => typeof x === "string");
    const currentSet = new Set(currentIds);
    const savedSet = new Set(savedStr);
    // Saved order first (filtered to whatever's currently visible), then
    // any newly-added cards appended in their default position.
    const ordered: string[] = [];
    for (const id of savedStr) if (currentSet.has(id)) ordered.push(id);
    for (const id of currentIds) if (!savedSet.has(id)) ordered.push(id);
    return ordered;
  } catch {
    return currentIds;
  }
}

export function saveOrder(rowKey: string, order: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_PREFIX + rowKey, JSON.stringify(order));
  } catch {
    /* private mode / quota — drop silently, in-memory ordering still works */
  }
}

export function resetOrder(rowKey: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY_PREFIX + rowKey);
  } catch {
    /* ignore */
  }
}

// Resets every dashboard row at once — used by the "Reset layout" toolbar
// button. Walks localStorage keys to support future rows without needing
// to keep a hardcoded list here.
export function resetAllOrders(): void {
  if (typeof window === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
