// Skeleton placeholder rows for tables that match the .grid layout. Renders
// as a real <table> so column widths stay stable when real data arrives.
// Each cell pulses with the shared animation so the page never looks frozen.

interface TableSkeletonProps {
  rows?: number;
  cols?: number;
  headers?: string[];
}

export function TableSkeleton({ rows = 5, cols, headers }: TableSkeletonProps) {
  const n = headers?.length ?? cols ?? 5;
  return (
    <table className="grid">
      <thead>
        <tr>
          {Array.from({ length: n }).map((_, i) => (
            <th key={i}>{headers?.[i] ?? <SkeletonBar w="60%"/>}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r}>
            {Array.from({ length: n }).map((_, c) => (
              <td key={c}><SkeletonBar w={c === 0 ? "70%" : c === n - 1 ? "40%" : "85%"}/></td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Inline skeleton bar — used inside the table cells and reusable anywhere
// async content needs a placeholder of known width.
export function SkeletonBar({ w = "100%", h = "0.9rem" }: { w?: string; h?: string }) {
  return (
    <span
      className="inline-block rounded bg-panel2 animate-pulse align-middle"
      style={{ width: w, height: h }}
    />
  );
}
