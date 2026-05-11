package seaweed

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// preflightDialTimeout is the per-port TCP probe budget. Short on purpose:
// the whole point of preflight is to fail fast when the master is
// unreachable, so we'd rather take 2s twice (HTTP + gRPC) and surface a
// clear error than let `weed shell` hang inside its own dial.
const preflightDialTimeout = 2 * time.Second

// preflightCacheTTL keeps a positive/negative result hot just long enough
// that a single page render (dashboard + several cluster cards firing in
// parallel) shares one probe per master.
const preflightCacheTTL = 3 * time.Second

type preflightResult struct {
	err  error
	when time.Time
}

var (
	preflightMu    sync.Mutex
	preflightCache = map[string]preflightResult{}
)

// probeMasterReachable does a quick TCP dial against the master's HTTP and
// gRPC ports so we fail fast (within ~4s worst case) when the network is
// wedged, instead of letting `weed shell` hang on its own dial up to the
// shellTimeout (10m) or the caller's context deadline.
//
// gRPC port follows SeaweedFS convention: HTTP port + 10000.
//
// Returns nil if the master appears reachable. The error message names the
// specific failing port so the operator can tell a firewall problem from a
// crashed master.
func probeMasterReachable(master string) error {
	master = strings.TrimSpace(master)
	if master == "" {
		return nil
	}
	preflightMu.Lock()
	if r, ok := preflightCache[master]; ok && time.Since(r.when) < preflightCacheTTL {
		preflightMu.Unlock()
		return r.err
	}
	preflightMu.Unlock()

	err := dialMaster(master)

	preflightMu.Lock()
	preflightCache[master] = preflightResult{err: err, when: time.Now()}
	preflightMu.Unlock()
	return err
}

func dialMaster(master string) error {
	host, portStr, splitErr := net.SplitHostPort(master)
	if splitErr != nil {
		return fmt.Errorf("master addr %q: %w", master, splitErr)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return fmt.Errorf("master addr %q: bad port: %w", master, err)
	}
	grpcPort := port + 10000
	grpcAddr := net.JoinHostPort(host, strconv.Itoa(grpcPort))

	if err := dialOnce(master, preflightDialTimeout); err != nil {
		return fmt.Errorf("master %s unreachable: %w (HTTP port %d, check network/firewall)", master, err, port)
	}
	if err := dialOnce(grpcAddr, preflightDialTimeout); err != nil {
		return fmt.Errorf("master %s gRPC port %d unreachable: %w (weed shell talks to master over gRPC; open this port from the controller host)", master, grpcPort, err)
	}
	return nil
}

func dialOnce(addr string, timeout time.Duration) error {
	c, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return err
	}
	_ = c.Close()
	return nil
}
