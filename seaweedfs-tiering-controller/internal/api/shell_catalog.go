package api

// shellCommand describes one `weed shell` command in a way the UI can
// render a guided form for it. Fields are deliberately conservative:
// only the most-used flags get a typed entry; everything else falls
// back to the raw-args input. The catalog is the single source of
// truth for both the allowlist enforced in clusterShellExec and the
// /api/v1/shell/catalog endpoint the ops console reads.
type shellCommand struct {
	Name     string     `json:"name"`      // dotted weed shell name, e.g. "volume.list"
	Category string     `json:"category"`  // grouping for the UI sidebar
	Risk     string     `json:"risk"`      // read | mutate | destructive
	Summary  string     `json:"summary"`   // one-line description for the list
	Args     []shellArg `json:"args"`      // optional typed arg fields; omit → raw-args only
	ReadOnly bool       `json:"read_only"` // true → skip lock/unlock wrap
	Streams  bool       `json:"streams"`   // long-running, output streams over time
}

// shellArg is one form field on the command panel. The UI renders by
// Kind and submits the resulting flag back into the shell command line.
type shellArg struct {
	Flag     string   `json:"flag"`     // CLI flag including dash, e.g. "-collection"
	Label    string   `json:"label"`    // human label
	Kind     string   `json:"kind"`     // string | int | bool | enum
	Required bool     `json:"required"` // UI marks with asterisk; backend leaves enforcement to weed
	Default  string   `json:"default"`  // pre-filled value
	Help     string   `json:"help"`     // helper text shown under the field
	Enum     []string `json:"enum,omitempty"`
}

// shellCatalog is the curated list. Risk classification is intentionally
// pessimistic — anything that writes to volumes / FS / config is at least
// "mutate"; anything that deletes data or moves it irreversibly is
// "destructive". The console requires a reason field for both.
//
// Add new commands here and they automatically become callable. Do NOT
// add commands that delete user data without explicit operator review —
// wrap those in a Skill instead.
var shellCatalog = []shellCommand{
	// ---------------- Volume ----------------
	{Name: "volume.list", Category: "volume", Risk: "read", ReadOnly: true,
		Summary: "List all volumes across the cluster with size, replication and disk type.",
		Args: []shellArg{
			{Flag: "-collection", Label: "Collection filter", Kind: "string", Help: "Only list volumes in this collection (regex)."},
			{Flag: "-readonly", Label: "Read-only only", Kind: "bool", Help: "Show only volumes currently marked read-only."},
		}},
	{Name: "volume.balance", Category: "volume", Risk: "mutate", Streams: true,
		Summary: "Move volumes between volume servers so disk usage is even.",
		Args: []shellArg{
			{Flag: "-collection", Label: "Collection", Kind: "string", Help: "Limit balancing to one collection (default all)."},
			{Flag: "-dataCenter", Label: "Data center", Kind: "string"},
			{Flag: "-racks", Label: "Racks (csv)", Kind: "string"},
			{Flag: "-nodes", Label: "Nodes (csv)", Kind: "string"},
			{Flag: "-force", Label: "Apply", Kind: "bool", Help: "Without this only a dry run is printed."},
		}},
	{Name: "volume.fix.replication", Category: "volume", Risk: "mutate", Streams: true,
		Summary: "Copy under-replicated volumes onto additional volume servers until they reach the target replication.",
		Args: []shellArg{
			{Flag: "-collectionPattern", Label: "Collection pattern", Kind: "string"},
			{Flag: "-volumeIdPattern", Label: "Volume id pattern", Kind: "string"},
			{Flag: "-force", Label: "Apply", Kind: "bool"},
			{Flag: "-doDelete", Label: "Delete extra replicas", Kind: "bool", Help: "Also remove over-replicated copies."},
		}},
	{Name: "volume.fsck", Category: "volume", Risk: "read", ReadOnly: true, Streams: true,
		Summary: "Cross-check volume server contents against the filer meta to find orphaned needles."},
	{Name: "volume.vacuum", Category: "volume", Risk: "mutate", Streams: true,
		Summary: "Compact volumes whose deleted byte ratio is above the garbage threshold.",
		Args: []shellArg{
			{Flag: "-garbageThreshold", Label: "Garbage threshold", Kind: "string", Default: "0.3", Help: "Float in [0,1]. Lower means more aggressive vacuum."},
			{Flag: "-volumeId", Label: "Volume id", Kind: "int"},
			{Flag: "-collection", Label: "Collection", Kind: "string"},
		}},
	{Name: "volume.vacuum.enable", Category: "volume", Risk: "mutate",
		Summary: "Re-enable background vacuum on all volume servers."},
	{Name: "volume.vacuum.disable", Category: "volume", Risk: "mutate",
		Summary: "Disable background vacuum (e.g. before a planned maintenance window)."},
	{Name: "volume.configure.replication", Category: "volume", Risk: "mutate",
		Summary: "Change a volume's replication setting (e.g. 000 → 001).",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int", Required: true},
			{Flag: "-replication", Label: "Replication", Kind: "string", Required: true, Help: "Three-digit code: dc-rack-node, e.g. 010."},
		}},
	{Name: "volume.mark", Category: "volume", Risk: "mutate",
		Summary: "Toggle a volume read-only / writable.",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int", Required: true},
			{Flag: "-readonly", Label: "Read-only", Kind: "bool"},
			{Flag: "-writable", Label: "Writable", Kind: "bool"},
		}},
	{Name: "volume.mount", Category: "volume", Risk: "mutate",
		Summary: "Re-mount a previously unmounted volume on its server.",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int", Required: true},
			{Flag: "-node", Label: "Node", Kind: "string", Required: true},
		}},
	{Name: "volume.unmount", Category: "volume", Risk: "mutate",
		Summary: "Unmount a volume from its server without deleting data.",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int", Required: true},
			{Flag: "-node", Label: "Node", Kind: "string", Required: true},
		}},
	{Name: "volume.move", Category: "volume", Risk: "mutate", Streams: true,
		Summary: "Move a volume from one server to another.",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int", Required: true},
			{Flag: "-source", Label: "Source node", Kind: "string", Required: true},
			{Flag: "-target", Label: "Target node", Kind: "string", Required: true},
			{Flag: "-disk", Label: "Disk type", Kind: "string"},
		}},
	{Name: "volume.copy", Category: "volume", Risk: "mutate", Streams: true,
		Summary: "Copy a volume to another server (the source stays in place).",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int", Required: true},
			{Flag: "-source", Label: "Source node", Kind: "string", Required: true},
			{Flag: "-target", Label: "Target node", Kind: "string", Required: true},
		}},
	{Name: "volume.delete", Category: "volume", Risk: "destructive",
		Summary: "Delete a volume and its data from one node. Cannot be undone.",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int", Required: true},
			{Flag: "-node", Label: "Node", Kind: "string", Required: true},
		}},
	{Name: "volume.grow", Category: "volume", Risk: "mutate",
		Summary: "Pre-create empty volumes so writers don't block waiting for new slots.",
		Args: []shellArg{
			{Flag: "-collection", Label: "Collection", Kind: "string"},
			{Flag: "-replication", Label: "Replication", Kind: "string"},
			{Flag: "-count", Label: "Volume count", Kind: "int", Default: "1"},
			{Flag: "-dataCenter", Label: "Data center", Kind: "string"},
		}},
	{Name: "volume.shrink", Category: "volume", Risk: "mutate",
		Summary: "Shrink a volume's preallocated size after compaction.",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int", Required: true},
		}},
	{Name: "volume.check.disk", Category: "volume", Risk: "read", ReadOnly: true, Streams: true,
		Summary: "Verify replica consistency between volume servers for a given volume.",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int"},
			{Flag: "-slow", Label: "Slow (deep) check", Kind: "bool"},
		}},
	{Name: "volume.scrub", Category: "volume", Risk: "read", ReadOnly: true, Streams: true,
		Summary: "Background scrub: re-checksum each needle and flag any corruption.",
		Args: []shellArg{
			{Flag: "-collection", Label: "Collection", Kind: "string"},
		}},
	{Name: "volume.merge", Category: "volume", Risk: "mutate",
		Summary: "Merge two volumes into one (only safe when both are read-only).",
		Args: []shellArg{
			{Flag: "-fromVolumeId", Label: "From volume id", Kind: "int", Required: true},
			{Flag: "-toVolumeId", Label: "To volume id", Kind: "int", Required: true},
		}},
	{Name: "volumeServer.evacuate", Category: "volume", Risk: "mutate", Streams: true,
		Summary: "Drain every volume from a server so you can take it offline.",
		Args: []shellArg{
			{Flag: "-node", Label: "Node to drain", Kind: "string", Required: true},
			{Flag: "-skipNonMoveable", Label: "Skip non-moveable", Kind: "bool"},
			{Flag: "-force", Label: "Apply", Kind: "bool"},
		}},
	{Name: "volumeServer.leave", Category: "volume", Risk: "mutate",
		Summary: "Tell the master a volume server is intentionally leaving the cluster.",
		Args: []shellArg{
			{Flag: "-node", Label: "Node", Kind: "string", Required: true},
		}},
	{Name: "volumeServer.state", Category: "volume", Risk: "read", ReadOnly: true,
		Summary: "Inspect the runtime state of a single volume server."},

	// ---------------- Tiering (volume.tier.*) ----------------
	{Name: "volume.tier.upload", Category: "tier", Risk: "mutate", Streams: true,
		Summary: "Upload a read-only volume to a remote tier (S3/GCS/etc.) and leave a stub locally.",
		Args: []shellArg{
			{Flag: "-collection", Label: "Collection", Kind: "string"},
			{Flag: "-fullPercent", Label: "Full %", Kind: "string", Default: "95"},
			{Flag: "-quietFor", Label: "Quiet for", Kind: "string", Default: "1h"},
			{Flag: "-dest", Label: "Remote name", Kind: "string", Required: true},
		}},
	{Name: "volume.tier.download", Category: "tier", Risk: "mutate", Streams: true,
		Summary: "Pull a tiered volume back to local storage.",
		Args: []shellArg{
			{Flag: "-volumeId", Label: "Volume id", Kind: "int", Required: true},
			{Flag: "-collection", Label: "Collection", Kind: "string"},
		}},
	{Name: "volume.tier.move", Category: "tier", Risk: "mutate", Streams: true,
		Summary: "Migrate a tiered volume to a different remote tier.",
		Args: []shellArg{
			{Flag: "-fromDisk", Label: "From disk type", Kind: "string"},
			{Flag: "-toDisk", Label: "To disk type", Kind: "string"},
			{Flag: "-collection", Label: "Collection", Kind: "string"},
		}},
	{Name: "volume.tier.compact", Category: "tier", Risk: "mutate", Streams: true,
		Summary: "Compact a tiered volume in place on the remote backend."},

	// ---------------- EC ----------------
	{Name: "ec.encode", Category: "ec", Risk: "mutate", Streams: true,
		Summary: "Convert a normal volume into erasure-coded shards.",
		Args: []shellArg{
			{Flag: "-collection", Label: "Collection", Kind: "string"},
			{Flag: "-volumeId", Label: "Volume id", Kind: "int"},
			{Flag: "-fullPercent", Label: "Full %", Kind: "string", Default: "95"},
			{Flag: "-quietFor", Label: "Quiet for", Kind: "string", Default: "1h"},
		}},
	{Name: "ec.decode", Category: "ec", Risk: "mutate", Streams: true,
		Summary: "Reverse erasure coding back into a normal replicated volume."},
	{Name: "ec.rebuild", Category: "ec", Risk: "mutate", Streams: true,
		Summary: "Reconstruct missing EC shards from surviving ones.",
		Args: []shellArg{
			{Flag: "-collection", Label: "Collection", Kind: "string"},
			{Flag: "-force", Label: "Apply", Kind: "bool"},
		}},
	{Name: "ec.balance", Category: "ec", Risk: "mutate", Streams: true,
		Summary: "Move EC shards so each volume server carries a comparable load.",
		Args: []shellArg{
			{Flag: "-collection", Label: "Collection", Kind: "string"},
			{Flag: "-dataCenter", Label: "Data center", Kind: "string"},
			{Flag: "-force", Label: "Apply", Kind: "bool"},
		}},
	{Name: "ec.scrub", Category: "ec", Risk: "read", ReadOnly: true, Streams: true,
		Summary: "Verify EC shard checksums and report damage."},

	// ---------------- Collection ----------------
	{Name: "collection.list", Category: "collection", Risk: "read", ReadOnly: true,
		Summary: "List all collections and their volume counts."},
	{Name: "collection.delete", Category: "collection", Risk: "destructive",
		Summary: "Delete an entire collection — every volume in it is removed.",
		Args: []shellArg{
			{Flag: "-collection", Label: "Collection name", Kind: "string", Required: true},
		}},

	// ---------------- Filer FS ----------------
	{Name: "fs.ls", Category: "fs", Risk: "read", ReadOnly: true,
		Summary: "List filer directory entries.",
		Args: []shellArg{
			{Flag: "-l", Label: "Long format", Kind: "bool"},
			{Flag: "", Label: "Path", Kind: "string", Default: "/"},
		}},
	{Name: "fs.cat", Category: "fs", Risk: "read", ReadOnly: true,
		Summary: "Print the contents of a small filer file."},
	{Name: "fs.tree", Category: "fs", Risk: "read", ReadOnly: true,
		Summary: "Print the filer tree starting at a path."},
	{Name: "fs.du", Category: "fs", Risk: "read", ReadOnly: true,
		Summary: "Show disk usage rolled up under a filer path."},
	{Name: "fs.pwd", Category: "fs", Risk: "read", ReadOnly: true,
		Summary: "Print the shell's current filer working directory."},
	{Name: "fs.cd", Category: "fs", Risk: "read", ReadOnly: true,
		Summary: "Change the shell's current filer working directory."},
	{Name: "fs.mkdir", Category: "fs", Risk: "mutate",
		Summary: "Create a directory in the filer."},
	{Name: "fs.mv", Category: "fs", Risk: "mutate",
		Summary: "Move/rename a file or directory in the filer."},
	{Name: "fs.rm", Category: "fs", Risk: "destructive",
		Summary: "Remove a file or directory from the filer."},
	{Name: "fs.configure", Category: "fs", Risk: "mutate",
		Summary: "Update filer.toml settings (location → collection / replication / ttl)."},
	{Name: "fs.meta.cat", Category: "fs", Risk: "read", ReadOnly: true,
		Summary: "Dump the raw meta entry for a filer path."},
	{Name: "fs.meta.save", Category: "fs", Risk: "read", ReadOnly: true,
		Summary: "Snapshot filer meta to a local file."},
	{Name: "fs.meta.load", Category: "fs", Risk: "destructive",
		Summary: "Restore filer meta from a snapshot. Overwrites existing meta."},
	{Name: "fs.meta.notify", Category: "fs", Risk: "mutate",
		Summary: "Replay missed notifications to subscribers."},
	{Name: "fs.verify", Category: "fs", Risk: "read", ReadOnly: true, Streams: true,
		Summary: "Walk the filer tree and verify each file's chunks exist on volume servers."},
	{Name: "fs.log.purge", Category: "fs", Risk: "destructive",
		Summary: "Purge filer write-ahead logs older than a retention."},

	// ---------------- S3 — Bucket lifecycle ----------------
	{Name: "s3.bucket.list", Category: "s3-bucket", Risk: "read", ReadOnly: true,
		Summary: "List S3 buckets known to the cluster."},
	{Name: "s3.bucket.create", Category: "s3-bucket", Risk: "mutate",
		Summary: "Create a new S3 bucket.",
		Args: []shellArg{
			{Flag: "-name", Label: "Bucket name", Kind: "string", Required: true},
			{Flag: "-quotaMB", Label: "Quota (MB)", Kind: "int"},
		}},
	{Name: "s3.bucket.delete", Category: "s3-bucket", Risk: "destructive",
		Summary: "Delete an S3 bucket and all of its objects.",
		Args: []shellArg{
			{Flag: "-name", Label: "Bucket name", Kind: "string", Required: true},
		}},
	{Name: "s3.bucket.quota", Category: "s3-bucket", Risk: "mutate",
		Summary: "Read or set a bucket's quota.",
		Args: []shellArg{
			{Flag: "-name", Label: "Bucket name", Kind: "string", Required: true},
			{Flag: "-quotaMB", Label: "Quota (MB)", Kind: "int", Help: "0 disables the quota."},
		}},
	{Name: "s3.bucket.quota.enforce", Category: "s3-bucket", Risk: "mutate",
		Summary: "Toggle quota enforcement (returns 507 on writes when over)."},
	{Name: "s3.bucket.versioning", Category: "s3-bucket", Risk: "mutate",
		Summary: "Enable or suspend object versioning on a bucket.",
		Args: []shellArg{
			{Flag: "-name", Label: "Bucket name", Kind: "string", Required: true},
			{Flag: "-status", Label: "Status", Kind: "enum", Enum: []string{"Enabled", "Suspended"}, Required: true},
		}},
	{Name: "s3.bucket.lock", Category: "s3-bucket", Risk: "mutate",
		Summary: "Manage object-lock retention / legal hold on a bucket."},
	{Name: "s3.bucket.owner", Category: "s3-bucket", Risk: "mutate",
		Summary: "Change a bucket's owner."},
	{Name: "s3.bucket.access", Category: "s3-bucket", Risk: "mutate",
		Summary: "Manage bucket-level access policies."},
	{Name: "s3.clean.uploads", Category: "s3-bucket", Risk: "mutate",
		Summary: "Abort multipart uploads older than a cutoff and reclaim their parts.",
		Args: []shellArg{
			{Flag: "-timeAgo", Label: "Older than", Kind: "string", Default: "24h"},
		}},
	{Name: "s3.anonymous.get", Category: "s3-bucket", Risk: "read", ReadOnly: true,
		Summary: "Show the current anonymous-access policy on a bucket."},
	{Name: "s3.anonymous.set", Category: "s3-bucket", Risk: "mutate",
		Summary: "Update the anonymous-access policy on a bucket."},
	{Name: "s3.anonymous.list", Category: "s3-bucket", Risk: "read", ReadOnly: true,
		Summary: "List buckets that allow anonymous access."},

	// ---------------- S3 IAM ----------------
	{Name: "s3.user.list", Category: "s3-iam", Risk: "read", ReadOnly: true,
		Summary: "List S3 IAM users."},
	{Name: "s3.user.show", Category: "s3-iam", Risk: "read", ReadOnly: true,
		Summary: "Show one user's attached groups, policies, and keys."},
	{Name: "s3.user.create", Category: "s3-iam", Risk: "mutate",
		Summary: "Create a new S3 IAM user.",
		Args: []shellArg{
			{Flag: "-username", Label: "Username", Kind: "string", Required: true},
			{Flag: "-email", Label: "Email", Kind: "string"},
		}},
	{Name: "s3.user.delete", Category: "s3-iam", Risk: "destructive",
		Summary: "Delete an S3 IAM user.",
		Args: []shellArg{
			{Flag: "-username", Label: "Username", Kind: "string", Required: true},
		}},
	{Name: "s3.user.enable", Category: "s3-iam", Risk: "mutate",
		Summary: "Re-enable a previously disabled user."},
	{Name: "s3.user.disable", Category: "s3-iam", Risk: "mutate",
		Summary: "Disable a user without deleting it."},
	{Name: "s3.user.provision", Category: "s3-iam", Risk: "mutate",
		Summary: "Provision a user end-to-end: create + groups + keys + policy."},
	{Name: "s3.group.list", Category: "s3-iam", Risk: "read", ReadOnly: true,
		Summary: "List IAM groups."},
	{Name: "s3.group.show", Category: "s3-iam", Risk: "read", ReadOnly: true,
		Summary: "Show a group's members and attached policies."},
	{Name: "s3.group.create", Category: "s3-iam", Risk: "mutate",
		Summary: "Create an IAM group."},
	{Name: "s3.group.delete", Category: "s3-iam", Risk: "destructive",
		Summary: "Delete an IAM group."},
	{Name: "s3.accesskey.list", Category: "s3-iam", Risk: "read", ReadOnly: true,
		Summary: "List access keys for a user."},
	{Name: "s3.accesskey.create", Category: "s3-iam", Risk: "mutate",
		Summary: "Create a new access key pair for a user."},
	{Name: "s3.accesskey.rotate", Category: "s3-iam", Risk: "mutate",
		Summary: "Rotate a user's access key (creates a new one, you should disable the old)."},
	{Name: "s3.accesskey.delete", Category: "s3-iam", Risk: "destructive",
		Summary: "Permanently delete an access key."},
	{Name: "s3.serviceaccount.list", Category: "s3-iam", Risk: "read", ReadOnly: true,
		Summary: "List service accounts."},
	{Name: "s3.serviceaccount.show", Category: "s3-iam", Risk: "read", ReadOnly: true,
		Summary: "Show a service account's policies and keys."},
	{Name: "s3.serviceaccount.create", Category: "s3-iam", Risk: "mutate",
		Summary: "Create a service account."},
	{Name: "s3.serviceaccount.delete", Category: "s3-iam", Risk: "destructive",
		Summary: "Delete a service account."},
	{Name: "s3.policy", Category: "s3-iam", Risk: "mutate",
		Summary: "Create / update / delete an IAM policy."},
	{Name: "s3.policy.attach", Category: "s3-iam", Risk: "mutate",
		Summary: "Attach a policy to a user / group / service account."},
	{Name: "s3.policy.detach", Category: "s3-iam", Risk: "mutate",
		Summary: "Detach a policy from a user / group / service account."},
	{Name: "s3.iam.export", Category: "s3-iam", Risk: "read", ReadOnly: true,
		Summary: "Export the full IAM state (users, groups, policies) to JSON."},
	{Name: "s3.iam.import", Category: "s3-iam", Risk: "destructive",
		Summary: "Import IAM state from a JSON snapshot. Overwrites existing entries."},
	{Name: "s3.configure", Category: "s3-iam", Risk: "mutate",
		Summary: "Edit the S3 gateway's identities.json (users + creds + actions)."},
	{Name: "s3.config.show", Category: "s3-iam", Risk: "read", ReadOnly: true,
		Summary: "Print the S3 gateway's current configuration."},
	{Name: "s3.circuitbreaker", Category: "s3-iam", Risk: "mutate",
		Summary: "Configure per-bucket request circuit breakers."},

	// ---------------- S3 Tables (Iceberg) ----------------
	{Name: "s3tables.bucket", Category: "s3-tables", Risk: "mutate",
		Summary: "Manage S3 Tables buckets (create / list / delete)."},
	{Name: "s3tables.namespace", Category: "s3-tables", Risk: "mutate",
		Summary: "Manage S3 Tables namespaces."},
	{Name: "s3tables.table", Category: "s3-tables", Risk: "mutate",
		Summary: "Manage tables (Iceberg) under a namespace."},
	{Name: "s3tables.tag", Category: "s3-tables", Risk: "mutate",
		Summary: "Manage table tags."},

	// ---------------- Remote tier ----------------
	{Name: "remote.configure", Category: "remote", Risk: "mutate",
		Summary: "Configure a named remote backend (S3 / GCS / Azure / Aliyun / Tencent / Baidu)."},
	{Name: "remote.mount", Category: "remote", Risk: "mutate",
		Summary: "Mount a remote bucket/prefix into the filer."},
	{Name: "remote.unmount", Category: "remote", Risk: "mutate",
		Summary: "Unmount a remote mount point."},
	{Name: "remote.mount.buckets", Category: "remote", Risk: "mutate",
		Summary: "Auto-mount every bucket from a remote provider."},
	{Name: "remote.cache", Category: "remote", Risk: "mutate", Streams: true,
		Summary: "Cache a remote prefix locally for fast read access."},
	{Name: "remote.uncache", Category: "remote", Risk: "mutate",
		Summary: "Drop the local cache for a remote prefix."},
	{Name: "remote.meta.sync", Category: "remote", Risk: "mutate", Streams: true,
		Summary: "Sync remote bucket metadata (file list + sizes) into the filer."},
	{Name: "remote.copy.local", Category: "remote", Risk: "mutate", Streams: true,
		Summary: "Copy a remote prefix into the local filer permanently."},

	// ---------------- Cluster ----------------
	{Name: "cluster.check", Category: "cluster", Risk: "read", ReadOnly: true,
		Summary: "Sanity-check cluster connectivity and reachability of every component."},
	{Name: "cluster.ps", Category: "cluster", Risk: "read", ReadOnly: true,
		Summary: "List every process (master / volume / filer / mq / s3) the cluster knows about."},
	{Name: "cluster.status", Category: "cluster", Risk: "read", ReadOnly: true,
		Summary: "Show cluster-wide status: master quorum, volume / filer counts, EC ratio."},
	{Name: "cluster.raft.ps", Category: "cluster", Risk: "read", ReadOnly: true,
		Summary: "List master raft peers and their roles."},
	{Name: "cluster.raft.add", Category: "cluster", Risk: "mutate",
		Summary: "Add a master to the raft quorum.",
		Args: []shellArg{
			{Flag: "-address", Label: "Master address", Kind: "string", Required: true},
			{Flag: "-voter", Label: "Voter", Kind: "bool", Default: "true"},
		}},
	{Name: "cluster.raft.remove", Category: "cluster", Risk: "destructive",
		Summary: "Remove a master from the raft quorum. Quorum loss is permanent."},

	// ---------------- MQ ----------------
	{Name: "mq.topic.list", Category: "mq", Risk: "read", ReadOnly: true,
		Summary: "List message-queue topics."},
	{Name: "mq.topic.describe", Category: "mq", Risk: "read", ReadOnly: true,
		Summary: "Show partitions, brokers, and offsets for a topic."},
	{Name: "mq.topic.configure", Category: "mq", Risk: "mutate",
		Summary: "Create / update / delete a topic."},
	{Name: "mq.topic.compact", Category: "mq", Risk: "mutate", Streams: true,
		Summary: "Run log compaction on a topic so only the latest value per key is kept."},
	{Name: "mq.topic.truncate", Category: "mq", Risk: "destructive",
		Summary: "Drop all messages older than a cutoff."},
	{Name: "mq.balance", Category: "mq", Risk: "mutate", Streams: true,
		Summary: "Rebalance topic partitions across brokers."},

	// ---------------- Mount ----------------
	{Name: "mount.configure", Category: "mount", Risk: "mutate",
		Summary: "Persist FUSE mount options (uid/gid/mask/concurrent writers/...) for clients."},

	// ---------------- System ----------------
	{Name: "lock", Category: "system", Risk: "mutate",
		Summary: "Acquire the cluster-wide shell lock. Used implicitly by mutating commands."},
	{Name: "unlock", Category: "system", Risk: "mutate",
		Summary: "Release a stuck cluster-wide shell lock."},
}

// shellAllowedNames returns the set of names the operator can run via
// /api/v1/clusters/:id/shell. Backed by shellCatalog so adding a command
// to the catalog automatically allows it.
func shellAllowedNames() map[string]shellCommand {
	out := make(map[string]shellCommand, len(shellCatalog))
	for _, c := range shellCatalog {
		out[c.Name] = c
	}
	return out
}
