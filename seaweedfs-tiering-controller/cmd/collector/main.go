// Collector is a thin shim that consumes SeaweedFS S3 access logs
// (already shipped via fluentd / kafka) and writes them into ClickHouse.
//
// Two modes:
//   - --mode=stdin: read newline-delimited JSON access logs from stdin
//                   (use this for fluentd `out_exec` or as a sidecar).
//   - --mode=http:  expose POST /ingest accepting batches of access logs.
//
// Both modes produce identical writes to tiering.access_log.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/config"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

type rawLog struct {
	Bucket     string `json:"bucket"`
	Time       int64  `json:"time"`
	Operation  string `json:"operation"`
	Key        string `json:"key"`
	HTTPStatus int    `json:"status"`
	BytesSent  string `json:"bytes_sent"`
	ObjectSize string `json:"object_size"`
	TotalTime  int    `json:"total_time"`
	Requester  string `json:"requester"`
	RemoteIP   string `json:"remote_ip"`
	// Optional, depends on collector source:
	Collection string `json:"collection"`
	VolumeID   uint32 `json:"volume_id"`
	FileID     string `json:"file_id"`
}

func main() {
	cfgPath := flag.String("config", "", "config yaml")
	mode := flag.String("mode", "stdin", "stdin|http")
	addr := flag.String("addr", ":8081", "listen addr in http mode")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	ch, err := store.NewCH(context.Background(), cfg.ClickHouse.Addr, cfg.ClickHouse.Database,
		cfg.ClickHouse.Username, cfg.ClickHouse.Password)
	if err != nil {
		logger.Fatal("clickhouse", zap.Error(err))
	}
	defer ch.Close()

	switch *mode {
	case "stdin":
		runStdin(ch, logger)
	case "http":
		runHTTP(ch, logger, *addr)
	default:
		logger.Fatal("unknown mode", zap.String("mode", *mode))
	}
}

func runStdin(ch *store.CH, log *zap.Logger) {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	batch := make([]store.AccessLogEvent, 0, 1000)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := ch.InsertAccessLog(ctx, batch); err != nil {
			log.Error("insert", zap.Error(err))
		}
		batch = batch[:0]
	}
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	go func() {
		for range tick.C {
			flush()
		}
	}()
	for scanner.Scan() {
		var r rawLog
		if err := json.Unmarshal(scanner.Bytes(), &r); err != nil {
			continue
		}
		batch = append(batch, toEvent(r))
		if len(batch) >= 1000 {
			flush()
		}
	}
	flush()
}

func runHTTP(ch *store.CH, log *zap.Logger, addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ingest", func(w http.ResponseWriter, r *http.Request) {
		var rs []rawLog
		if err := json.NewDecoder(r.Body).Decode(&rs); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		evs := make([]store.AccessLogEvent, 0, len(rs))
		for _, x := range rs {
			evs = append(evs, toEvent(x))
		}
		if err := ch.InsertAccessLog(r.Context(), evs); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	log.Info("collector http listening", zap.String("addr", addr))
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal("listen", zap.Error(err))
	}
}

func toEvent(r rawLog) store.AccessLogEvent {
	bs, _ := strconv.ParseUint(r.BytesSent, 10, 64)
	os_, _ := strconv.ParseUint(r.ObjectSize, 10, 64)
	ts := time.Unix(r.Time, 0)
	if r.Time == 0 {
		ts = time.Now()
	}
	return store.AccessLogEvent{
		TS:          ts,
		Bucket:      r.Bucket,
		Collection:  r.Collection,
		VolumeID:    r.VolumeID,
		FileID:      r.FileID,
		Path:        r.Key,
		Operation:   r.Operation,
		ObjectSize:  os_,
		BytesSent:   bs,
		TotalTimeMs: uint32(r.TotalTime),
		HTTPStatus:  uint16(r.HTTPStatus),
		Requester:   r.Requester,
		RemoteIP:    r.RemoteIP,
	}
}
