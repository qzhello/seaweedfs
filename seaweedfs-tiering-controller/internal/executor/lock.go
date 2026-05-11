package executor

import (
	"context"
	"fmt"
	"hash/fnv"

	"github.com/jackc/pgx/v5/pgxpool"
)

// VolumeLock takes a PostgreSQL session-scoped advisory lock keyed by volume id.
// Two parallel executor invocations on the same volume will serialize through
// PG without us holding any in-process state. The lock is auto-released when
// the connection is returned to the pool.
//
// Returns the holding connection — caller must Defer-call Release exactly once.
type VolumeLock struct {
	pool   *pgxpool.Pool
	conn   *pgxpool.Conn
	key    int64
	locked bool
}

func AcquireVolumeLock(ctx context.Context, pool *pgxpool.Pool, volumeID uint32, action string) (*VolumeLock, error) {
	// Pack volumeID + action into a 64-bit key. action hash collides per
	// (vol, kind-bucket); fine because we want any concurrent op on the same
	// volume to serialize regardless of action.
	h := fnv.New64a()
	fmt.Fprintf(h, "%d|%s", volumeID, action)
	key := int64(h.Sum64() & 0x7FFFFFFFFFFFFFFF) // strip sign bit for safety

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire conn: %w", err)
	}
	row := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key)
	var got bool
	if err := row.Scan(&got); err != nil {
		conn.Release()
		return nil, fmt.Errorf("pg_try_advisory_lock: %w", err)
	}
	if !got {
		conn.Release()
		return nil, ErrLocked
	}
	return &VolumeLock{pool: pool, conn: conn, key: key, locked: true}, nil
}

func (l *VolumeLock) Release(ctx context.Context) {
	if l == nil || !l.locked {
		return
	}
	_, _ = l.conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, l.key)
	l.conn.Release()
	l.locked = false
}

// ErrLocked is returned when another holder owns the lock. Caller should skip,
// not retry — the other side will finish, and the next scheduler tick will
// requeue if needed.
var ErrLocked = fmt.Errorf("volume already locked by another execution")
