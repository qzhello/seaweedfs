"use client";

// Global "active cluster" state, shared across every page.
//
// Before this, every resource page (volumes / buckets / collections /
// ops console / ops templates) had its own local select + state. That
// works in isolation but the operator pays the cost: switching the
// cluster on /volumes resets to default when they navigate to /buckets.
//
// One source of truth in React context + localStorage so the switcher
// in the topbar drives every page, and the selection survives reloads.
// Empty string === "all clusters" / "not yet picked"; pages that can
// operate cluster-wide (like /volumes) accept that, pages that can't
// (like /buckets, /collections) prompt the operator to pick one.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "tier.cluster_id";

interface ClusterContextValue {
  clusterID: string;
  setClusterID: (id: string) => void;
}

const Ctx = createContext<ClusterContextValue>({
  clusterID: "",
  setClusterID: () => {},
});

export function ClusterProvider({ children }: { children: ReactNode }) {
  // Start empty on the server render; rehydrate from localStorage on
  // first effect so we don't trip the React hydration mismatch warning.
  const [clusterID, setRaw] = useState<string>("");
  useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v) setRaw(v);
    } catch {
      // Private mode / disabled storage — fall back to in-memory state.
    }
  }, []);

  const setClusterID = useCallback((id: string) => {
    setRaw(id);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(() => ({ clusterID, setClusterID }), [clusterID, setClusterID]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCluster() {
  return useContext(Ctx);
}
