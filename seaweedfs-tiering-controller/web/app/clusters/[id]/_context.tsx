"use client";

// Cluster-detail context lives in its own module so layout.tsx only
// exports `default`. Next.js rejects any extra exports on layout files
// ("useClusterDetail is not a valid Layout export field"), which broke
// the production build. Underscore-prefixed dir / file names are
// ignored by the App-Router file convention, so this module never
// shows up as a route.

import { createContext, useContext } from "react";

export interface ClusterDetailContextValue {
  id: string;
  // cluster/topology are intentionally loose: every consuming page
  // reaches into a different subset of fields, and modeling the full
  // wire schema here would be churn for no real type-safety win
  // (the data is server-shaped, not user-shaped). Tightening these
  // is a separate refactor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cluster: any | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topology: any | null;
  topologyError: string | null;
}

export const ClusterDetailContext =
  createContext<ClusterDetailContextValue | null>(null);

export function useClusterDetail(): ClusterDetailContextValue {
  const value = useContext(ClusterDetailContext);
  if (!value) {
    throw new Error("useClusterDetail must be used within ClusterDetailLayout");
  }
  return value;
}
