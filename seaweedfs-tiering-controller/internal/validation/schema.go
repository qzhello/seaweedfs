// Package validation centralizes JSON Schema enforcement so every JSONB
// column we accept from users is checked against a known shape. Without this,
// nothing stops an admin from putting `{"emergency_drop_db": true}` into a
// policy params field and confusing future code paths.
package validation

import (
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

// SchemaSet caches compiled schemas keyed by name.
type SchemaSet struct {
	mu    sync.RWMutex
	cache map[string]*jsonschema.Schema
}

func NewSchemaSet() *SchemaSet {
	return &SchemaSet{cache: map[string]*jsonschema.Schema{}}
}

// Register compiles a raw JSON-schema string under the given name. Panics on
// bad schema — these are developer-controlled, not user input.
func (s *SchemaSet) Register(name, schemaJSON string) {
	c := jsonschema.NewCompiler()
	if err := c.AddResource(name, strings.NewReader(schemaJSON)); err != nil {
		panic(fmt.Sprintf("validation: bad schema %q: %v", name, err))
	}
	sc, err := c.Compile(name)
	if err != nil {
		panic(fmt.Sprintf("validation: compile %q: %v", name, err))
	}
	s.mu.Lock()
	s.cache[name] = sc
	s.mu.Unlock()
}

// RegisterIfMissing compiles a schema only if the name is not yet known. Safe
// for concurrent callers; useful when schemas come from user data (e.g.
// system_config.schema) and we want to cache by content hash.
func (s *SchemaSet) RegisterIfMissing(name, schemaJSON string) {
	s.mu.RLock()
	_, ok := s.cache[name]
	s.mu.RUnlock()
	if ok {
		return
	}
	c := jsonschema.NewCompiler()
	if err := c.AddResource(name, strings.NewReader(schemaJSON)); err != nil {
		// Soft-fail: register a no-op compiled schema to avoid retry storms.
		return
	}
	sc, err := c.Compile(name)
	if err != nil {
		return
	}
	s.mu.Lock()
	s.cache[name] = sc
	s.mu.Unlock()
}

// Validate runs the named schema against an already-decoded value (map / []any / scalar).
func (s *SchemaSet) Validate(name string, decoded interface{}) error {
	s.mu.RLock()
	sc, ok := s.cache[name]
	s.mu.RUnlock()
	if !ok {
		return fmt.Errorf("validation: schema %q not registered", name)
	}
	if err := sc.Validate(decoded); err != nil {
		return fmt.Errorf("validation: %s", flattenJSONSchemaErr(err))
	}
	return nil
}

// flattenJSONSchemaErr collapses the verbose multi-line jsonschema error into
// a single API-friendly string.
func flattenJSONSchemaErr(err error) string {
	if ve, ok := err.(*jsonschema.ValidationError); ok {
		// Walk causes once; deepest leaf is usually the most actionable.
		leaf := ve
		for len(leaf.Causes) > 0 {
			leaf = leaf.Causes[0]
		}
		return fmt.Sprintf("%s @ %s", leaf.Message, leaf.InstanceLocation)
	}
	return err.Error()
}

// Default is the package-level set with all built-in schemas pre-registered.
var Default = func() *SchemaSet {
	s := NewSchemaSet()
	s.Register("policy.params", policyParamsSchema)
	s.Register("cluster.guard", clusterGuardSchema)
	s.Register("storage.backend", storageBackendSchema)
	s.Register("change_window", changeWindowSchema)
	return s
}()

// ---------------------- Built-in schemas ----------------------

const policyParamsSchema = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "to_ec":      {"type":"number","minimum":0,"maximum":1},
    "to_cloud":   {"type":"number","minimum":0,"maximum":1},
    "to_archive": {"type":"number","minimum":0,"maximum":1},
    "weights":    {"type":"object","additionalProperties":{"type":"number","minimum":0,"maximum":1}},
    "target_backend": {"type":"string","minLength":1},
    "min_size_bytes": {"type":"integer","minimum":0},
    "exclude_collections": {"type":"array","items":{"type":"string"}}
  }
}`

const clusterGuardSchema = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "max_concurrent_migrations": {"type":"integer","minimum":1,"maximum":256},
    "max_daily_bytes":           {"type":"integer","minimum":0},
    "min_free_pct_src":          {"type":"number","minimum":0,"maximum":100},
    "min_free_pct_dst":          {"type":"number","minimum":0,"maximum":100},
    "block_during_holiday":      {"type":"boolean"},
    "max_bandwidth_mbps":        {"type":"integer","minimum":1}
  }
}`

const storageBackendSchema = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["kind","endpoint"],
  "additionalProperties": false,
  "properties": {
    "kind":     {"type":"string","enum":["s3","oss","obs","cos","minio"]},
    "endpoint": {"type":"string","minLength":1},
    "region":   {"type":"string"},
    "bucket":   {"type":"string","minLength":1},
    "path_prefix": {"type":"string"},
    "access_key_ref": {"type":"string"},
    "secret_key_ref": {"type":"string"},
    "encryption":     {"type":"string","enum":["","sse-s3","sse-kms","aes256"]},
    "force_path_style": {"type":"boolean"}
  }
}`

const changeWindowSchema = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "enabled":       {"type":"boolean"},
    "start_hour":    {"type":"integer","minimum":0,"maximum":23},
    "end_hour":      {"type":"integer","minimum":0,"maximum":23},
    "weekdays_only": {"type":"boolean"},
    "timezone":      {"type":"string"}
  }
}`
