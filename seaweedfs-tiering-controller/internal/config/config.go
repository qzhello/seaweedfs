package config

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server     Server     `yaml:"server"`
	Postgres   Postgres   `yaml:"postgres"`
	ClickHouse ClickHouse `yaml:"clickhouse"`
	Seaweed    Seaweed    `yaml:"seaweed"`
	Scheduler  Scheduler  `yaml:"scheduler"`
	Scoring    Scoring    `yaml:"scoring"`
	AI         AI         `yaml:"ai"`
	Executor   Executor   `yaml:"executor"`
}

type Server struct {
	HTTPAddr string `yaml:"http_addr"`
	LogLevel string `yaml:"log_level"`
}

type Postgres struct {
	DSN      string `yaml:"dsn"`
	MaxConns int32  `yaml:"max_conns"`
}

type ClickHouse struct {
	Addr     []string `yaml:"addr"`
	Database string   `yaml:"database"`
	Username string   `yaml:"username"`
	Password string   `yaml:"password"`
}

type Seaweed struct {
	Master          string        `yaml:"master"`
	Filer           string        `yaml:"filer"`
	GrpcDialTimeout time.Duration `yaml:"grpc_dial_timeout"`
}

type Scheduler struct {
	Enabled       bool   `yaml:"enabled"`
	ScoringCron   string `yaml:"scoring_cron"`
	ExecutionCron string `yaml:"execution_cron"`
	CooldownDays  int    `yaml:"cooldown_days"`
	DryRunGlobal  bool   `yaml:"dry_run_global"`
}

type Scoring struct {
	Weights    map[string]float64 `yaml:"weights"`
	Thresholds map[string]float64 `yaml:"thresholds"`
}

type AI struct {
	Provider       string        `yaml:"provider"`
	OpenAI         AIVendor      `yaml:"openai"`
	Anthropic      AIVendor      `yaml:"anthropic"`
	RequestTimeout time.Duration `yaml:"request_timeout"`
	MaxConcurrency int           `yaml:"max_concurrency"`
}

type AIVendor struct {
	APIKey  string `yaml:"api_key"`
	Model   string `yaml:"model"`
	BaseURL string `yaml:"base_url"`
}

type Executor struct {
	ParallelLimit  int    `yaml:"parallel_limit"`
	ShellPath      string `yaml:"shell_path"`
	RetainLocalDat bool   `yaml:"retain_local_dat"`
}

func Load(path string) (*Config, error) {
	if path == "" {
		path = os.Getenv("TIER_CONFIG")
	}
	if path == "" {
		return nil, fmt.Errorf("config path required (-config or TIER_CONFIG)")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var c Config
	if err := yaml.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return &c, nil
}
