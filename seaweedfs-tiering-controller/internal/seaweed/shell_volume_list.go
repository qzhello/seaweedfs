package seaweed

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// ListVolumesShellAt invokes `weed shell volume.list` against the given
// master and parses the indented text output into the same VolumeInfo +
// NodeDiskStats slices that the gRPC ListVolumesAt / ListNodesAt pair
// returns. A single shell call yields both, so the cache layer can fold
// two RPCs into one subprocess invocation.
//
// Why text parsing instead of gRPC: master_pb.VolumeList has changed
// fields and required permissions across SeaweedFS releases. `weed shell
// volume.list` is the user-facing CLI surface and stays stable; running
// the cluster's own `weed` binary (per cluster.weed_bin_path) guarantees
// the parser sees output that matches the cluster version.
//
// The lock/unlock dance is skipped for this read-only call so concurrent
// dashboard refreshes don't serialise on the cluster-wide shell lock.
func (c *Client) ListVolumesShellAt(ctx context.Context, master, binPath string) ([]VolumeInfo, []NodeDiskStats, error) {
	out, err := c.RunShellReadOnly(ctx, master, binPath, "volume.list", nil)
	if err != nil {
		return nil, nil, err
	}
	return parseVolumeListOutput(out), parseNodeDiskStats(out), nil
}

// volume.list emits each volume as a CamelCase key/value list separated
// by commas, e.g.:
//
//   volume Id:7, Size:8, ReplicaPlacement:010, Collection:test, FileCount:0, ReadOnly:true, ModifiedAtSecond:1778254383
//
// The regex captures Key:Value where Value runs up to the next comma or
// newline. Empty values (`Collection:,`) are allowed so we don't lose the
// row just because the default-collection field is blank.
var volumeFieldRE = regexp.MustCompile(`([A-Za-z_][A-Za-z0-9_]*):([^,\n]*)`)

// parseVolumeListOutput walks the tree-shaped output of `volume.list`,
// emitting one VolumeInfo per "volume ..." line and inheriting DC / rack /
// node / disk context from the surrounding indentation level.
func parseVolumeListOutput(out string) []VolumeInfo {
	var (
		dc, rack, node, disk string
		vols                 []VolumeInfo
	)
	for _, raw := range strings.Split(out, "\n") {
		trim := strings.TrimLeft(raw, " \t")
		if trim == "" {
			continue
		}
		switch {
		case strings.HasPrefix(trim, "DataCenter "):
			dc = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "Rack "):
			rack = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "DataNode "):
			node = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "Disk "):
			// Skip the per-disk summary footer ("Disk hdd {Size:... ...}").
			// Only the header line ("Disk hdd(volume:5/200 ...)") carries
			// the disk type we want; the {...} payload would otherwise
			// leak into v.DiskType for every volume below it.
			if !strings.Contains(trim, "(") || strings.Contains(trim, "{") {
				continue
			}
			disk = diskTypeFromLine(trim)
		case strings.HasPrefix(trim, "ec volume "):
			// EC line shape (verbosityLevel >= 5):
			//   ec volume id:7 collection:mybucket shards:[0 1 3] sizes:[1024 2048 4096] total:7168
			// `shards:[..]` and `sizes:[..]` use space-separated decimals
			// inside brackets and don't fit the generic key:value regex.
			v := parseECVolumeFields(trim)
			v.Server = node
			v.Rack = rack
			v.DataCenter = dc
			if v.DiskType == "" {
				v.DiskType = disk
			}
			v.IsEC = true
			v.ReadOnly = true // EC volumes are always read-only.
			vols = append(vols, v)
		case strings.HasPrefix(trim, "volume "):
			v := parseVolumeFields(trim)
			v.Server = node
			v.Rack = rack
			v.DataCenter = dc
			if v.DiskType == "" {
				v.DiskType = disk
			}
			vols = append(vols, v)
		}
	}
	return vols
}

// parseECVolumeFields parses an `ec volume …` row from `volume.list`.
//
// Example: `ec volume id:7 collection:mybucket shards:[0 1 3] sizes:[1024 2048 4096] total:7168 disk_type:hdd`
//
// The fields are space-separated (no commas), so we extract each key with
// an anchored scalar regex rather than reuse the comma-tolerant matcher.
// Bracketed lists are parsed separately.
func parseECVolumeFields(line string) VolumeInfo {
	var v VolumeInfo
	if s := scanToken(line, "id:"); s != "" {
		if n, err := strconv.ParseUint(s, 10, 32); err == nil {
			v.ID = uint32(n)
		}
	}
	if s := scanToken(line, "collection:"); s != "" {
		v.Collection = s
	}
	if s := scanToken(line, "disk_type:"); s != "" {
		v.DiskType = s
	} else if s := scanToken(line, "diskType:"); s != "" {
		v.DiskType = s
	}
	if s := scanToken(line, "file_count:"); s != "" {
		v.FileCount, _ = strconv.ParseUint(s, 10, 64)
	}
	if s := scanToken(line, "delete_count:"); s != "" {
		v.DeleteCount, _ = strconv.ParseUint(s, 10, 64)
	}
	v.Shards = parseBracketIntList(line, "shards:")
	if sizes := parseBracketUintList(line, "sizes:"); len(sizes) > 0 {
		v.ShardSizes = sizes
		for _, s := range sizes {
			v.Size += s
		}
	}
	if v.Size == 0 {
		if total := scanUint(line, "total:"); total > 0 {
			v.Size = total
		}
	}
	return v
}

// scanToken returns the token following `prefix` in line, stopping at the
// next space or end-of-line. Prefix must be preceded by start-of-string or
// whitespace so e.g. scanning `id:` does not match the suffix of `disk_id:`.
// Quotes around the value are unwrapped. Tokens starting with `[` are
// rejected — bracketed list fields are handled separately.
func scanToken(line, prefix string) string {
	off := 0
	for {
		i := strings.Index(line[off:], prefix)
		if i < 0 {
			return ""
		}
		abs := off + i
		// Require word-boundary on the left (start-of-string or whitespace)
		// so `id:` does not glue onto `disk_id:7`.
		if abs > 0 {
			c := line[abs-1]
			if c != ' ' && c != '\t' && c != '\n' {
				off = abs + len(prefix)
				continue
			}
		}
		rest := line[abs+len(prefix):]
		if len(rest) > 0 && rest[0] == '[' {
			return ""
		}
		end := strings.IndexAny(rest, " \t\n")
		if end < 0 {
			end = len(rest)
		}
		tok := rest[:end]
		if len(tok) >= 2 && tok[0] == '"' && tok[len(tok)-1] == '"' {
			tok = tok[1 : len(tok)-1]
		}
		return tok
	}
}

// parseBracketIntList finds `prefix[…]` in line and returns the decimals.
// Returns nil when the bracketed list is absent or malformed.
func parseBracketIntList(line, prefix string) []int {
	body, ok := bracketBody(line, prefix)
	if !ok {
		return nil
	}
	if strings.TrimSpace(body) == "" {
		return []int{}
	}
	out := make([]int, 0, 14)
	for _, tok := range strings.Fields(body) {
		n, err := strconv.Atoi(tok)
		if err != nil {
			continue
		}
		out = append(out, n)
	}
	return out
}

func parseBracketUintList(line, prefix string) []uint64 {
	body, ok := bracketBody(line, prefix)
	if !ok {
		return nil
	}
	if strings.TrimSpace(body) == "" {
		return []uint64{}
	}
	out := make([]uint64, 0, 14)
	for _, tok := range strings.Fields(body) {
		n, err := strconv.ParseUint(tok, 10, 64)
		if err != nil {
			continue
		}
		out = append(out, n)
	}
	return out
}

// bracketBody returns the substring between `[` and `]` immediately after
// the given prefix; false if no bracket pair follows.
func bracketBody(line, prefix string) (string, bool) {
	i := strings.Index(line, prefix)
	if i < 0 {
		return "", false
	}
	open := strings.Index(line[i:], "[")
	if open < 0 {
		return "", false
	}
	open += i
	close := strings.Index(line[open:], "]")
	if close < 0 {
		return "", false
	}
	return line[open+1 : open+close], true
}

// scanUint returns the unsigned int after `prefix` in line, or 0 if absent.
func scanUint(line, prefix string) uint64 {
	i := strings.Index(line, prefix)
	if i < 0 {
		return 0
	}
	rest := line[i+len(prefix):]
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0
	}
	n, _ := strconv.ParseUint(rest[:end], 10, 64)
	return n
}

// parseNodeDiskStats walks the same output and collects one row per
// (node, disk-type) tuple. The summary line carries counts; bytes are
// summed from the volumes nested below.
func parseNodeDiskStats(out string) []NodeDiskStats {
	type key struct{ node, disk string }
	stats := map[key]*NodeDiskStats{}
	var dc, rack, node, disk string
	for _, raw := range strings.Split(out, "\n") {
		trim := strings.TrimLeft(raw, " \t")
		if trim == "" {
			continue
		}
		switch {
		case strings.HasPrefix(trim, "DataCenter "):
			dc = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "Rack "):
			rack = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "DataNode "):
			node = fieldAt(trim, 1)
		case strings.HasPrefix(trim, "Disk "):
			// SeaweedFS shell emits two `Disk` lines per disk:
			//   header  → "Disk hdd(volume:5/200 active:5 free:195 remote:0) id:1"
			//   summary → "Disk hdd {Size:... FileCount:... DeletedFileCount:... DeletedBytes:...}"
			// Only the header carries the counts we parse. The summary
			// line has `{` instead of `(` — skip it so we don't end up
			// with a bogus disk_type that includes the {...} payload.
			if !strings.Contains(trim, "(") || strings.Contains(trim, "{") {
				continue
			}
			disk = diskTypeFromLine(trim)
			ns := &NodeDiskStats{
				Server: node, Rack: rack, DataCenter: dc, DiskType: disk,
			}
			fillDiskCounts(ns, trim)
			stats[key{node, disk}] = ns
		case strings.HasPrefix(trim, "volume "):
			v := parseVolumeFields(trim)
			if ns, ok := stats[key{node, disk}]; ok {
				ns.UsedBytes += v.Size
			}
		case strings.HasPrefix(trim, "ec volume "):
			v := parseECVolumeFields(trim)
			if ns, ok := stats[key{node, disk}]; ok {
				ns.UsedBytes += v.Size
			}
		}
	}
	out2 := make([]NodeDiskStats, 0, len(stats))
	for _, ns := range stats {
		out2 = append(out2, *ns)
	}
	return out2
}

// `Disk hdd(volume:5/200 active:5 free:195 remote:0)` → "hdd".
func diskTypeFromLine(line string) string {
	rest := strings.TrimPrefix(line, "Disk ")
	if i := strings.Index(rest, "("); i > 0 {
		return strings.TrimSpace(rest[:i])
	}
	return strings.TrimSpace(rest)
}

// fillDiskCounts pulls the volume:N/M / active:N / free:N / remote:N counts
// from the parenthesised summary on a Disk line.
func fillDiskCounts(ns *NodeDiskStats, line string) {
	lp := strings.Index(line, "(")
	rp := strings.LastIndex(line, ")")
	if lp < 0 || rp <= lp {
		return
	}
	for _, kv := range strings.Fields(line[lp+1 : rp]) {
		colon := strings.Index(kv, ":")
		if colon <= 0 {
			continue
		}
		k, v := kv[:colon], kv[colon+1:]
		if k == "volume" {
			if slash := strings.Index(v, "/"); slash > 0 {
				ns.VolumeCount, _ = strconv.ParseInt(v[:slash], 10, 64)
				ns.MaxVolumeCount, _ = strconv.ParseInt(v[slash+1:], 10, 64)
			}
			continue
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			continue
		}
		switch k {
		case "active":
			ns.ActiveVolumeCount = n
		case "free":
			ns.FreeVolumeCount = n
		case "remote":
			ns.RemoteVolumeCount = n
		}
	}
}

// parseVolumeFields accepts both the modern CamelCase format
// ("Id:7, Size:8, Collection:test, …") emitted by storage.VolumeInfo.String()
// and the legacy proto-text snake_case ("id:7 size:8 collection:\"test\" …")
// that older builds use. Quoted values are unwrapped; trailing whitespace
// from the comma-separated form is trimmed.
func parseVolumeFields(line string) VolumeInfo {
	var v VolumeInfo
	for _, m := range volumeFieldRE.FindAllStringSubmatch(line, -1) {
		key, val := m[1], strings.TrimSpace(m[2])
		if len(val) >= 2 && val[0] == '"' && val[len(val)-1] == '"' {
			val = val[1 : len(val)-1]
		}
		switch key {
		case "Id", "id":
			n, _ := strconv.ParseUint(val, 10, 32)
			v.ID = uint32(n)
		case "Size", "size":
			v.Size, _ = strconv.ParseUint(val, 10, 64)
		case "Collection", "collection":
			v.Collection = val
		case "FileCount", "file_count":
			v.FileCount, _ = strconv.ParseUint(val, 10, 64)
		case "DeleteCount", "delete_count":
			v.DeleteCount, _ = strconv.ParseUint(val, 10, 64)
		case "DeletedByteCount", "deleted_byte_count":
			v.DeletedBytes, _ = strconv.ParseUint(val, 10, 64)
		case "ReadOnly", "read_only":
			v.ReadOnly = val == "true"
		case "ModifiedAtSecond", "modified_at_second":
			v.ModifiedAtSec, _ = strconv.ParseInt(val, 10, 64)
		case "ReplicaPlacement", "replica_placement":
			// "010" is a 3-digit dc-rack-node code, base 10 parse is fine.
			n, _ := strconv.ParseUint(val, 10, 32)
			v.ReplicaPlace = uint32(n)
		case "DiskType", "disk_type":
			v.DiskType = val
		case "RemoteStorageName", "remote_storage_name":
			v.RemoteStorageName = val
		case "RemoteStorageKey", "remote_storage_key":
			v.RemoteStorageKey = val
		}
	}
	return v
}

func fieldAt(line string, idx int) string {
	f := strings.Fields(line)
	if idx < 0 || idx >= len(f) {
		return ""
	}
	return f[idx]
}
