// Package skill implements the Skill registry: a versioned catalog of
// declarative recipes for SeaweedFS operations and operator-defined SOPs.
//
// A Skill is a JSON document validated against schema.go's definitionSchema.
// The registry loads enabled skills from PostgreSQL into an in-memory map for
// fast lookup; callers refresh via Reload (cheap — single SELECT).
package skill

import (
	"encoding/json"
	"fmt"
)

// definitionSchema is the JSON Schema enforced before a Skill is persisted or
// upserted from the system catalog. It deliberately uses
// additionalProperties:false at every level so unknown keys (typos, future
// fields) are rejected loudly.
const definitionSchema = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["summary","steps"],
  "additionalProperties": false,
  "properties": {
    "summary":     {"type":"string","minLength":1,"maxLength":500},
    "description": {"type":"string","maxLength":4000},
    "params": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name","type"],
        "additionalProperties": false,
        "properties": {
          "name":     {"type":"string","pattern":"^[a-z][a-z0-9_]*$"},
          "type":     {"type":"string","enum":["string","int","bool","duration","enum","object"]},
          "required": {"type":"boolean"},
          "default":  {},
          "enum":     {"type":"array","items":{"type":"string"}},
          "min":      {"type":"number"},
          "max":      {"type":"number"},
          "doc":      {"type":"string"}
        }
      }
    },
    "preconditions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["check"],
        "additionalProperties": false,
        "properties": {
          "check":   {"type":"string","minLength":1},
          "args":    {"type":"object"},
          "doc":     {"type":"string"},
          "fatal":   {"type":"boolean"}
        }
      }
    },
    "steps": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["op"],
        "additionalProperties": false,
        "properties": {
          "id":     {"type":"string","pattern":"^[a-z][a-z0-9_]*$"},
          "op":     {"type":"string","minLength":1},
          "args":   {"type":"object"},
          "doc":    {"type":"string"},
          "timeout_seconds": {"type":"integer","minimum":1,"maximum":86400},
          "retry":  {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "max_attempts": {"type":"integer","minimum":1,"maximum":10},
              "backoff_seconds": {"type":"integer","minimum":1,"maximum":3600}
            }
          },
          "on_failure": {"type":"string","enum":["abort","continue","rollback"]}
        }
      }
    },
    "postchecks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["check"],
        "additionalProperties": false,
        "properties": {
          "check": {"type":"string","minLength":1},
          "args":  {"type":"object"},
          "doc":   {"type":"string"}
        }
      }
    },
    "rollback": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["op"],
        "additionalProperties": false,
        "properties": {
          "op":   {"type":"string","minLength":1},
          "args": {"type":"object"},
          "doc":  {"type":"string"}
        }
      }
    }
  }
}`

// Definition is the strongly-typed view of a Skill JSONB definition. Callers
// can either work with the raw JSONB (for diff/edit UI) or unmarshal into this.
type Definition struct {
	Summary       string         `json:"summary"`
	Description   string         `json:"description,omitempty"`
	Params        []Param        `json:"params,omitempty"`
	Preconditions []Check        `json:"preconditions,omitempty"`
	Steps         []Step         `json:"steps"`
	Postchecks    []Check        `json:"postchecks,omitempty"`
	Rollback      []RollbackStep `json:"rollback,omitempty"`
}

type Param struct {
	Name     string   `json:"name"`
	Type     string   `json:"type"`
	Required bool     `json:"required,omitempty"`
	Default  any      `json:"default,omitempty"`
	Enum     []string `json:"enum,omitempty"`
	Min      *float64 `json:"min,omitempty"`
	Max      *float64 `json:"max,omitempty"`
	Doc      string   `json:"doc,omitempty"`
}

type Check struct {
	Check string         `json:"check"`
	Args  map[string]any `json:"args,omitempty"`
	Doc   string         `json:"doc,omitempty"`
	Fatal bool           `json:"fatal,omitempty"`
}

type Step struct {
	ID             string         `json:"id,omitempty"`
	Op             string         `json:"op"`
	Args           map[string]any `json:"args,omitempty"`
	Doc            string         `json:"doc,omitempty"`
	TimeoutSeconds int            `json:"timeout_seconds,omitempty"`
	Retry          *Retry         `json:"retry,omitempty"`
	OnFailure      string         `json:"on_failure,omitempty"`
}

type Retry struct {
	MaxAttempts    int `json:"max_attempts,omitempty"`
	BackoffSeconds int `json:"backoff_seconds,omitempty"`
}

type RollbackStep struct {
	Op   string         `json:"op"`
	Args map[string]any `json:"args,omitempty"`
	Doc  string         `json:"doc,omitempty"`
}

// ParseDefinition validates raw JSONB against the schema and unmarshals it.
// Returns a typed Definition or a humanized validation error.
func ParseDefinition(raw json.RawMessage) (*Definition, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("empty definition")
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("definition is not valid JSON: %w", err)
	}
	if err := schemaSet.Validate("skill.definition", decoded); err != nil {
		return nil, err
	}
	var d Definition
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, fmt.Errorf("definition shape mismatch: %w", err)
	}
	return &d, nil
}
