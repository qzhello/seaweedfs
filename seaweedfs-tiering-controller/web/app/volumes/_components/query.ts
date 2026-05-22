// parseVolumeQuery splits the search box into qualifier filters and
// free tokens. Examples:
//   "id:1"             → exact ID 1
//   "id:1,2,7"         → ID in {1,2,7}
//   "collection:logs"  → exact collection (case-insensitive)
//   "server:10.0.0.5"  → server substring (case-insensitive)
//   "rack:r1 readonly" → rack=r1 plus free token "readonly"
//
// Unknown qualifiers (e.g. "foo:bar") fall through to the free-token
// list so the operator's typing isn't silently dropped — better to
// match nothing than to match unexpectedly.
export type VolumeQuery = {
  idSet: Set<number> | null;
  collection: string;
  server: string;
  rack: string;
  free: string[];
};

export function parseVolumeQuery(raw: string): VolumeQuery {
  const q: VolumeQuery = { idSet: null, collection: "", server: "", rack: "", free: [] };
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const m = tok.match(/^([a-z]+):(.+)$/i);
    if (!m) { q.free.push(tok.toLowerCase()); continue; }
    const key = m[1].toLowerCase();
    const val = m[2];
    switch (key) {
      case "id": {
        const ids = val.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n));
        if (ids.length) q.idSet = new Set(ids);
        break;
      }
      case "collection": q.collection = val.toLowerCase(); break;
      case "server":     q.server     = val.toLowerCase(); break;
      case "rack":       q.rack       = val.toLowerCase(); break;
      default:           q.free.push(tok.toLowerCase());
    }
  }
  return q;
}
