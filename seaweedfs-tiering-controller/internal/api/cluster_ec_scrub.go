package api

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
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
	// Never return nil slices: they marshal to JSON `null`, but the frontend
	// types these as string[] and calls .length on them. ec.scrub prints
	// "Affected shards:" only when there are broken shards, so a broken-
	// volumes / zero-broken-shards result would otherwise leave this nil.
	if s.AffectedVolumes == nil {
		s.AffectedVolumes = []string{}
	}
	if s.AffectedShards == nil {
		s.AffectedShards = []string{}
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

// ecScrubStream runs `weed shell ec.scrub` across the whole cluster and
// streams progress as SSE. The final `done` event carries the parsed
// broken-volumes/shards summary. Read-only (cap volume.read); not gated by
// the safety Guard. ec.scrub holds the cluster shell lock while it runs.
//
// POST /api/v1/clusters/:id/ec/scrub   body: {"mode":"index|local|full"}
func ecScrubStream(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			Mode string `json:"mode"`
		}
		_ = c.ShouldBindJSON(&body)
		mode, err := validateScrubMode(body.Mode)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := []string{"-mode=" + mode}

		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
		started := time.Now()

		// Full-mode scrub reads every EC file's contents — can take a long
		// time on a big cluster. Give it a generous ceiling.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Hour)
		defer cancel()

		var runErr error
		var outBuf strings.Builder
		var summary ecScrubSummary
		streamWithHeartbeat(c, started, func(emit func(string, interface{}), lineSink func(string)) {
			emit("start", gin.H{
				"args":       args,
				"command":    "ec.scrub",
				"mode":       mode,
				"started_at": started.UnixMilli(),
			})
			sink := func(line string) {
				outBuf.WriteString(line)
				outBuf.WriteByte('\n')
				lineSink(line)
			}
			_, runErr = d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath,
				"ec.scrub", args, sink)

			summary = parseECScrubOutput(outBuf.String())
			errStr := ""
			if runErr != nil {
				errStr = runErr.Error()
			}
			emit("done", gin.H{
				"ok":          runErr == nil,
				"error":       errStr,
				"duration_ms": time.Since(started).Milliseconds(),
				"summary":     summary,
			})
		})

		errStr := ""
		if runErr != nil {
			errStr = runErr.Error()
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "ec.scrub", "cluster", id.String(), map[string]any{
			"mode":           mode,
			"ok":             runErr == nil,
			"broken_volumes": summary.BrokenVolumes,
			"broken_shards":  summary.BrokenShards,
			"error":          errStr,
		})
	}
}
