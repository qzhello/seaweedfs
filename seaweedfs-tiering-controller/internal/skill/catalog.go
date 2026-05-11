package skill

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"path"
	"strings"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
	"go.uber.org/zap"
)

// Built-in skill definitions live as JSON files under catalog/. Shipping them
// as data (rather than Go literals) makes diffing a future upgrade easy and
// lets reviewers read them as ordinary JSON.
//
//go:embed catalog/*.json
var catalogFS embed.FS

// CatalogEntry mirrors the metadata header of each catalog file.
type CatalogEntry struct {
	Key        string          `json:"key"`
	Name       string          `json:"name"`
	Category   string          `json:"category"`
	RiskLevel  string          `json:"risk_level"`
	Version    int             `json:"version"`
	Definition json.RawMessage `json:"definition"`
}

// LoadCatalog parses every embedded catalog JSON file. Used both to upsert on
// startup and by tests to assert the definitions stay schema-valid.
func LoadCatalog() ([]CatalogEntry, error) {
	entries, err := catalogFS.ReadDir("catalog")
	if err != nil {
		return nil, fmt.Errorf("read catalog: %w", err)
	}
	out := make([]CatalogEntry, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := catalogFS.ReadFile(path.Join("catalog", e.Name()))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", e.Name(), err)
		}
		var ce CatalogEntry
		if err := json.Unmarshal(raw, &ce); err != nil {
			return nil, fmt.Errorf("parse %s: %w", e.Name(), err)
		}
		// Validate body shape early so a bad shipped catalog file fails the
		// process startup rather than silently being skipped.
		if _, err := ParseDefinition(ce.Definition); err != nil {
			return nil, fmt.Errorf("validate %s: %w", e.Name(), err)
		}
		out = append(out, ce)
	}
	return out, nil
}

// SyncBuiltins upserts every catalog entry, only upgrading when the shipped
// version is newer than the stored one. Returns the number of upgrades for
// observability — the caller logs it at INFO.
func SyncBuiltins(ctx context.Context, pg *store.PG, log *zap.Logger) (int, error) {
	entries, err := LoadCatalog()
	if err != nil {
		return 0, err
	}
	upgrades := 0
	for _, e := range entries {
		s := store.Skill{
			Key:        e.Key,
			Name:       e.Name,
			Category:   firstNonEmpty(e.Category, "general"),
			RiskLevel:  e.RiskLevel,
			Version:    e.Version,
			Definition: e.Definition,
			ChangeNote: fmt.Sprintf("system catalog v%d", e.Version),
		}
		up, err := pg.UpsertSystemSkill(ctx, s)
		if err != nil {
			log.Warn("upsert system skill",
				zap.String("key", e.Key), zap.Error(err))
			continue
		}
		if up {
			upgrades++
			log.Info("system skill upgraded",
				zap.String("key", e.Key), zap.Int("version", e.Version))
		}
	}
	return upgrades, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
