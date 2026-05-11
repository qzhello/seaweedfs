// Package crypto holds the column-level encryption helper used to protect
// storage backend credentials at rest. The master key is loaded once at
// startup; rotating it requires re-encrypting all rows (out of scope for v1,
// documented as a future migration).
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
)

type AESGCM struct {
	aead cipher.AEAD
}

// FromEnv reads TIER_MASTER_KEY (64 hex chars = 32 bytes). Returns nil and an
// error if not set; callers decide whether to operate in "no-secrets" mode.
func FromEnv() (*AESGCM, error) {
	keyHex := os.Getenv("TIER_MASTER_KEY")
	if keyHex == "" {
		return nil, errors.New("TIER_MASTER_KEY not set")
	}
	raw, err := hex.DecodeString(keyHex)
	if err != nil {
		return nil, fmt.Errorf("decode TIER_MASTER_KEY: %w", err)
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("TIER_MASTER_KEY must be 32 bytes (64 hex chars), got %d", len(raw))
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, fmt.Errorf("new cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("new gcm: %w", err)
	}
	return &AESGCM{aead: aead}, nil
}

// Seal returns nonce||ciphertext. Random 12-byte nonce, never reused.
func (e *AESGCM) Seal(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, e.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}
	ct := e.aead.Seal(nil, nonce, plaintext, nil)
	return append(nonce, ct...), nil
}

// Open decrypts the nonce||ciphertext blob produced by Seal.
func (e *AESGCM) Open(blob []byte) ([]byte, error) {
	if len(blob) < e.aead.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	nonce, ct := blob[:e.aead.NonceSize()], blob[e.aead.NonceSize():]
	return e.aead.Open(nil, nonce, ct, nil)
}
