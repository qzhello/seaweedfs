package executor

import (
	"strings"
	"time"
)

// FailureKind classifies an execution error into a coarse category so
// the retry scheduler can decide whether to back off and try again,
// pause the owning policy, or escalate to a human immediately.
type FailureKind string

const (
	FailureTransient  FailureKind = "transient"
	FailureCapacity   FailureKind = "capacity"
	FailureValidation FailureKind = "validation"
	FailureUnknown    FailureKind = "unknown"
)

// maxTransientRetries caps the auto-retry loop. Three attempts at 1m
// / 5m / 30m covers the vast majority of real-world flakes (master
// reload, brief network blips, deploy rolls) without burning a whole
// day's worth of cluster capacity on a permanently broken task.
const MaxTransientRetries = 3

// ClassifyFailure looks at the raw error string and assigns a
// FailureKind. The match list is intentionally substring-based, not
// regex, so we can extend it as new failure modes surface in the
// field. Order matters: capacity and validation win over transient
// when both could match (e.g. a 5xx response that included
// "no space left on device").
func ClassifyFailure(err string) FailureKind {
	if err == "" {
		return FailureUnknown
	}
	low := strings.ToLower(err)

	capacitySignals := []string{
		"no space left",
		"disk full",
		"free volume count",
		"max_volume_count",
		"insufficient capacity",
		"backend full",
		"out of capacity",
	}
	for _, s := range capacitySignals {
		if strings.Contains(low, s) {
			return FailureCapacity
		}
	}

	validationSignals := []string{
		"checksum mismatch",
		"verify failed",
		"verification failed",
		"crc mismatch",
		"wrong volume",
		"missing shards",
		"corrupted",
		"signature mismatch",
	}
	for _, s := range validationSignals {
		if strings.Contains(low, s) {
			return FailureValidation
		}
	}

	transientSignals := []string{
		"context deadline exceeded",
		"context canceled",
		"connection refused",
		"connection reset",
		"broken pipe",
		"eof",
		"i/o timeout",
		"timeout",
		"temporarily unavailable",
		"503",
		"502",
		"504",
		"too many requests",
		"deadline exceeded",
	}
	for _, s := range transientSignals {
		if strings.Contains(low, s) {
			return FailureTransient
		}
	}

	return FailureUnknown
}

// BackoffFor returns the wall-clock delay before the (attempt+1)-th
// retry. Exponential at base 5x with a floor of 1m and a ceiling of
// 30m: 1m → 5m → 25m (capped 30m). Attempt is 0-indexed, so a task
// that has failed once already gets the second delay.
func BackoffFor(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	delays := []time.Duration{
		1 * time.Minute,
		5 * time.Minute,
		30 * time.Minute,
	}
	if attempt >= len(delays) {
		return delays[len(delays)-1]
	}
	return delays[attempt]
}
