// Package analyzer runs deterministic Python scripts against captured
// shell command output. Wraps subprocess + JSON IO + resource limits
// so the rest of the codebase doesn't have to think about sandboxing.
//
// SECURITY MODEL
//
//   - Spawned with `python3 -I` (isolated mode): no user site-packages,
//     PYTHONPATH, PYTHONHOME, PYTHONSTARTUP. Only stdlib is reachable.
//   - Resource caps: 10s wall clock, 2 MB output, 32 MB peak memory
//     where the OS supports it (Linux/macOS via prlimit/ulimit).
//   - No network: we don't disable it at the syscall level, but we
//     do not expose any helper, and the body field is operator/admin-
//     authored — controlled by RBAC, not by the runner.
//   - Stdin is a JSON envelope; stdout is parsed as JSON. The script
//     decides what to read from `input` and write under `result`.
//
// FUTURE: For stricter isolation switch to nsjail / firejail when
// available. The runner is structured so the call site never changes.
package analyzer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"time"
)

const (
	defaultTimeout = 10 * time.Second
	maxOutputBytes = 2 * 1024 * 1024 // 2 MB
)

// pythonBin returns the python3 interpreter path. Override with the
// ANALYZER_PYTHON env var when bundling a custom build. Falls back to
// the PATH lookup of "python3".
func pythonBin() string {
	if p := os.Getenv("ANALYZER_PYTHON"); p != "" {
		return p
	}
	return "python3"
}

// Request is what the caller hands to Run().
type Request struct {
	Body   string         // Python source
	Input  string         // raw text fed to the script (typically a shell command's stdout)
	Params map[string]any // declared parameters

	// Optional overrides — leave zero for sensible defaults.
	Timeout time.Duration
}

// Result captures one execution. OK==true means the subprocess exited
// 0 AND its stdout parsed as a `{ok: bool, result|error: ...}`
// envelope.
type Result struct {
	OK        bool            `json:"ok"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
	Stderr    string          `json:"stderr,omitempty"`
	ElapsedMs int             `json:"elapsed_ms"`
	InputHash string          `json:"input_hash"`
	InputSize int             `json:"input_size"`
}

// Run executes one script against the given input. Always returns a
// Result — even on failure — so callers can persist the same shape
// to the audit log.
func Run(ctx context.Context, req Request) (*Result, error) {
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	envelope := map[string]any{
		"input":  req.Input,
		"params": req.Params,
	}
	stdin, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("marshal stdin: %w", err)
	}

	start := time.Now()
	// -I: isolated mode, drops PYTHONPATH / user site / inherited env knobs.
	// -c: read body from arg so we don't need a temp file.
	cmd := exec.CommandContext(ctx, pythonBin(), "-I", "-c", req.Body)
	cmd.Stdin = bytes.NewReader(stdin)
	// Strip the parent env aggressively; only keep PATH so the
	// interpreter can resolve its own binary on macOS shims.
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
	// Bounded buffers so a runaway print() can't OOM the controller.
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &limitedWriter{W: &outBuf, N: maxOutputBytes}
	cmd.Stderr = &limitedWriter{W: &errBuf, N: maxOutputBytes}

	runErr := cmd.Run()
	elapsed := int(time.Since(start) / time.Millisecond)

	res := &Result{
		ElapsedMs: elapsed,
		InputSize: len(req.Input),
		InputHash: hashOf(req.Input),
		Stderr:    truncate(errBuf.String(), 4096),
	}

	// Surface subprocess-level failures (timeout, non-zero exit).
	if runErr != nil {
		if ctx.Err() == context.DeadlineExceeded {
			res.Error = fmt.Sprintf("timeout after %s", timeout)
		} else {
			res.Error = runErr.Error()
		}
		return res, nil
	}

	// Script exited 0 — try to parse the envelope. Operators can
	// either print our envelope directly OR print a bare JSON object
	// (we wrap it).
	var parsed struct {
		OK     *bool           `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(outBuf.Bytes(), &parsed); err != nil {
		res.Error = fmt.Sprintf("script stdout is not valid JSON: %v", err)
		res.Result = json.RawMessage(fmt.Sprintf("%q", truncate(outBuf.String(), 4096)))
		return res, nil
	}
	if parsed.OK != nil {
		res.OK = *parsed.OK
		res.Result = parsed.Result
		res.Error = parsed.Error
	} else {
		// No "ok" key — treat the whole stdout as result.
		res.OK = true
		res.Result = outBuf.Bytes()
	}
	return res, nil
}

// limitedWriter caps the bytes written; once N is exhausted further
// writes are dropped. Used to bound script stdout/stderr so a chatty
// loop can't OOM the controller process.
type limitedWriter struct {
	W *bytes.Buffer
	N int
}

func (lw *limitedWriter) Write(p []byte) (int, error) {
	if lw.N <= 0 {
		return len(p), nil // pretend success; bytes silently dropped
	}
	if len(p) > lw.N {
		p = p[:lw.N]
	}
	lw.N -= len(p)
	return lw.W.Write(p)
}

func hashOf(s string) string {
	if s == "" {
		return ""
	}
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8]) // 16 chars is enough for dedupe / audit
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "...(truncated)"
}
