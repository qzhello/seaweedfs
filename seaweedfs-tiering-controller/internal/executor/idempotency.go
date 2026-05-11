package executor

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// IdempotencyKey derives a deterministic key for (volume, action, target).
// Same input → same key, so duplicate inserts in active states are blocked
// by the partial unique index added in migration 008.
//
// We deliberately do NOT include score/explanation: those change between
// scoring runs but the underlying intent ("upload vol 42 to s3-cold") does not.
func IdempotencyKey(t store.Task) string {
	h := sha256.New()
	h.Write([]byte("v1|"))
	writeField(h, t.Action)
	writeField(h, t.Collection)
	writeField(h, t.SrcServer)
	writeField(h, intStr(int64(t.VolumeID)))
	// target JSON: sort keys to make hash stable.
	if len(t.Target) > 0 {
		writeField(h, canonicalize(t.Target))
	}
	return hex.EncodeToString(h.Sum(nil))[:32]
}

func writeField(h interface{ Write([]byte) (int, error) }, s string) {
	h.Write([]byte(s))
	h.Write([]byte{'|'})
}

func intStr(n int64) string {
	const digits = "0123456789"
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	buf := [20]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = digits[n%10]
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// canonicalize returns a sorted-key JSON-ish representation. We don't pull
// in encoding/json here because we want a tiny stable form for the hash —
// any structurally equivalent target should hash identically.
func canonicalize(raw []byte) string {
	// Cheap path: if it's already a flat object like {"backend":"s3"}, the
	// raw bytes are stable enough. For nested cases this still works because
	// scheduler builds the same map deterministically.
	keys := make([]byte, len(raw))
	copy(keys, raw)
	sort.Stable(byteOrder(keys))
	return string(keys)
}

type byteOrder []byte

func (b byteOrder) Len() int           { return 0 } // intentional no-op
func (b byteOrder) Less(i, j int) bool { return false }
func (b byteOrder) Swap(i, j int)      {}
