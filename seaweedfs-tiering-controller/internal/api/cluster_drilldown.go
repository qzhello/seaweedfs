package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
)

// ecTotalShards mirrors the default SeaweedFS 10+4 EC layout. The shard
// matrix view always renders 14 columns so missing shards stay visually
// obvious — clusters running a non-default layout would still get a row
// with empty trailing cells.
const ecTotalShards = 14

// collectionDetailResponse is the aggregated view rendered by the
// /clusters/:id/collections/:name page. Each row in `volumes` is one
// (volume,node) replica or one (ec-volume,node) EC slice so the UI can
// drill down to placement without a second request.
type collectionDetailResponse struct {
	Name                    string              `json:"name"`
	VolumeCount             int                 `json:"volume_count"`
	ReplicaRowCount         int                 `json:"replica_row_count"`
	TotalSize               uint64              `json:"total_size"`
	FileCount               uint64              `json:"file_count"`
	DeletedBytes            uint64              `json:"deleted_bytes"`
	DeleteCount             uint64              `json:"delete_count"`
	ECVolumeCount           int                 `json:"ec_volume_count"`
	ReadOnlyVolumes         int                 `json:"read_only_volumes"`
	ReplicationDistribution map[string]int      `json:"replication_distribution"`
	ServerDistribution      map[string]int      `json:"server_distribution"`
	Volumes                 []seaweed.VolumeInfo `json:"volumes"`
}

// volumeServerDetailResponse describes one volume server (all the
// volumes/EC-slices it currently hosts) plus its topology placement.
type volumeServerDetailResponse struct {
	Address       string              `json:"address"`
	DataCenter    string              `json:"data_center"`
	Rack          string              `json:"rack"`
	VolumeCount   int                 `json:"volume_count"`
	UsedBytes     uint64              `json:"used_bytes"`
	MaxVolumes    int64               `json:"max_volumes"`
	FreeVolumes   int64               `json:"free_volumes"`
	ECShardCount  int                 `json:"ec_shard_count"`
	ReadOnlyCount int                 `json:"read_only_count"`
	Disks         []diskSummary       `json:"disks"`
	Volumes       []seaweed.VolumeInfo `json:"volumes"`
}

type diskSummary struct {
	DiskType        string `json:"disk_type"`
	VolumeCount     int64  `json:"volume_count"`
	MaxVolumeCount  int64  `json:"max_volume_count"`
	FreeVolumeCount int64  `json:"free_volume_count"`
	UsedBytes       uint64 `json:"used_bytes"`
}

func clusterCollectionDetail(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		raw := c.Param("name")
		if decoded, derr := url.PathUnescape(raw); derr == nil {
			raw = decoded
		}
		name := strings.TrimSpace(raw)
		if name == "_default_" {
			name = "" // shell sentinel for the default (unnamed) collection
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		vols, _, ferr := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
		if ferr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": ferr.Error()})
			return
		}
		c.JSON(http.StatusOK, buildCollectionDetail(name, vols))
	}
}

func clusterVolumeServerDetail(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		raw := c.Param("addr")
		if decoded, derr := url.PathUnescape(raw); derr == nil {
			raw = decoded
		}
		addr := strings.TrimSpace(raw)
		if addr == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "addr is required"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		vols, nodes, ferr := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
		if ferr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": ferr.Error()})
			return
		}
		c.JSON(http.StatusOK, buildVolumeServerDetail(addr, vols, nodes))
	}
}

// buildCollectionDetail aggregates volume rows scoped to one collection.
// `vols` is the full cluster list; rows belonging to other collections are
// ignored so callers don't have to pre-filter.
func buildCollectionDetail(name string, vols []seaweed.VolumeInfo) collectionDetailResponse {
	resp := collectionDetailResponse{
		Name:                    name,
		ReplicationDistribution: map[string]int{},
		ServerDistribution:      map[string]int{},
		Volumes:                 []seaweed.VolumeInfo{},
	}
	uniqueVolumes := map[uint32]struct{}{}
	uniqueECVolumes := map[uint32]struct{}{}
	uniqueROVolumes := map[uint32]struct{}{}
	for _, v := range vols {
		if v.Collection != name {
			continue
		}
		resp.ReplicaRowCount++
		resp.TotalSize += v.Size
		resp.FileCount += v.FileCount
		resp.DeletedBytes += v.DeletedBytes
		resp.DeleteCount += v.DeleteCount
		uniqueVolumes[v.ID] = struct{}{}
		if v.IsEC {
			uniqueECVolumes[v.ID] = struct{}{}
		}
		if v.ReadOnly {
			uniqueROVolumes[v.ID] = struct{}{}
		}
		repl := formatReplicaPlacement(v.ReplicaPlace, v.IsEC)
		resp.ReplicationDistribution[repl]++
		if v.Server != "" {
			resp.ServerDistribution[v.Server]++
		}
		resp.Volumes = append(resp.Volumes, v)
	}
	resp.VolumeCount = len(uniqueVolumes)
	resp.ECVolumeCount = len(uniqueECVolumes)
	resp.ReadOnlyVolumes = len(uniqueROVolumes)
	sort.SliceStable(resp.Volumes, func(i, j int) bool {
		if resp.Volumes[i].ID != resp.Volumes[j].ID {
			return resp.Volumes[i].ID < resp.Volumes[j].ID
		}
		return resp.Volumes[i].Server < resp.Volumes[j].Server
	})
	return resp
}

// buildVolumeServerDetail collects every (volume,node) row for one server
// plus its disk topology stats so the page can render placement metadata
// without a second request.
func buildVolumeServerDetail(addr string, vols []seaweed.VolumeInfo, nodes []seaweed.NodeDiskStats) volumeServerDetailResponse {
	resp := volumeServerDetailResponse{
		Address: addr,
		Disks:   []diskSummary{},
		Volumes: []seaweed.VolumeInfo{},
	}
	uniqueVols := map[uint32]struct{}{}
	uniqueRO := map[uint32]struct{}{}
	for _, v := range vols {
		if v.Server != addr {
			continue
		}
		if resp.DataCenter == "" {
			resp.DataCenter = v.DataCenter
		}
		if resp.Rack == "" {
			resp.Rack = v.Rack
		}
		uniqueVols[v.ID] = struct{}{}
		if v.ReadOnly {
			uniqueRO[v.ID] = struct{}{}
		}
		if v.IsEC {
			resp.ECShardCount += len(v.Shards)
		}
		resp.UsedBytes += v.Size
		resp.Volumes = append(resp.Volumes, v)
	}
	resp.VolumeCount = len(uniqueVols)
	resp.ReadOnlyCount = len(uniqueRO)

	for _, n := range nodes {
		if n.Server != addr {
			continue
		}
		if resp.DataCenter == "" {
			resp.DataCenter = n.DataCenter
		}
		if resp.Rack == "" {
			resp.Rack = n.Rack
		}
		resp.MaxVolumes += n.MaxVolumeCount
		resp.FreeVolumes += n.FreeVolumeCount
		resp.Disks = append(resp.Disks, diskSummary{
			DiskType:        n.DiskType,
			VolumeCount:     n.VolumeCount,
			MaxVolumeCount:  n.MaxVolumeCount,
			FreeVolumeCount: n.FreeVolumeCount,
			UsedBytes:       n.UsedBytes,
		})
	}
	sort.SliceStable(resp.Disks, func(i, j int) bool {
		return resp.Disks[i].DiskType < resp.Disks[j].DiskType
	})
	sort.SliceStable(resp.Volumes, func(i, j int) bool {
		return resp.Volumes[i].ID < resp.Volumes[j].ID
	})
	return resp
}

// --- Single volume detail ---------------------------------------------------

type volumeDetailResponse struct {
	ID              uint32               `json:"id"`
	Collection      string               `json:"collection"`
	IsEC            bool                 `json:"is_ec"`
	ReplicaPlace    uint32               `json:"replica_place"`
	Placement       string               `json:"placement"`
	ReadOnly        bool                 `json:"read_only"`
	TotalSize       uint64               `json:"total_size"`
	FileCount       uint64               `json:"file_count"`
	DeleteCount     uint64               `json:"delete_count"`
	DeletedBytes    uint64               `json:"deleted_bytes"`
	ReplicaCount    int                  `json:"replica_count"`
	ECShardCount    int                  `json:"ec_shard_count"`
	ECShardsPresent []int                `json:"ec_shards_present"`
	ECShardsMissing []int                `json:"ec_shards_missing"`
	Servers         []string             `json:"servers"`
	Replicas        []seaweed.VolumeInfo `json:"replicas"`
}

func clusterVolumeDetail(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		vid64, err := strconv.ParseUint(c.Param("vid"), 10, 32)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad volume id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		vols, _, ferr := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
		if ferr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": ferr.Error()})
			return
		}
		detail, ok := buildVolumeDetail(uint32(vid64), vols)
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "volume not found"})
			return
		}
		c.JSON(http.StatusOK, detail)
	}
}

// buildVolumeDetail aggregates every (volume,node) row for one volume id.
// Returns ok=false when no row matches, so the handler can 404 cleanly.
// For EC volumes the response carries the union of shards present across
// all nodes plus the complement (missing shards 0..13) — that's the
// single most important piece of info on a single-volume page.
func buildVolumeDetail(vid uint32, vols []seaweed.VolumeInfo) (volumeDetailResponse, bool) {
	rows := make([]seaweed.VolumeInfo, 0, 4)
	for _, v := range vols {
		if v.ID == vid {
			rows = append(rows, v)
		}
	}
	if len(rows) == 0 {
		return volumeDetailResponse{}, false
	}
	out := volumeDetailResponse{
		ID:           vid,
		Collection:   rows[0].Collection,
		IsEC:         rows[0].IsEC,
		ReplicaPlace: rows[0].ReplicaPlace,
		ReadOnly:     rows[0].ReadOnly,
		Replicas:     rows,
	}
	out.Placement = formatReplicaPlacement(out.ReplicaPlace, out.IsEC)
	serverSet := map[string]struct{}{}
	shardSet := map[int]struct{}{}
	for _, v := range rows {
		out.TotalSize += v.Size
		out.FileCount += v.FileCount
		out.DeleteCount += v.DeleteCount
		out.DeletedBytes += v.DeletedBytes
		if v.Server != "" {
			serverSet[v.Server] = struct{}{}
		}
		for _, shard := range v.Shards {
			shardSet[shard] = struct{}{}
		}
	}
	out.ReplicaCount = len(serverSet)
	out.Servers = sortedKeys(serverSet)
	if out.IsEC {
		present := make([]int, 0, len(shardSet))
		for shard := range shardSet {
			present = append(present, shard)
		}
		sort.Ints(present)
		out.ECShardsPresent = present
		out.ECShardCount = len(present)
		missing := make([]int, 0, ecTotalShards)
		for i := 0; i < ecTotalShards; i++ {
			if _, ok := shardSet[i]; !ok {
				missing = append(missing, i)
			}
		}
		out.ECShardsMissing = missing
	} else {
		out.ECShardsPresent = []int{}
		out.ECShardsMissing = []int{}
	}
	sort.SliceStable(out.Replicas, func(i, j int) bool {
		return out.Replicas[i].Server < out.Replicas[j].Server
	})
	return out, true
}

// --- EC shard matrix ---------------------------------------------------------

type ecShardLocation struct {
	Shard      int    `json:"shard"`
	Server     string `json:"server"`
	Rack       string `json:"rack,omitempty"`
	DataCenter string `json:"data_center,omitempty"`
	Size       uint64 `json:"size,omitempty"`
}

type ecVolumeMatrixRow struct {
	ID            uint32                       `json:"id"`
	Collection    string                       `json:"collection"`
	TotalSize     uint64                       `json:"total_size"`
	ShardsByIndex map[int][]ecShardLocation    `json:"shards_by_index"`
	Missing       []int                        `json:"missing"`
	Present       []int                        `json:"present"`
	ShardsPresent int                          `json:"shards_present"`
	ShardsMissing int                          `json:"shards_missing"`
	Healthy       bool                         `json:"healthy"`
}

type ecShardsResponse struct {
	TotalShards int                 `json:"total_shards"`
	Volumes     []ecVolumeMatrixRow `json:"volumes"`
}

// ecVolumeDetailResponse is the per-volume EC drilldown: the same 14-shard
// matrix as the list page, but scoped to a single id with extra
// per-shard ergonomics (rack/dc fanout, replica counts, repair hint).
type ecVolumeDetailResponse struct {
	ID            uint32                    `json:"id"`
	Collection    string                    `json:"collection"`
	TotalSize     uint64                    `json:"total_size"`
	TotalShards   int                       `json:"total_shards"`
	ShardsPresent int                       `json:"shards_present"`
	ShardsMissing int                       `json:"shards_missing"`
	Present       []int                     `json:"present"`
	Missing       []int                     `json:"missing"`
	Healthy       bool                      `json:"healthy"`
	ShardsByIndex map[int][]ecShardLocation `json:"shards_by_index"`
	// Hosts groups locations per server so the UI can render a
	// "who holds what" sidebar without re-pivoting the matrix.
	Hosts []ecVolumeHostSummary `json:"hosts"`
	// DataCenters / Racks list the distinct DCs/racks any shard lives
	// in — useful to spot a single-rack EC volume.
	DataCenters []string `json:"data_centers"`
	Racks       []string `json:"racks"`
}

type ecVolumeHostSummary struct {
	Server     string `json:"server"`
	Rack       string `json:"rack,omitempty"`
	DataCenter string `json:"data_center,omitempty"`
	ShardCount int    `json:"shard_count"`
	Shards     []int  `json:"shards"`
	Size       uint64 `json:"size"`
}

func clusterECVolumeDetail(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		vid64, err := strconv.ParseUint(c.Param("vid"), 10, 32)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad volume id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		vols, _, ferr := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
		if ferr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": ferr.Error()})
			return
		}
		detail, ok := buildECVolumeDetail(uint32(vid64), vols)
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "ec volume not found"})
			return
		}
		c.JSON(http.StatusOK, detail)
	}
}

// buildECVolumeDetail filters the cluster volume list to one EC volume id
// and pivots its rows into a per-shard matrix + per-host summary. Returns
// ok=false when no EC row matches that id so the caller can 404.
func buildECVolumeDetail(vid uint32, vols []seaweed.VolumeInfo) (ecVolumeDetailResponse, bool) {
	matrix := buildECShards(vols)
	var row ecVolumeMatrixRow
	found := false
	for _, r := range matrix.Volumes {
		if r.ID == vid {
			row = r
			found = true
			break
		}
	}
	if !found {
		return ecVolumeDetailResponse{}, false
	}
	hosts := map[string]*ecVolumeHostSummary{}
	dcSet := map[string]struct{}{}
	rackSet := map[string]struct{}{}
	for _, locs := range row.ShardsByIndex {
		for _, l := range locs {
			h, ok := hosts[l.Server]
			if !ok {
				h = &ecVolumeHostSummary{Server: l.Server, Rack: l.Rack, DataCenter: l.DataCenter}
				hosts[l.Server] = h
			}
			h.ShardCount++
			h.Shards = append(h.Shards, l.Shard)
			h.Size += l.Size
			if l.DataCenter != "" {
				dcSet[l.DataCenter] = struct{}{}
			}
			if l.Rack != "" {
				rackSet[l.Rack] = struct{}{}
			}
		}
	}
	hostList := make([]ecVolumeHostSummary, 0, len(hosts))
	for _, h := range hosts {
		sort.Ints(h.Shards)
		hostList = append(hostList, *h)
	}
	sort.SliceStable(hostList, func(i, j int) bool {
		return hostList[i].Server < hostList[j].Server
	})
	return ecVolumeDetailResponse{
		ID:            row.ID,
		Collection:    row.Collection,
		TotalSize:     row.TotalSize,
		TotalShards:   matrix.TotalShards,
		ShardsPresent: row.ShardsPresent,
		ShardsMissing: row.ShardsMissing,
		Present:       row.Present,
		Missing:       row.Missing,
		Healthy:       row.Healthy,
		ShardsByIndex: row.ShardsByIndex,
		Hosts:         hostList,
		DataCenters:   sortedKeys(dcSet),
		Racks:         sortedKeys(rackSet),
	}, true
}

func clusterECShards(d Deps) gin.HandlerFunc {
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
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		vols, _, ferr := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
		if ferr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": ferr.Error()})
			return
		}
		c.JSON(http.StatusOK, buildECShards(vols))
	}
}

// buildECShards groups every EC row by volume id and shard index. The
// resulting matrix carries one row per EC volume with a column per shard
// (0..ecTotalShards-1) — non-EC rows are ignored. A volume is `Healthy`
// when all 14 shards are present at least once across the cluster.
func buildECShards(vols []seaweed.VolumeInfo) ecShardsResponse {
	type bucket struct {
		collection string
		size       uint64
		shards     map[int][]ecShardLocation
	}
	groups := map[uint32]*bucket{}
	for _, v := range vols {
		if !v.IsEC {
			continue
		}
		g, ok := groups[v.ID]
		if !ok {
			g = &bucket{collection: v.Collection, shards: map[int][]ecShardLocation{}}
			groups[v.ID] = g
		}
		g.size += v.Size
		for idx, shard := range v.Shards {
			var sz uint64
			if idx < len(v.ShardSizes) {
				sz = v.ShardSizes[idx]
			}
			g.shards[shard] = append(g.shards[shard], ecShardLocation{
				Shard:      shard,
				Server:     v.Server,
				Rack:       v.Rack,
				DataCenter: v.DataCenter,
				Size:       sz,
			})
		}
	}
	out := ecShardsResponse{TotalShards: ecTotalShards, Volumes: []ecVolumeMatrixRow{}}
	for vid, g := range groups {
		row := ecVolumeMatrixRow{
			ID:            vid,
			Collection:    g.collection,
			TotalSize:     g.size,
			ShardsByIndex: g.shards,
			Present:       []int{},
			Missing:       []int{},
		}
		for i := 0; i < ecTotalShards; i++ {
			if locs, ok := g.shards[i]; ok && len(locs) > 0 {
				row.Present = append(row.Present, i)
			} else {
				row.Missing = append(row.Missing, i)
			}
		}
		row.ShardsPresent = len(row.Present)
		row.ShardsMissing = len(row.Missing)
		row.Healthy = row.ShardsMissing == 0
		out.Volumes = append(out.Volumes, row)
	}
	sort.SliceStable(out.Volumes, func(i, j int) bool {
		// Unhealthy first (so missing shards jump out), then by id.
		if out.Volumes[i].Healthy != out.Volumes[j].Healthy {
			return !out.Volumes[i].Healthy
		}
		return out.Volumes[i].ID < out.Volumes[j].ID
	})
	return out
}

// formatReplicaPlacement turns the SeaweedFS replica placement code into
// the 3-digit dc/rack/copy form operators recognise from `volume.list`
// (e.g. "010" = 1 extra rack copy). SeaweedFS encodes placement as a
// single decimal byte: dc*100 + rack*10 + sameRack. EC rows have no
// placement and get a stable "ec" bucket so the UI can separate them.
func formatReplicaPlacement(code uint32, isEC bool) string {
	if isEC {
		return "ec"
	}
	return fmt.Sprintf("%03d", code%1000)
}
