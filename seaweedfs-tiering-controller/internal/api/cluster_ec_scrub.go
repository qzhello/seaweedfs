package api

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ecScrubSummary is the parsed broken-shard verdict from an ec.scrub run.
type ecScrubSummary struct {
	BrokenVolumes   int      `json:"broken_volumes"`
	BrokenShards    int      `json:"broken_shards"`
	AffectedVolumes []string `json:"affected_volumes"`
	AffectedShards  []string `json:"affected_shards"`
}

// validateScrubMode normalizes the scrub mode. Empty → "local" (the command
// default). Returns an error for anything outside index/local/full.
func validateScrubMode(mode string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "":
		return "local", nil
	case "index":
		return "index", nil
	case "local":
		return "local", nil
	case "full":
		return "full", nil
	default:
		return "", fmt.Errorf("invalid scrub mode %q (want index|local|full)", mode)
	}
}

var (
	scrubFailRe   = regexp.MustCompile(`(?m)^Got scrub failures on (\d+) EC volumes and (\d+) EC shards`)
	scrubVolsRe   = regexp.MustCompile(`(?m)^Affected volumes:\s*(.+)$`)
	scrubShardsRe = regexp.MustCompile(`(?m)^Affected shards:\s*(.+)$`)
)

// parseECScrubOutput extracts the broken summary from the scrub command's
// trailing report. No "Got scrub failures" line → zero broken, empty lists.
func parseECScrubOutput(raw string) ecScrubSummary {
	var s ecScrubSummary
	if m := scrubFailRe.FindStringSubmatch(raw); m != nil {
		// Regex guarantees \d+, so the discarded errors cannot occur.
		s.BrokenVolumes, _ = strconv.Atoi(m[1])
		s.BrokenShards, _ = strconv.Atoi(m[2])
	}
	if m := scrubVolsRe.FindStringSubmatch(raw); m != nil {
		s.AffectedVolumes = splitScrubList(m[1])
	}
	if m := scrubShardsRe.FindStringSubmatch(raw); m != nil {
		s.AffectedShards = splitScrubList(m[1])
	}
	return s
}

// splitScrubList splits a comma-separated affected list, trimming each item
// and dropping blanks. Returns nil (not []) when nothing remains.
func splitScrubList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
