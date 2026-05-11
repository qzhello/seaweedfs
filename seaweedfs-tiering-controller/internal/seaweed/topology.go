package seaweed

import "context"

// Topology is the flattened tree returned to the UI.
type Topology struct {
	DataCenters []DCInfo `json:"data_centers"`
	Totals      Totals   `json:"totals"`
}

type DCInfo struct {
	ID    string     `json:"id"`
	Racks []RackInfo `json:"racks"`
}

type RackInfo struct {
	ID    string     `json:"id"`
	Nodes []NodeInfo `json:"nodes"`
}

type NodeInfo struct {
	ID    string     `json:"id"`
	Disks []DiskInfo `json:"disks"`
}

type DiskInfo struct {
	Type        string `json:"type"`
	Capacity    uint64 `json:"capacity"`
	Used        uint64 `json:"used"`
	VolumeCount uint32 `json:"volume_count"`
	MaxVolumes  uint64 `json:"max_volumes"`
}

type Totals struct {
	DataCenters int    `json:"data_centers"`
	Racks       int    `json:"racks"`
	Nodes       int    `json:"nodes"`
	Disks       int    `json:"disks"`
	Volumes     int    `json:"volumes"`
	Capacity    uint64 `json:"capacity"`
	Used        uint64 `json:"used"`
}

// FetchTopology returns the topology of the *given* master.
//
// Delegates to FetchTopologyShellAt with an empty binary path so the
// global resolution chain ($WEED_BIN / $PATH / monorepo defaults) picks
// up the controller's bundled `weed`. Callers that know the cluster
// should use FetchTopologyShellAt with cluster.weed_bin_path.
func (c *Client) FetchTopology(ctx context.Context, masterAddr string) (*Topology, error) {
	return c.FetchTopologyShellAt(ctx, masterAddr, "")
}

// FetchTopologyShellAt builds the topology view from `weed shell
// volume.list` so we don't have to keep the controller's master_pb in
// lockstep with every SeaweedFS release.
func (c *Client) FetchTopologyShellAt(ctx context.Context, masterAddr, binPath string) (*Topology, error) {
	vols, nodes, err := c.ListVolumesShellAt(ctx, masterAddr, binPath)
	if err != nil {
		return nil, err
	}
	return buildTopologyFromShell(vols, nodes), nil
}

// buildTopologyFromShell folds the flat (vol, node) lists back into the
// DC → rack → node → disk hierarchy the UI expects. Volume sizes are
// summed per disk; capacity uses the SeaweedFS default 30 GiB per slot
// because the text output doesn't expose the master's volumeSizeLimit.
func buildTopologyFromShell(vols []VolumeInfo, nodes []NodeDiskStats) *Topology {
	const defaultVolumeBytes = uint64(30) * 1024 * 1024 * 1024

	type diskKey struct{ node, disk string }
	usedByDisk := map[diskKey]uint64{}
	volCountByDisk := map[diskKey]uint32{}
	for _, v := range vols {
		k := diskKey{v.Server, v.DiskType}
		usedByDisk[k] += v.Size
		volCountByDisk[k]++
	}

	dcs := map[string]*DCInfo{}
	dcOrder := []string{}
	rackMap := map[string]map[string]*RackInfo{} // dc → rack id → rack
	rackOrder := map[string][]string{}
	nodeMap := map[string]map[string]map[string]*NodeInfo{} // dc → rack → node id → node
	nodeOrder := map[string]map[string][]string{}

	t := &Topology{}

	for _, ns := range nodes {
		dc := dcs[ns.DataCenter]
		if dc == nil {
			dc = &DCInfo{ID: ns.DataCenter}
			dcs[ns.DataCenter] = dc
			dcOrder = append(dcOrder, ns.DataCenter)
			rackMap[ns.DataCenter] = map[string]*RackInfo{}
			nodeMap[ns.DataCenter] = map[string]map[string]*NodeInfo{}
			nodeOrder[ns.DataCenter] = map[string][]string{}
			t.Totals.DataCenters++
		}
		rack := rackMap[ns.DataCenter][ns.Rack]
		if rack == nil {
			rack = &RackInfo{ID: ns.Rack}
			rackMap[ns.DataCenter][ns.Rack] = rack
			rackOrder[ns.DataCenter] = append(rackOrder[ns.DataCenter], ns.Rack)
			nodeMap[ns.DataCenter][ns.Rack] = map[string]*NodeInfo{}
			t.Totals.Racks++
		}
		node := nodeMap[ns.DataCenter][ns.Rack][ns.Server]
		if node == nil {
			node = &NodeInfo{ID: ns.Server}
			nodeMap[ns.DataCenter][ns.Rack][ns.Server] = node
			nodeOrder[ns.DataCenter][ns.Rack] = append(nodeOrder[ns.DataCenter][ns.Rack], ns.Server)
			t.Totals.Nodes++
		}
		key := diskKey{ns.Server, ns.DiskType}
		used := usedByDisk[key]
		vc := volCountByDisk[key]
		di := DiskInfo{
			Type:        ns.DiskType,
			Used:        used,
			VolumeCount: vc,
			MaxVolumes:  uint64(ns.MaxVolumeCount),
			Capacity:    uint64(ns.MaxVolumeCount) * defaultVolumeBytes,
		}
		node.Disks = append(node.Disks, di)
		t.Totals.Disks++
		t.Totals.Volumes += int(vc)
		t.Totals.Capacity += di.Capacity
		t.Totals.Used += di.Used
	}

	for _, dcID := range dcOrder {
		dc := dcs[dcID]
		for _, rackID := range rackOrder[dcID] {
			rack := rackMap[dcID][rackID]
			for _, nodeID := range nodeOrder[dcID][rackID] {
				rack.Nodes = append(rack.Nodes, *nodeMap[dcID][rackID][nodeID])
			}
			dc.Racks = append(dc.Racks, *rack)
		}
		t.DataCenters = append(t.DataCenters, *dc)
	}
	return t
}
