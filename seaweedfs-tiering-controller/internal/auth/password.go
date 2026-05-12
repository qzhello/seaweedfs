package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// bcrypt cost 10 is the sweet spot for a controller-style service:
// ~80ms per hash on commodity hardware. The cost can be raised later
// without invalidating old hashes since bcrypt embeds it.
const bcryptCost = 10

func HashPassword(plain string) (string, error) {
	if plain == "" {
		return "", errors.New("password required")
	}
	if len(plain) < 6 {
		return "", errors.New("password must be at least 6 characters")
	}
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(b), nil
}

func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// GenerateAPIToken creates a fresh random token. We rotate the
// api_token on every successful password login so an exposed old
// token can't be reused after a password change. 32 hex chars (16
// bytes of entropy) is the same shape as the seed token.
func GenerateAPIToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// EnsureSeedAdminPassword runs at boot. If admin@local exists with a
// NULL password_hash it bcrypts the well-known default "admin" and
// stores it. must_reset_password stays TRUE so the very first login
// forces a rotation.
//
// This makes first-boot a one-step UX (paste no token, just enter
// admin/admin) without ever pinning a salted hash in a migration the
// operator can't easily verify.
func EnsureSeedAdminPassword(ctx context.Context, pool *pgxpool.Pool) error {
	var current *string
	row := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE email = 'admin@local'`)
	if err := row.Scan(&current); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("read seed admin: %w", err)
	}
	if current != nil && *current != "" {
		return nil
	}
	h, err := HashPassword("admin")
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `
		UPDATE users
		   SET password_hash = $1,
		       must_reset_password = TRUE
		 WHERE email = 'admin@local'
	`, h)
	return err
}
