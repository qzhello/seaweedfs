package api

// assistant_s3_tools.go — read-only S3 tool handlers for the floating assistant.
//
// Each exported function matches the signature expected by assistantTool.Execute:
//
//	func(ctx context.Context, d Deps, args json.RawMessage) (any, error)
//
// All five tools are read-only. None of them issue writes, deletes, or PUTs.
// They call the same seaweed client methods as the HTTP handlers but return
// map[string]any payloads sized for LLM consumption (short, no blobs).

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// toolListBuckets lists S3 buckets on a cluster. It mirrors the listBuckets
// HTTP handler but returns a trimmed payload suitable for the LLM context.
func toolListBuckets(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID string `json:"cluster_id"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("tool=list_buckets: decode args: %w", err)
	}
	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, fmt.Errorf("tool=list_buckets: %w", err)
	}

	tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	rows, err := d.Sw.ListBucketsShellAt(tctx, cl.MasterAddr, cl.WeedBinPath)
	if err != nil {
		return nil, fmt.Errorf("tool=list_buckets: shell call: %w", err)
	}

	// Enrich with controller-side governance (owner / retention).
	// Best-effort: governance miss must not blank the bucket list.
	gov, _ := d.PG.ListBucketGovernance(ctx, cl.ID)

	type bucketRow struct {
		Name          string  `json:"name"`
		SizeBytes     uint64  `json:"size_bytes"`
		Chunks        uint64  `json:"chunks"`
		QuotaMB       uint64  `json:"quota_mb,omitempty"`
		UsagePc       float64 `json:"usage_pc,omitempty"`
		Owner         string  `json:"owner,omitempty"`
		EnforceQuota  bool    `json:"enforce_quota,omitempty"`
		RetentionDays *int    `json:"retention_days,omitempty"`
		// TODO: object_count not available from s3.bucket.list output;
		// SeaweedFS does not expose per-bucket object counts via shell
		// without iterating filer metadata.
	}

	out := make([]bucketRow, 0, len(rows))
	for _, r := range rows {
		br := bucketRow{
			Name:      r.Name,
			SizeBytes: r.Size,
			Chunks:    r.Chunks,
			QuotaMB:   r.Quota,
			UsagePc:   r.UsagePc,
			Owner:     r.Owner,
		}
		if g, ok := gov[r.Name]; ok {
			if br.Owner == "" {
				br.Owner = g.OwnerName
			}
			br.RetentionDays = g.RetentionDays
		}
		out = append(out, br)
	}
	return map[string]any{
		"cluster": cl.Name,
		"count":   len(out),
		"buckets": out,
	}, nil
}

// toolGetBucket returns details for a single named S3 bucket. It pulls the
// full bucket list from the shell (no per-bucket lookup available) and filters
// to the requested name, then joins controller-side governance metadata.
func toolGetBucket(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID string `json:"cluster_id"`
		Name      string `json:"name"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("tool=get_bucket: decode args: %w", err)
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return nil, fmt.Errorf("tool=get_bucket: name is required")
	}
	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, fmt.Errorf("tool=get_bucket: %w", err)
	}

	tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	rows, err := d.Sw.ListBucketsShellAt(tctx, cl.MasterAddr, cl.WeedBinPath)
	if err != nil {
		return nil, fmt.Errorf("tool=get_bucket: shell call: %w", err)
	}

	// Find the requested bucket (case-sensitive; S3 bucket names are
	// case-sensitive in SeaweedFS).
	found := false
	var sizeBytes, chunks, quotaMB uint64
	var usagePc float64
	var owner string
	for _, r := range rows {
		if r.Name == p.Name {
			found = true
			sizeBytes = r.Size
			chunks = r.Chunks
			quotaMB = r.Quota
			usagePc = r.UsagePc
			owner = r.Owner
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("tool=get_bucket: bucket %q not found on cluster %q", p.Name, cl.Name)
	}

	// Join controller-side governance metadata: owner override, retention,
	// last lifecycle scan results. All fields are optional / best-effort.
	gov, _ := d.PG.ListBucketGovernance(ctx, cl.ID)
	var retentionDays *int
	var lastScanAt *time.Time
	var expiredObjects, expiredBytes int64
	var notes string
	var scanTruncated bool
	if g, ok := gov[p.Name]; ok {
		if owner == "" {
			owner = g.OwnerName
		}
		retentionDays = g.RetentionDays
		lastScanAt = g.LastScanAt
		expiredObjects = g.ExpiredObjects
		expiredBytes = g.ExpiredBytes
		notes = g.Notes
		scanTruncated = g.ScanTruncated
	}

	result := map[string]any{
		"cluster":    cl.Name,
		"name":       p.Name,
		"size_bytes": sizeBytes,
		"chunks":     chunks,
		"quota_mb":   quotaMB,
		"usage_pc":   usagePc,
		"owner":      owner,
		"notes":      notes,
		// TODO: lifecycle/governance rules per-bucket are stored in the
		// bucket_governance table only if the operator has configured them
		// through the controller UI. Raw S3 lifecycle XML rules live in the
		// filer and are not yet fetched here.
		"retention_days":  retentionDays,
		"last_scan_at":    lastScanAt,
		"expired_objects": expiredObjects,
		"expired_bytes":   expiredBytes,
		"scan_truncated":  scanTruncated,
	}
	return result, nil
}

// toolListS3Identities lists S3 IAM identities on a cluster. Secret keys
// are masked to the last 4 characters so the LLM can distinguish keys
// without the assistant leaking credentials into the chat log.
func toolListS3Identities(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID string `json:"cluster_id"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("tool=list_s3_identities: decode args: %w", err)
	}
	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, fmt.Errorf("tool=list_s3_identities: %w", err)
	}

	tctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	raw, err := d.Sw.RunShellReadOnly(tctx, cl.MasterAddr, cl.WeedBinPath, "s3.configure", []string{"-list"})
	if err != nil {
		return nil, fmt.Errorf("tool=list_s3_identities: shell call: %w", err)
	}

	cfg, perr := parseS3Config(raw)
	if perr != nil {
		// Return partial data so the operator can see what the shell printed.
		return map[string]any{
			"cluster":     cl.Name,
			"parse_error": perr.Error(),
			"identities":  []any{},
		}, nil
	}

	type credRow struct {
		AccessKeyMasked string `json:"access_key_masked"`
	}
	type identityRow struct {
		Name        string    `json:"name"`
		Credentials []credRow `json:"credentials,omitempty"`
		Actions     []string  `json:"actions,omitempty"`
	}

	out := make([]identityRow, 0, len(cfg.Identities))
	for _, id := range cfg.Identities {
		creds := make([]credRow, 0, len(id.Credentials))
		for _, c := range id.Credentials {
			// Mask the access key: show only the last 4 characters so the
			// operator can identify the key without exposing it fully.
			masked := maskKey(c.AccessKey)
			creds = append(creds, credRow{AccessKeyMasked: masked})
		}
		out = append(out, identityRow{
			Name:        id.Name,
			Credentials: creds,
			Actions:     id.Actions,
		})
	}
	return map[string]any{
		"cluster":    cl.Name,
		"count":      len(out),
		"identities": out,
	}, nil
}

// maskKey returns the last 4 characters of key prefixed with asterisks, or
// the whole key if it is 4 characters or fewer. Never returns an empty string.
func maskKey(key string) string {
	if len(key) <= 4 {
		return key
	}
	return strings.Repeat("*", len(key)-4) + key[len(key)-4:]
}

// toolGetCircuitBreaker returns the current S3 circuit-breaker configuration
// by calling `s3.circuitBreaker` (no args = list mode). The raw shell output
// is returned alongside a structured summary when the output can be parsed.
func toolGetCircuitBreaker(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID string `json:"cluster_id"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("tool=get_circuit_breaker: decode args: %w", err)
	}
	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, fmt.Errorf("tool=get_circuit_breaker: %w", err)
	}

	tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// No arguments → list mode (read-only, no -apply flag).
	out, serr := d.Sw.RunShellReadOnly(tctx, cl.MasterAddr, cl.WeedBinPath, "s3.circuitBreaker", nil)
	if serr != nil {
		return nil, fmt.Errorf("tool=get_circuit_breaker: shell call: %w", serr)
	}

	// The circuit-breaker output is plain text with no machine-readable
	// structure defined by the SeaweedFS spec. We return the raw output
	// directly so the LLM can reason over it. A structured parse can be
	// added once the format is stable across SeaweedFS versions.
	//
	// TODO: parse the structured circuit-breaker limit lines (e.g.
	// "global read: 500 MB/s") into typed fields when a stable format is
	// confirmed for the cluster's weed version.
	return map[string]any{
		"cluster": cl.Name,
		"raw":     out,
		"note":    "circuit-breaker config returned as raw shell output; structured parsing not yet implemented",
	}, nil
}

// toolListCleanUploads returns structured rows for incomplete multipart
// uploads older than older_than_hours (default 24h). It walks the filer
// directly under /buckets/<bucket>/.uploads/ — the same data SeaweedFS's
// own s3.clean.uploads job would delete, but read-only.
//
// We do NOT shell out to s3.clean.uploads here because that command
// deletes as a side-effect of "listing" and has no dry-run flag. The
// filer-walk approach is strictly read-only.
func toolListCleanUploads(ctx context.Context, d Deps, args json.RawMessage) (any, error) {
	var p struct {
		ClusterID      string `json:"cluster_id"`
		OlderThanHours int    `json:"older_than_hours"`
		Bucket         string `json:"bucket"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, fmt.Errorf("tool=list_clean_uploads: decode args: %w", err)
	}
	if p.OlderThanHours <= 0 {
		p.OlderThanHours = 24
	}
	cl, err := resolveClusterRef(ctx, d, p.ClusterID)
	if err != nil {
		return nil, fmt.Errorf("tool=list_clean_uploads: %w", err)
	}

	tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	filer, err := resolveFilerAddr(tctx, d, cl, "")
	if err != nil {
		return nil, fmt.Errorf("tool=list_clean_uploads: resolve filer: %w", err)
	}
	rows, truncated, err := walkMultipartUploads(tctx, filer, cl, p.Bucket, p.OlderThanHours)
	if err != nil {
		return nil, fmt.Errorf("tool=list_clean_uploads: walk: %w", err)
	}
	return map[string]any{
		"cluster":          cl.Name,
		"older_than_hours": p.OlderThanHours,
		"count":            len(rows),
		"truncated":        truncated,
		"uploads":          rows,
	}, nil
}
