package seaweed

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ShellLineSink, when non-nil, receives every stdout line from RunShellCommand
// in real time. The skill-engine wires it to the execution log buffer + a
// PG flush so the operator sees output as it's produced instead of after the
// subprocess exits.
type ShellLineSink func(line string)

// shellTimeout is the upper bound for any single weed shell call. Operations
// like volume.fix.replication on a stuck cluster have hung indefinitely in
// the field — better to surface a timeout to the operator than to leave the
// task wedged forever. Override per-call via context deadline if needed.
const shellTimeout = 10 * time.Minute

// resolvedWeedBin caches the result of resolveWeedBin so we don't probe the
// filesystem on every shell call.
var (
	weedBinOnce sync.Once
	weedBinPath string
	weedBinErr  error
)

// resolveWeedBin walks a small ladder of fallbacks so the controller works
// out-of-the-box in dev (where `weed` isn't on PATH) without forcing every
// operator to set WEED_BIN. Order:
//  1. $WEED_BIN (explicit override)
//  2. `weed` on $PATH
//  3. ../weed/weed relative to the controller binary's cwd (monorepo layout)
//  4. ../weed/weed relative to the controller executable's directory
// resolveWeedBinPreferring honours an explicit per-call binary path (typically
// from clusters.weed_bin_path) before falling back to the cached global
// resolution. The explicit path is validated each call — it's not cached
// because different clusters may pin different binaries.
func resolveWeedBinPreferring(explicit string) (string, error) {
	explicit = strings.TrimSpace(explicit)
	if explicit != "" {
		abs, err := filepath.Abs(explicit)
		if err != nil {
			return "", fmt.Errorf("weed_bin_path abs: %w", err)
		}
		st, err := os.Stat(abs)
		if err != nil {
			return "", fmt.Errorf("weed_bin_path stat %s: %w", abs, err)
		}
		if st.IsDir() {
			return "", fmt.Errorf("weed_bin_path %s is a directory", abs)
		}
		if st.Mode()&0o111 == 0 {
			return "", fmt.Errorf("weed_bin_path %s is not executable", abs)
		}
		return abs, nil
	}
	return resolveWeedBin()
}

func resolveWeedBin() (string, error) {
	weedBinOnce.Do(func() {
		tried := []string{}

		check := func(label, p string) bool {
			if p == "" {
				return false
			}
			abs, err := filepath.Abs(p)
			if err != nil {
				tried = append(tried, fmt.Sprintf("%s=%s (abs: %v)", label, p, err))
				return false
			}
			st, err := os.Stat(abs)
			if err != nil {
				tried = append(tried, fmt.Sprintf("%s=%s (%v)", label, abs, err))
				return false
			}
			if st.IsDir() {
				tried = append(tried, fmt.Sprintf("%s=%s (is dir)", label, abs))
				return false
			}
			if st.Mode()&0o111 == 0 {
				tried = append(tried, fmt.Sprintf("%s=%s (not executable)", label, abs))
				return false
			}
			weedBinPath = abs
			return true
		}

		if env := strings.TrimSpace(os.Getenv("WEED_BIN")); env != "" {
			if check("$WEED_BIN", env) {
				return
			}
		} else {
			tried = append(tried, "$WEED_BIN=(unset)")
		}
		if p, err := exec.LookPath("weed"); err == nil {
			if check("PATH", p) {
				return
			}
		} else {
			tried = append(tried, fmt.Sprintf("PATH lookup: %v", err))
		}
		if cwd, err := os.Getwd(); err == nil {
			if check("cwd/../weed/weed", filepath.Join(cwd, "..", "weed", "weed")) {
				return
			}
			if check("cwd/weed", filepath.Join(cwd, "weed")) {
				return
			}
		}
		if exe, err := os.Executable(); err == nil {
			d := filepath.Dir(exe)
			if check("exe-dir/weed", filepath.Join(d, "weed")) {
				return
			}
			if check("exe-dir/../weed/weed", filepath.Join(d, "..", "weed", "weed")) {
				return
			}
		}
		weedBinErr = fmt.Errorf("weed binary not found. Tried: %s", strings.Join(tried, " | "))
	})
	return weedBinPath, weedBinErr
}

// RunShellCommand invokes a `weed shell` command against the configured
// master and returns its stdout (trimmed). The controller talks to the
// existing `weed` binary as a subprocess instead of linking the entire
// SeaweedFS shell package — that package transitively pulls parquet, LDAP,
// AWS-SDK, leveldb, etc. and balloons the controller binary by ~80MB.
//
// The binary path is resolved as: $WEED_BIN env var → "weed" on PATH.
// Operators ship `weed` next to the controller in the same image.
func (c *Client) RunShellCommand(ctx context.Context, name string, args []string) (string, error) {
	return c.runShellWithMaster(ctx, "", "", name, args, nil)
}

// RunShellReadOnly is for commands that only read state (volume.list,
// cluster.check). Skipping the lock/unlock pair avoids serialising every
// dashboard refresh through the cluster-wide lock and also dodges the case
// where a stale or contended lock would silently block a benign read for
// up to lock's default timeout.
func (c *Client) RunShellReadOnly(ctx context.Context, master, binPath, name string, args []string) (string, error) {
	return c.runShellInner(ctx, master, binPath, name, args, nil, true)
}

// RunShellCommandAt runs a `weed shell` command against a specific master,
// not the controller's default. Multi-cluster setups must use this — using
// `localhost:9333` (the dev default) when the task lives on a remote
// cluster silently hangs forever waiting on a non-existent master.
func (c *Client) RunShellCommandAt(ctx context.Context, master, name string, args []string, sink ShellLineSink) (string, error) {
	return c.runShellWithMaster(ctx, master, "", name, args, sink)
}

// RunShellCommandAtWithBin is like RunShellCommandAt but lets the caller
// pin a specific `weed` binary path (typically from the cluster row's
// weed_bin_path column). Empty `binPath` falls back to the global
// resolution chain. Useful when different clusters run mismatched weed
// versions and a single global $WEED_BIN can't satisfy all of them.
func (c *Client) RunShellCommandAtWithBin(ctx context.Context, master, binPath, name string, args []string, sink ShellLineSink) (string, error) {
	return c.runShellWithMaster(ctx, master, binPath, name, args, sink)
}

// RunShellCommandStreamed runs a `weed shell` command and pipes each stdout
// line to `sink` (if non-nil) the moment it's produced. Returns the full
// stdout as a single string when the subprocess exits.
//
// Why streaming: long-running commands like volume.fix.replication produce
// progress lines ("replicating volume 10 from X to Y...") over many minutes.
// Buffering until exit makes the UI look frozen. Streaming + the executor's
// per-step PG log flush gives the operator a live tail.
//
// Hard timeout: shellTimeout caps any single call. Cancellation paths:
//   1. Caller's ctx done → CommandContext kills the subprocess (SIGKILL).
//   2. shellTimeout elapsed → same.
//   3. Subprocess exits cleanly → normal return.
func (c *Client) RunShellCommandStreamed(ctx context.Context, name string, args []string, sink ShellLineSink) (string, error) {
	return c.runShellWithMaster(ctx, "", "", name, args, sink)
}

// runShellWithMaster is the actual subprocess driver. Empty `master`
// substitutes the client default. Concurrency-safe: nothing on `c` is
// mutated.
func (c *Client) runShellWithMaster(ctx context.Context, master, binOverride, name string, args []string, sink ShellLineSink) (string, error) {
	return c.runShellInner(ctx, master, binOverride, name, args, sink, false)
}

func (c *Client) runShellInner(ctx context.Context, master, binOverride, name string, args []string, sink ShellLineSink, readOnly bool) (string, error) {
	if name == "" {
		return "", fmt.Errorf("shell command name required")
	}
	bin, err := resolveWeedBinPreferring(binOverride)
	if err != nil {
		return "", err
	}
	target := strings.TrimSpace(master)
	if target == "" {
		target = c.masterAddr
	}

	// Fail fast when the master is unreachable. Without this, `weed shell`
	// hangs inside its own gRPC dial for the full ctx deadline (up to
	// shellTimeout = 10m) and the UI just sees a frozen request. The probe
	// is cached for ~3s so parallel dashboard cards share one check.
	if err := probeMasterReachable(target); err != nil {
		return "", err
	}

	// Apply our own timeout if the caller didn't set a tighter one.
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, shellTimeout)
		defer cancel()
	}

	line := name
	if len(args) > 0 {
		line = name + " " + strings.Join(args, " ")
	}
	if sink != nil {
		sink(fmt.Sprintf("$ weed shell -master=%s : %q", target, line))
	}

	cmd := exec.CommandContext(ctx, bin, "shell",
		"-master="+target,
	)
	// `weed shell` reads commands from stdin. Mutating commands (anything
	// with -apply) require an exclusive cluster lock — `lock` claims it via
	// the master, `unlock` releases. If a previous shell session crashed mid
	// command, the cluster lock can be stuck; `lock -t 10s` returns fast so
	// we don't hang forever on the lock acquire.
	if readOnly {
		cmd.Stdin = strings.NewReader(line + "\nexit\n")
	} else {
		cmd.Stdin = strings.NewReader("lock\n" + line + "\nunlock\nexit\n")
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("stdout pipe: %w", err)
	}
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("%s start: %w", bin, err)
	}

	// Drain stdout in real time. We accumulate to `out` for the return value
	// and feed `sink` every line for the live UI tail.
	var out strings.Builder
	scanDone := make(chan struct{})
	go func() {
		defer close(scanDone)
		scanner := bufio.NewScanner(stdoutPipe)
		// volume.fsck output can have huge lines; bump the buffer to 1MB.
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			ln := scanner.Text()
			out.WriteString(ln)
			out.WriteByte('\n')
			if sink != nil {
				sink(ln)
			}
		}
		// Drain any remaining bytes (no trailing newline).
		_, _ = io.Copy(&out, stdoutPipe)
	}()

	waitErr := cmd.Wait()
	<-scanDone

	if waitErr != nil {
		errOut := strings.TrimSpace(stderrBuf.String())
		// Surface ctx-cancel separately so the operator's stop button
		// produces a sensible error message instead of "exit status -1".
		if ctx.Err() != nil {
			return strings.TrimRight(out.String(), "\n"), fmt.Errorf("%s %q cancelled: %w (stderr: %s)", bin, line, ctx.Err(), errOut)
		}
		return strings.TrimRight(out.String(), "\n"), fmt.Errorf("%s %q failed: %w (stderr: %s)", bin, line, waitErr, errOut)
	}
	return strings.TrimRight(out.String(), "\n"), nil
}
