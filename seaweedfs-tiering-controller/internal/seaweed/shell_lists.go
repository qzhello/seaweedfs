package seaweed

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// CollectionInfo is one row parsed from `weed shell collection.list`.
// Numeric fields are best-effort: missing or unparseable values stay zero
// so the UI can render N/A instead of failing the whole listing.
type CollectionInfo struct {
	Name         string `json:"name"`
	VolumeCount  int64  `json:"volume_count"`
	Size         uint64 `json:"size"`
	FileCount    uint64 `json:"file_count"`
	DeletedBytes uint64 `json:"deleted_bytes"`
	DeleteCount  uint64 `json:"delete_count"`
}

// BucketInfo is one row parsed from `weed shell s3.bucket.list`. The
// underlying weed format is `name  size:N  chunk:M  [quota:N usage:X% owner:"..."]`.
type BucketInfo struct {
	Name    string  `json:"name"`
	Size    uint64  `json:"size"`
	Chunks  uint64  `json:"chunks"`
	Quota   uint64  `json:"quota,omitempty"`
	UsagePc float64 `json:"usage_pc,omitempty"`
	Owner   string  `json:"owner,omitempty"`
}

// ListCollectionsShellAt runs `collection.list` against the given master
// and parses every `collection:"NAME" ...` row.
func (c *Client) ListCollectionsShellAt(ctx context.Context, master, binPath string) ([]CollectionInfo, error) {
	out, err := c.RunShellReadOnly(ctx, master, binPath, "collection.list", nil)
	if err != nil {
		return nil, err
	}
	return parseCollectionList(out), nil
}

// ListBucketsShellAt runs `s3.bucket.list` against the given master and
// parses every leaf row. The header line ("Buckets under …") is
// ignored; rows without a recognised name are skipped.
func (c *Client) ListBucketsShellAt(ctx context.Context, master, binPath string) ([]BucketInfo, error) {
	out, err := c.RunShellReadOnly(ctx, master, binPath, "s3.bucket.list", nil)
	if err != nil {
		return nil, err
	}
	return parseBucketList(out), nil
}

// collectionRE captures "collection:\"NAME\"" with the quoted name
// followed by tab-separated key:value pairs.
var collectionRE = regexp.MustCompile(`^collection:"([^"]+)"\s+(.*)$`)

func parseCollectionList(out string) []CollectionInfo {
	var rows []CollectionInfo
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Total ") {
			continue
		}
		m := collectionRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		row := CollectionInfo{Name: m[1]}
		for _, kv := range strings.Fields(m[2]) {
			k, v, ok := strings.Cut(kv, ":")
			if !ok {
				continue
			}
			n, _ := strconv.ParseFloat(v, 64)
			switch k {
			case "volumeCount":
				row.VolumeCount = int64(n)
			case "size":
				row.Size = uint64(n)
			case "fileCount":
				row.FileCount = uint64(n)
			case "deletedBytes":
				row.DeletedBytes = uint64(n)
			case "deletion":
				row.DeleteCount = uint64(n)
			}
		}
		rows = append(rows, row)
	}
	return rows
}

// bucketFieldRE captures key:value pairs from a bucket list line, where
// values may be plain (size:123) or quoted ("owner:\"abc-id\"").
var bucketFieldRE = regexp.MustCompile(`([a-z_]+):("(?:\\.|[^"\\])*"|[^\s]+)`)

// usagePcRE strips trailing % from usage values so ParseFloat works.
var usagePcRE = regexp.MustCompile(`%$`)

func parseBucketList(out string) []BucketInfo {
	var rows []BucketInfo
	for _, line := range strings.Split(out, "\n") {
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(trim, "Buckets under") || strings.HasPrefix(trim, "Total ") {
			continue
		}
		// Weed emits each bucket as "  name<TAB>size:N<TAB>chunk:M ...".
		// Splitting on tab is most reliable; fall back to first whitespace
		// if the runner has translated tabs.
		var name, rest string
		if i := strings.IndexAny(trim, "\t "); i > 0 {
			name = trim[:i]
			rest = strings.TrimSpace(trim[i:])
		} else {
			name = trim
		}
		if name == "" {
			continue
		}
		row := BucketInfo{Name: name}
		for _, m := range bucketFieldRE.FindAllStringSubmatch(rest, -1) {
			k, v := m[1], m[2]
			if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
				v = v[1 : len(v)-1]
			}
			switch k {
			case "size":
				row.Size = parseUintLoose(v)
			case "chunk":
				row.Chunks = parseUintLoose(v)
			case "quota":
				row.Quota = parseUintLoose(v)
			case "usage":
				stripped := usagePcRE.ReplaceAllString(v, "")
				n, _ := strconv.ParseFloat(stripped, 64)
				row.UsagePc = n
			case "owner":
				row.Owner = v
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func parseUintLoose(s string) uint64 {
	n, _ := strconv.ParseFloat(s, 64)
	if n < 0 {
		return 0
	}
	return uint64(n)
}
