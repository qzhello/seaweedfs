package api

import (
	"context"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
)

// filerProbeTimeout caps the per-filer HTTP `/status` probe so one dead
// filer cannot stall the whole listing.
const filerProbeTimeout = 2 * time.Second

type clusterFilerRow struct {
	Address     string `json:"address"`
	Version     string `json:"version,omitempty"`
	DataCenter  string `json:"data_center,omitempty"`
	Rack        string `json:"rack,omitempty"`
	CreatedAtNs int64  `json:"created_at_ns,omitempty"`
	Reachable   bool   `json:"reachable"`
	LatencyMS   int64  `json:"latency_ms,omitempty"`
	ProbeError  string `json:"probe_error,omitempty"`
	Health      string `json:"health"` // ok | warn | err
	// Source flags where the filer came from. Possible values:
	//   "master"      – reported by master heartbeat (authoritative)
	//   "config"      – only in cluster.filer_addr, master didn't see it
	//   "master+config" – in both (the normal happy path)
	Source string `json:"source"`
}

type clusterFilersResponse struct {
	ConfiguredMaster string            `json:"configured_master"`
	// MasterListError carries the master-side ListFilers error (if any)
	// so the page can flag "couldn't reach master, only showing
	// configured filers" without failing the whole request. Empty when
	// the master responded normally.
	MasterListError string            `json:"master_list_error,omitempty"`
	Filers          []clusterFilerRow `json:"filers"`
}

func clusterFilers(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
		defer cancel()

		// Source 1: master heartbeat (authoritative, includes version/DC/rack).
		nodes, listErr := d.Sw.ListFilers(ctx, cl.MasterAddr)

		// Source 2: cluster.filer_addr configured at registration time.
		// This is the operator-asserted truth — useful as a fallback when
		// the filer-to-master heartbeat is broken or the filer was just
		// started and hasn't registered yet.
		configured := splitCSV(cl.FilerAddr)

		rows := mergeFilerSources(nodes, configured)
		rows = probeFilers(ctx, rows)

		sort.Slice(rows, func(i, j int) bool { return rows[i].Address < rows[j].Address })
		resp := clusterFilersResponse{
			ConfiguredMaster: cl.MasterAddr,
			Filers:           rows,
		}
		if listErr != nil {
			resp.MasterListError = listErr.Error()
		}
		c.JSON(http.StatusOK, resp)
	}
}

// mergeFilerSources unions master-reported and config-listed filers into
// one row slice, tagging each with where it came from. Address is the
// merge key. Master data wins on overlap (the master knows version/DC),
// but the row's Source becomes "master+config" so the UI can show both
// sources agree.
func mergeFilerSources(masterNodes []seaweed.FilerNode, configured []string) []clusterFilerRow {
	index := map[string]int{} // address → rows[index]
	rows := make([]clusterFilerRow, 0, len(masterNodes)+len(configured))
	for _, n := range masterNodes {
		if n.Address == "" {
			continue
		}
		index[n.Address] = len(rows)
		rows = append(rows, clusterFilerRow{
			Address:     n.Address,
			Version:     n.Version,
			DataCenter:  n.DataCenter,
			Rack:        n.Rack,
			CreatedAtNs: n.CreatedAtNs,
			Source:      "master",
		})
	}
	for _, addr := range configured {
		if i, ok := index[addr]; ok {
			rows[i].Source = "master+config"
			continue
		}
		index[addr] = len(rows)
		rows = append(rows, clusterFilerRow{
			Address: addr,
			Source:  "config",
		})
	}
	return rows
}

// probeFilers runs an HTTP `/status` probe against every filer in parallel
// so the page can show reachability/latency alongside what the master
// reported. One slow node never blocks the others. Health rolls up
// reachability and source: a "config" row that's reachable still gets
// "warn" because the master isn't seeing it — the filer is alive but
// the heartbeat is broken.
func probeFilers(ctx context.Context, rows []clusterFilerRow) []clusterFilerRow {
	var wg sync.WaitGroup
	for i := range rows {
		i := i
		addr := rows[i].Address
		wg.Add(1)
		go func() {
			defer wg.Done()
			subctx, cancel := context.WithTimeout(ctx, filerProbeTimeout)
			defer cancel()
			latency, err := probeFilerStatus(subctx, addr)
			if err != nil {
				rows[i].Reachable = false
				rows[i].ProbeError = err.Error()
				rows[i].Health = "err"
				return
			}
			rows[i].Reachable = true
			rows[i].LatencyMS = latency.Milliseconds()
			if rows[i].Source == "config" {
				rows[i].Health = "warn"
			} else {
				rows[i].Health = "ok"
			}
		}()
	}
	wg.Wait()
	return rows
}

func probeFilerStatus(ctx context.Context, addr string) (time.Duration, error) {
	start := time.Now()
	url := "http://" + addr + "/status"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return time.Since(start), err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return time.Since(start), &filerProbeError{status: resp.StatusCode}
	}
	return time.Since(start), nil
}

type filerProbeError struct{ status int }

func (e *filerProbeError) Error() string {
	return http.StatusText(e.status)
}
