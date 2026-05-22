package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/analyzer"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// runAnalyzerStep executes a kind="analyzer" step. It looks up the
// configured script by name, pipes the upstream step's stdout into
// it, renders params against the live scope, and stores the JSON
// result back into the scope so later steps can reference it.
//
// Wire format on the SSE stream:
//
//	event: step_start  { command: "analyzer:<name>", args: "<from_step>" }
//	event: line        { text: "[analyzer] running …" }
//	event: line        { text: "[analyzer] ok in 42ms" }
//	event: step_done   { ok }
//	(or step_error on failure)
//
// We write outputs[i] = JSON string so downstream steps can capture
// from it the same way they would from a shell stdout. Errors leave
// outputs[i] = sentinel "__analyzer_error__" so the parent can flip
// status correctly.
func runAnalyzerStep(
	ctx context.Context,
	d Deps,
	tpl *store.OpsTemplate,
	run *opsRun,
	scope map[string]string,
	scopeMu *sync.Mutex,
	steps []opsStep,
	outputs []string,
	indexByID map[string]int,
	i int,
	flush func(string, any),
) {
	s := steps[i]
	cfg := s.Analyzer
	if cfg == nil || strings.TrimSpace(cfg.ScriptName) == "" {
		outputs[i] = "__analyzer_error__"
		flush("step_error", gin.H{"step_id": s.ID, "index": i,
			"error": "analyzer step has no script configured"})
		return
	}

	// Resolve the source input. Default to the most recent
	// successfully-completed dependency when from_step is empty.
	sourceID := cfg.FromStep
	if sourceID == "" {
		for _, dep := range s.DependsOn {
			if idx, ok := indexByID[dep]; ok && outputs[idx] != "" {
				sourceID = dep
			}
		}
	}
	scopeMu.Lock()
	input := ""
	if sourceID != "" {
		input = scope[fmt.Sprintf("%s.output", sourceID)]
	}
	// Take a snapshot so we don't hold scopeMu across the
	// subprocess call (10s+).
	snap := make(map[string]string, len(scope))
	for k, v := range scope {
		snap[k] = v
	}
	scopeMu.Unlock()

	// Render params against the snapshot. Operator can write
	// "{{collection}}" or "{{step1.capture.foo}}" the same as in
	// shell args.
	params := map[string]any{}
	for k, v := range cfg.Params {
		rendered := substituteArgs(v, snap)
		params[k] = rendered
	}

	flush("step_start", gin.H{
		"step_id": s.ID, "index": i,
		"command": "analyzer:" + cfg.ScriptName,
		"args":    fmt.Sprintf("from=%s params=%v", sourceID, params),
		"streams": true,
	})

	script, err := d.PG.GetAnalyzerScriptByName(ctx, cfg.ScriptName)
	if err != nil {
		outputs[i] = "__analyzer_error__"
		flush("step_error", gin.H{"step_id": s.ID, "index": i,
			"error": fmt.Sprintf("analyzer script %q not found: %v", cfg.ScriptName, err)})
		return
	}
	if !script.Enabled {
		outputs[i] = "__analyzer_error__"
		flush("step_error", gin.H{"step_id": s.ID, "index": i,
			"error": fmt.Sprintf("analyzer script %q is disabled", cfg.ScriptName)})
		return
	}

	flush("line", gin.H{"step_id": s.ID, "index": i,
		"text": fmt.Sprintf("[analyzer] running %s (input=%d bytes, params=%d)", script.Name, len(input), len(params))})

	res, err := analyzer.Run(ctx, analyzer.Request{
		Body:   script.Body,
		Input:  input,
		Params: params,
	})
	if err != nil {
		outputs[i] = "__analyzer_error__"
		flush("step_error", gin.H{"step_id": s.ID, "index": i, "error": err.Error()})
		return
	}

	// Persist a run row for auditability.
	paramsJSON, _ := json.Marshal(params)
	if _, err := d.PG.InsertAnalyzerRun(ctx, store.AnalyzerRun{
		ScriptID:  script.ID,
		Actor:     "ops_template:" + tpl.Name,
		Params:    paramsJSON,
		InputHash: res.InputHash,
		InputSize: res.InputSize,
		OK:        res.OK,
		Error:     res.Error,
		Output:    res.Result,
		ElapsedMs: res.ElapsedMs,
	}); err != nil && d.Log != nil {
		d.Log.Warn("persist analyzer_run", zap.Error(err))
	}

	if !res.OK {
		outputs[i] = "__analyzer_error__"
		flush("step_error", gin.H{"step_id": s.ID, "index": i,
			"error": fmt.Sprintf("analyzer reported error: %s", res.Error)})
		return
	}

	flush("line", gin.H{"step_id": s.ID, "index": i,
		"text": fmt.Sprintf("[analyzer] ok in %dms", res.ElapsedMs)})

	// Result becomes both this step's "output" (so a downstream
	// analyzer can chain) AND named projections under
	// {{stepN.analyzer.<key>}} when result is a JSON object.
	outputs[i] = string(res.Result)
	scopeMu.Lock()
	scope[fmt.Sprintf("step%d.output", i+1)] = string(res.Result)
	scope[fmt.Sprintf("%s.output", s.ID)] = string(res.Result)
	scope[fmt.Sprintf("step%d.analyzer", i+1)] = string(res.Result)
	scope[fmt.Sprintf("%s.analyzer", s.ID)] = string(res.Result)
	// Flatten top-level fields of the result object into the scope
	// so templates can do `{{stepN.analyzer.max_node}}` without
	// running JSON through the shell. Skips arrays / non-string
	// scalars stringify cleanly.
	var asMap map[string]json.RawMessage
	if err := json.Unmarshal(res.Result, &asMap); err == nil {
		for k, v := range asMap {
			scope[fmt.Sprintf("step%d.analyzer.%s", i+1, k)] = jsonScalarToString(v)
			scope[fmt.Sprintf("%s.analyzer.%s", s.ID, k)] = jsonScalarToString(v)
		}
	}
	applyCaptures(i+1, string(res.Result), s.Capture, scope)
	scopeMu.Unlock()

	flush("step_done", gin.H{"step_id": s.ID, "index": i, "ok": true})
}

// jsonScalarToString unwraps a string scalar from a json.RawMessage
// so {{x}} substitution yields the raw value, not "\"value\"". Non-
// strings (numbers, bools, arrays) pass through as their JSON form
// — operators can still feed them to the next analyzer or shell
// command that knows the right shape.
func jsonScalarToString(raw json.RawMessage) string {
	s := string(raw)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var unq string
		if err := json.Unmarshal(raw, &unq); err == nil {
			return unq
		}
	}
	return s
}
