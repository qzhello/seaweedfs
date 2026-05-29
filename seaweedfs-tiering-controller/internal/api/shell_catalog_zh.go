package api

// Chinese translations for the shell catalog. Kept in a sibling file so
// the canonical English data in shell_catalog.go stays uncluttered and
// easy to diff against upstream additions. Untranslated entries fall
// back to English at render time — there is no requirement that every
// command be covered.

// argL10n carries per-flag label/help overrides for one command.
// Lookup is by Flag string (matches shellArg.Flag exactly).
type argL10n struct {
	Label string
	Help  string
}

// cmdL10n is one command's translation set. Summary and Args fields
// are independent — a partial translation (just Summary, just Args)
// is fine; missing pieces fall back to English.
type cmdL10n struct {
	Summary string
	Args    map[string]argL10n
}

// shellCatalogZh keys translations by shellCommand.Name. Adding a new
// command? Just translate it here when ready — no need for a struct
// change. UI keeps showing English until the entry lands.
var shellCatalogZh = map[string]cmdL10n{
	// ---------------- Volume ----------------
	"volume.list": {
		Summary: "列出集群中所有卷的大小、副本数和磁盘类型。",
		Args: map[string]argL10n{
			"-collection": {Label: "Collection 过滤", Help: "仅列出指定 collection 中的卷(支持正则)。"},
			"-readonly":   {Label: "仅只读", Help: "仅显示当前已标记为只读的卷。"},
		},
	},
	"volume.balance": {
		Summary: "在卷服务器之间迁移卷,使磁盘占用更均衡。",
		Args: map[string]argL10n{
			"-collection": {Label: "Collection", Help: "仅对指定 collection 做均衡(默认所有)。"},
			"-dataCenter": {Label: "数据中心"},
			"-racks":      {Label: "机架(逗号分隔)"},
			"-nodes":      {Label: "节点(逗号分隔)"},
			"-force":      {Label: "实际执行", Help: "不勾选时只输出 dry-run 结果。"},
		},
	},
	"volume.fix.replication": {
		Summary: "复制副本不足的卷到其它卷服务器,直至满足目标副本数。",
		Args: map[string]argL10n{
			"-collectionPattern": {Label: "Collection 匹配"},
			"-volumeIdPattern":   {Label: "卷 ID 匹配"},
			"-force":             {Label: "实际执行"},
			"-doDelete":          {Label: "删除多余副本", Help: "同时清理副本数超过目标的多余副本。"},
		},
	},
	"volume.fsck": {Summary: "对比卷服务器内容与 filer 元数据,找出孤立的 needle。"},
	"volume.vacuum": {
		Summary: "对已删除字节占比超过阈值的卷做压缩回收。",
		Args: map[string]argL10n{
			"-garbageThreshold": {Label: "垃圾占比阈值", Help: "[0,1] 之间的浮点数,越低回收越激进。"},
			"-volumeId":         {Label: "卷 ID"},
			"-collection":       {Label: "Collection"},
		},
	},
	"volume.vacuum.enable":  {Summary: "重新开启所有卷服务器的后台 vacuum。"},
	"volume.vacuum.disable": {Summary: "关闭后台 vacuum(例如计划维护窗口前)。"},
	"volume.configure.replication": {
		Summary: "修改某个卷的副本配置(例如 000 → 001)。",
		Args: map[string]argL10n{
			"-volumeId":    {Label: "卷 ID"},
			"-replication": {Label: "副本配置", Help: "三位数:dc-rack-node,例如 010。"},
		},
	},
	"volume.mark": {
		Summary: "切换卷为只读或可写。",
		Args: map[string]argL10n{
			"-volumeId": {Label: "卷 ID"},
			"-readonly": {Label: "只读"},
			"-writable": {Label: "可写"},
		},
	},
	"volume.mount": {
		Summary: "在卷服务器上重新挂载之前被卸载的卷。",
		Args: map[string]argL10n{
			"-volumeId": {Label: "卷 ID"},
			"-node":     {Label: "节点"},
		},
	},
	"volume.unmount": {
		Summary: "从卷服务器卸载一个卷(数据保留)。",
		Args: map[string]argL10n{
			"-volumeId": {Label: "卷 ID"},
			"-node":     {Label: "节点"},
		},
	},
	"volume.move": {
		Summary: "把一个卷从一台服务器迁移到另一台。",
		Args: map[string]argL10n{
			"-volumeId": {Label: "卷 ID"},
			"-source":   {Label: "源节点"},
			"-target":   {Label: "目标节点"},
			"-disk":     {Label: "磁盘类型"},
		},
	},
	"volume.copy": {
		Summary: "把一个卷复制到另一台服务器(源卷保留)。",
		Args: map[string]argL10n{
			"-volumeId": {Label: "卷 ID"},
			"-source":   {Label: "源节点"},
			"-target":   {Label: "目标节点"},
		},
	},
	"volume.delete": {
		Summary: "从一个节点删除指定卷及其数据。不可恢复。",
		Args: map[string]argL10n{
			"-volumeId": {Label: "卷 ID"},
			"-node":     {Label: "节点"},
		},
	},
	"volume.grow": {
		Summary: "预创建空卷,避免写入因新增槽位而阻塞。",
		Args: map[string]argL10n{
			"-collection":  {Label: "Collection"},
			"-replication": {Label: "副本配置"},
			"-count":       {Label: "卷数量"},
			"-dataCenter":  {Label: "数据中心"},
		},
	},
	"volume.shrink": {
		Summary: "压缩后回收卷的预分配空间。",
		Args: map[string]argL10n{
			"-volumeId": {Label: "卷 ID"},
		},
	},
	"volume.check.disk": {
		Summary: "校验指定卷在多个卷服务器之间的副本一致性。",
		Args: map[string]argL10n{
			"-volumeId": {Label: "卷 ID"},
			"-slow":     {Label: "深度(慢速)校验"},
		},
	},
	"volume.scrub": {
		Summary: "后台 scrub:重算每个 needle 的校验和并标记损坏。",
		Args: map[string]argL10n{
			"-collection": {Label: "Collection"},
		},
	},
	"volume.merge": {
		Summary: "把两个卷合并成一个(仅当两个卷都是只读时才安全)。",
		Args: map[string]argL10n{
			"-fromVolumeId": {Label: "源卷 ID"},
			"-toVolumeId":   {Label: "目标卷 ID"},
		},
	},
	"volumeServer.evacuate": {
		Summary: "把一台卷服务器上的所有卷迁走,以便下线。",
		Args: map[string]argL10n{
			"-node":            {Label: "待清空的节点"},
			"-skipNonMoveable": {Label: "跳过不可迁移的卷"},
			"-force":           {Label: "实际执行"},
		},
	},
	"volumeServer.leave": {
		Summary: "通知 master 某台卷服务器即将主动下线。",
		Args: map[string]argL10n{
			"-node": {Label: "节点"},
		},
	},
	"volumeServer.state": {Summary: "查看单台卷服务器的运行时状态。"},

	// ---------------- Tier ----------------
	"volume.tier.upload": {
		Summary: "把只读卷上传到远程分层存储(S3/GCS 等),本地仅保留 stub。",
		Args: map[string]argL10n{
			"-collection":  {Label: "Collection"},
			"-fullPercent": {Label: "占满阈值 %"},
			"-quietFor":    {Label: "静默时长"},
			"-dest":        {Label: "远端名称"},
		},
	},
	"volume.tier.download": {
		Summary: "把分层后的卷从远端拉回本地存储。",
		Args: map[string]argL10n{
			"-volumeId":   {Label: "卷 ID"},
			"-collection": {Label: "Collection"},
		},
	},
	"volume.tier.move": {
		Summary: "把分层卷迁移到不同的远端分层。",
		Args: map[string]argL10n{
			"-fromDisk":   {Label: "源磁盘类型"},
			"-toDisk":     {Label: "目标磁盘类型"},
			"-collection": {Label: "Collection"},
		},
	},
	"volume.tier.compact": {Summary: "在远端就地压缩分层卷。"},

	// ---------------- EC ----------------
	"ec.encode": {
		Summary: "把普通卷转成纠删码分片。",
		Args: map[string]argL10n{
			"-collection":  {Label: "Collection"},
			"-volumeId":    {Label: "卷 ID"},
			"-fullPercent": {Label: "占满阈值 %"},
			"-quietFor":    {Label: "静默时长"},
		},
	},
	"ec.decode": {Summary: "把纠删码卷还原为普通副本卷。"},
	"ec.rebuild": {
		Summary: "用幸存分片重建丢失的 EC 分片。",
		Args: map[string]argL10n{
			"-collection": {Label: "Collection"},
			"-force":      {Label: "实际执行"},
		},
	},
	"ec.balance": {
		Summary: "迁移 EC 分片,使每台卷服务器负载相近。",
		Args: map[string]argL10n{
			"-collection": {Label: "Collection"},
			"-dataCenter": {Label: "数据中心"},
			"-force":      {Label: "实际执行"},
		},
	},
	"ec.scrub": {Summary: "校验 EC 分片校验和并报告损坏。"},

	// ---------------- Collection ----------------
	"collection.list": {Summary: "列出所有 collection 及其卷数。"},
	"collection.delete": {
		Summary: "删除整个 collection — 其中所有卷都会被移除。",
		Args: map[string]argL10n{
			"-collection": {Label: "Collection 名称"},
			"-apply":      {Label: "实际删除"},
		},
	},

	// ---------------- Filer FS ----------------
	"fs.ls": {
		Summary: "列出 filer 中的目录项。",
		Args: map[string]argL10n{
			"-l": {Label: "长格式"},
			"":   {Label: "路径"},
		},
	},
	"fs.cat":         {Summary: "打印 filer 中某个小文件的内容。"},
	"fs.tree":        {Summary: "从指定路径开始打印 filer 目录树。"},
	"fs.du":          {Summary: "汇总 filer 指定路径下的磁盘占用。"},
	"fs.pwd":         {Summary: "打印当前 shell 在 filer 中的工作目录。"},
	"fs.cd":          {Summary: "切换 shell 在 filer 中的工作目录。"},
	"fs.mkdir":       {Summary: "在 filer 中创建一个目录。"},
	"fs.mv":          {Summary: "在 filer 中移动或重命名文件/目录。"},
	"fs.rm":          {Summary: "在 filer 中删除文件或目录。"},
	"fs.configure":   {Summary: "更新 filer.toml 配置(路径 → collection / 副本 / TTL)。"},
	"fs.meta.cat":    {Summary: "查看 filer 路径的原始元数据条目。"},
	"fs.meta.save":   {Summary: "把 filer 元数据快照保存到本地文件。"},
	"fs.meta.load":   {Summary: "从快照恢复 filer 元数据。会覆盖现有元数据。"},
	"fs.meta.notify": {Summary: "把错过的通知重放给订阅者。"},
	"fs.verify":      {Summary: "遍历 filer 目录树,校验每个文件的 chunk 是否还在卷服务器上。"},
	"fs.log.purge":   {Summary: "清理超过保留期的 filer 预写日志。"},

	// ---------------- S3 Bucket ----------------
	"s3.bucket.list": {Summary: "列出集群已知的所有 S3 bucket。"},
	"s3.bucket.create": {
		Summary: "创建一个新的 S3 bucket。",
		Args: map[string]argL10n{
			"-name":    {Label: "Bucket 名称"},
			"-quotaMB": {Label: "配额(MB)"},
		},
	},
	"s3.bucket.delete": {
		Summary: "删除一个 S3 bucket 及其所有对象。",
		Args: map[string]argL10n{
			"-name": {Label: "Bucket 名称"},
		},
	},
	"s3.bucket.quota": {
		Summary: "查看或设置 bucket 的配额。",
		Args: map[string]argL10n{
			"-name":    {Label: "Bucket 名称"},
			"-quotaMB": {Label: "配额(MB)", Help: "0 表示不限制。"},
		},
	},
	"s3.bucket.quota.enforce": {Summary: "切换配额强制执行(超额写入返回 507)。"},
	"s3.bucket.versioning": {
		Summary: "开启或暂停 bucket 的对象版本控制。",
		Args: map[string]argL10n{
			"-name":   {Label: "Bucket 名称"},
			"-status": {Label: "状态"},
		},
	},
	"s3.bucket.lock":   {Summary: "管理 bucket 的对象锁定保留期和合法保留。"},
	"s3.bucket.owner":  {Summary: "更改 bucket 的所有者。"},
	"s3.bucket.access": {Summary: "管理 bucket 级别的访问策略。"},
	"s3.clean.uploads": {
		Summary: "中断超期的分片上传,回收对应分块。",
		Args: map[string]argL10n{
			"-timeAgo": {Label: "超过多久"},
		},
	},
	"s3.anonymous.get":  {Summary: "查看 bucket 当前的匿名访问策略。"},
	"s3.anonymous.set":  {Summary: "更新 bucket 的匿名访问策略。"},
	"s3.anonymous.list": {Summary: "列出允许匿名访问的 bucket。"},

	// ---------------- S3 IAM ----------------
	"s3.user.list": {Summary: "列出 S3 IAM 用户。"},
	"s3.user.show": {Summary: "查看某个用户已挂载的组、策略和访问密钥。"},
	"s3.user.create": {
		Summary: "新建一个 S3 IAM 用户。",
		Args: map[string]argL10n{
			"-username": {Label: "用户名"},
			"-email":    {Label: "邮箱"},
		},
	},
	"s3.user.delete": {
		Summary: "删除一个 S3 IAM 用户。",
		Args: map[string]argL10n{
			"-username": {Label: "用户名"},
		},
	},
	"s3.user.enable":           {Summary: "重新启用之前被禁用的用户。"},
	"s3.user.disable":          {Summary: "禁用用户(不删除)。"},
	"s3.user.provision":        {Summary: "端到端开通用户:创建 + 加入组 + 创建密钥 + 挂载策略。"},
	"s3.group.list":            {Summary: "列出 IAM 组。"},
	"s3.group.show":            {Summary: "查看组的成员和已挂载的策略。"},
	"s3.group.create":          {Summary: "新建一个 IAM 组。"},
	"s3.group.delete":          {Summary: "删除一个 IAM 组。"},
	"s3.accesskey.list":        {Summary: "列出某个用户的访问密钥。"},
	"s3.accesskey.create":      {Summary: "为用户新建一对访问密钥。"},
	"s3.accesskey.rotate":      {Summary: "轮换用户的访问密钥(生成新密钥,旧的应禁用)。"},
	"s3.accesskey.delete":      {Summary: "永久删除一对访问密钥。"},
	"s3.serviceaccount.list":   {Summary: "列出服务账号。"},
	"s3.serviceaccount.show":   {Summary: "查看服务账号的策略和密钥。"},
	"s3.serviceaccount.create": {Summary: "创建一个服务账号。"},
	"s3.serviceaccount.delete": {Summary: "删除一个服务账号。"},
	"s3.policy":                {Summary: "新建 / 更新 / 删除 IAM 策略。"},
	"s3.policy.attach":         {Summary: "把策略挂载到用户 / 组 / 服务账号。"},
	"s3.policy.detach":         {Summary: "从用户 / 组 / 服务账号卸载策略。"},
	"s3.iam.export":            {Summary: "导出完整的 IAM 状态(用户、组、策略)到 JSON。"},
	"s3.iam.import":            {Summary: "从 JSON 快照导入 IAM 状态。会覆盖现有条目。"},
	"s3.configure":             {Summary: "编辑 S3 网关的 identities.json(用户 + 凭证 + 动作)。"},
	"s3.config.show":           {Summary: "打印 S3 网关当前的配置。"},
	"s3.circuitbreaker":        {Summary: "配置 bucket 级别的请求熔断器。"},

	// ---------------- S3 Tables ----------------
	"s3tables.bucket":    {Summary: "管理 S3 Tables 存储桶(创建 / 列出 / 删除)。"},
	"s3tables.namespace": {Summary: "管理 S3 Tables 命名空间。"},
	"s3tables.table":     {Summary: "管理命名空间下的表(Iceberg)。"},
	"s3tables.tag":       {Summary: "管理表标签。"},

	// ---------------- Remote ----------------
	"remote.configure":     {Summary: "配置一个命名的远端后端(S3 / GCS / Azure / 阿里云 / 腾讯云 / 百度云)。"},
	"remote.mount":         {Summary: "把远端 bucket/前缀挂载到 filer。"},
	"remote.unmount":       {Summary: "卸载一个远端挂载点。"},
	"remote.mount.buckets": {Summary: "自动挂载某个远端提供商的所有 bucket。"},
	"remote.cache":         {Summary: "把远端前缀缓存到本地以加速读取。"},
	"remote.uncache":       {Summary: "丢弃某个远端前缀的本地缓存。"},
	"remote.meta.sync":     {Summary: "把远端 bucket 的元数据(文件列表 + 大小)同步到 filer。"},
	"remote.copy.local":    {Summary: "把远端前缀永久复制到本地 filer。"},

	// ---------------- Cluster ----------------
	"cluster.check":   {Summary: "巡检集群连通性和各组件可达性。"},
	"cluster.ps":      {Summary: "列出集群已知的所有进程(master / volume / filer / mq / s3)。"},
	"cluster.status":  {Summary: "查看全集群状态:master quorum、卷/filer 数量、EC 比例。"},
	"cluster.raft.ps": {Summary: "列出 master raft 节点及其角色。"},
	"cluster.raft.add": {
		Summary: "把一个 master 加入 raft quorum。",
		Args: map[string]argL10n{
			"-address": {Label: "Master 地址"},
			"-voter":   {Label: "投票成员"},
		},
	},
	"cluster.raft.remove": {Summary: "从 raft quorum 移除一个 master。quorum 损失无法恢复。"},

	// ---------------- MQ ----------------
	"mq.topic.list":      {Summary: "列出消息队列 topic。"},
	"mq.topic.desc":      {Summary: "查看一个 topic 的分区、broker 和 offset。"},
	"mq.topic.configure": {Summary: "新建 / 更新 / 删除一个 topic。"},
	"mq.topic.compact":   {Summary: "对 topic 做日志压缩,每个 key 只保留最新值。"},
	"mq.topic.truncate":  {Summary: "删除某个截止时间之前的所有消息。"},
	"mq.balance":         {Summary: "在 broker 之间重新均衡 topic 的分区。"},

	// ---------------- Mount ----------------
	"mount.configure": {Summary: "持久化客户端 FUSE 挂载参数(uid/gid/mask/并发写等)。"},

	// ---------------- System ----------------
	"lock":   {Summary: "获取集群级 shell 锁。修改类命令会隐式调用。"},
	"unlock": {Summary: "释放卡住的集群级 shell 锁。"},
}

// localizedCatalog returns a copy of shellCatalog with Summary + arg
// Label/Help replaced by their Chinese translations when zh is true.
// Falls back to English for any command/flag not in shellCatalogZh.
//
// We copy rather than mutate so the canonical English data stays the
// source of truth for non-localized consumers (audit logs, AI prompts
// that need stable identifiers, etc.).
func localizedCatalog(zh bool) []shellCommand {
	if !zh {
		return shellCatalog
	}
	out := make([]shellCommand, len(shellCatalog))
	for i, c := range shellCatalog {
		tr, has := shellCatalogZh[c.Name]
		if !has {
			out[i] = c
			continue
		}
		// Copy the struct; translate Summary and Args fields. Slice of
		// args is rebuilt so we don't mutate the master.
		nc := c
		if tr.Summary != "" {
			nc.Summary = tr.Summary
		}
		if len(c.Args) > 0 {
			nargs := make([]shellArg, len(c.Args))
			for j, a := range c.Args {
				na := a
				if argTr, ok := tr.Args[a.Flag]; ok {
					if argTr.Label != "" {
						na.Label = argTr.Label
					}
					if argTr.Help != "" {
						na.Help = argTr.Help
					}
				}
				nargs[j] = na
			}
			nc.Args = nargs
		}
		out[i] = nc
	}
	return out
}
