// Route-level loading boundary. Rendered by Next.js' app router while the
// new route's server component (and, in dev, its on-demand compile) is in
// flight. Without this file the main panel goes blank during navigation,
// which is what people perceive as the page being "stuck for 1-2 seconds"
// in dev mode. The sidebar stays mounted in the layout — only the panel
// below swaps to this skeleton until the real page is ready.
export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-48 rounded-md bg-panel2" />
      <div className="h-4 w-72 rounded-md bg-panel2/70" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card p-4 h-24 bg-panel2/40" />
        ))}
      </div>
      <div className="card h-72 bg-panel2/40" />
    </div>
  );
}
