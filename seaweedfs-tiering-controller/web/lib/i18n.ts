"use client";
// Client-side i18n. Source strings live in English in JSX (greppable, the
// default if no Chinese mapping exists). Chinese overrides are listed below
// keyed on the exact English source. Pages call `useT()` and wrap visible
// strings: `t("Save")`, `t("Run scoring")`, etc.
//
// Selected language persists in localStorage. The bottom-left sidebar toggle
// flips between zh and en globally — every component using useT() re-renders
// via a custom "tier:lang" event.
import { useEffect, useState, useCallback } from "react";

export type Lang = "zh" | "en";
const STORAGE_KEY = "tier.lang";

type Dict = Record<string, string>;

// Chinese translations, keyed by the English source string. Add new entries
// as you wrap more pages — anything missing falls through to the source.
const ZH: Dict = {
  // ---- Sidebar nav labels & groups ----------------------------------
  Dashboard:    "总览",
  Clusters:     "集群",
  Backends:     "存储后端",
  Volumes:      "卷",
  Cohort:       "同业横比",
  Policies:     "迁移策略",
  Skills:       "技能(SOP)",
  Tasks:        "任务",
  Executions:   "执行历史",
  Health:       "健康监控",
  Alerts:       "告警",
  Safety:       "安全防护",
  "NOC Wall":   "NOC 大屏",
  Holidays:     "节假日",
  "AI Config":  "AI 配置",
  "AI Learning":"AI 学习",
  Settings:     "系统配置",
  Permissions:  "权限管理",
  "Sign in":    "登录",
  "Sign out":   "登出",
  "Change password": "修改密码",
  "Tiering Console": "分层存储控制台",
  "Sign in to continue. On first boot the default credentials are": "请登录以继续。首次启动的默认凭证为",
  " — you will be asked to set a new password immediately.": " — 登录后会立即要求你设置新密码。",
  "email": "邮箱",
  "password": "密码",
  "Invalid credentials": "邮箱或密码错误",
  "Server error":  "服务器错误",
  "You must set a new password before continuing.": "在继续之前你必须设置新密码。",
  "Rotate the password for your account.": "为你的账号轮换密码。",
  "Current password":   "当前密码",
  "New password":       "新密码",
  "Confirm new password": "确认新密码",
  "At least 6 characters.": "至少 6 个字符。",
  "Save password":      "保存密码",
  "Password must be at least 6 characters": "密码至少 6 个字符",
  "New password does not match confirmation": "两次输入的新密码不一致",
  "Not signed in": "未登录",
  capabilities: "项权限",
  Audit:        "审计日志",
  "Volume Ops":              "卷运维",
  "Cluster Ops":             "集群运维",
  S3:                        "S3",
  Identities:                "身份",
  "Circuit breaker":         "限流防护",
  "Clean uploads":           "分片上传清理",
  // S3 tab group labels — operator-friendly grouping over the flat 5-tab strip.
  // "Resources" already defined elsewhere; reusing that translation.
  "Access control":          "访问控制",
  "Platform ops":            "平台运维",
  // Admin tab group labels — "Configure"/"AI"/"Review" + "Role"/"Status"/
  // "Active"/"Enabled"/"Disabled"/"Disable"/"Done"/"Display name" already
  // defined elsewhere in this file; we reuse those translations.
  "Configure":               "配置",
  // Platform users panel — distinct from S3 identities.
  "Platform users":          "平台用户",
  "People who can log in to the controller. Roles map to capabilities — see the Permissions tab.":
                             "可以登录控制台的用户。角色映射到能力(详见「权限」标签)。",
  "New user":                "新建用户",
  "No users yet.":           "暂无用户。",
  "Optional. Shown in audit log entries and identity pickers.":
                             "可选。会出现在审计日志和身份选择器里。",
  "Used to log in and as the canonical identifier across audit logs.":
                             "用作登录账号,以及审计日志里的规范标识。",
  "Email":                   "邮箱",
  "User":                    "用户",
  "Last login":              "最近登录",
  "Rotate API token":        "轮换 API 令牌",
  "Role updated":            "角色已更新",
  "Update failed":           "更新失败",
  "Rotate failed":           "轮换失败",
  "Rotate token for {n}?":   "为 {n} 轮换令牌?",
  "The current token will stop working immediately. Active sessions using it will be logged out. The new token is shown ONCE — you must save it somewhere safe before closing the dialog.":
                             "当前令牌会立刻失效,使用它的活跃会话将被踢出。新令牌只显示一次 —— 关闭对话框前必须妥善保存。",
  "Delete user {n}?":        "删除用户 {n}?",
  "This is permanent. The user's audit trail is preserved, but their row is removed. Disable instead if you may need to restore access.":
                             "此操作不可撤销。该用户的审计记录保留,但用户行被删除。如果未来可能恢复访问,请改用「禁用」。",
  "Create user":             "创建用户",
  "User created — copy credentials NOW": "用户已创建 —— 请立即复制凭据",
  "Token rotated — copy the new one NOW": "令牌已轮换 —— 请立即复制新令牌",
  "Password reset — copy the new one NOW": "密码已重置 —— 请立即复制新密码",
  "These credentials for {n} will only be shown once. The password is for the /login form; the API token is for SDK/CI clients.":
                             "{n} 的这些凭据只显示一次。密码用于 /login 登录页;API 令牌用于 SDK / CI 客户端。",
  "The old API token for {n} has been invalidated. Share this new token now — there is no second chance.":
                             "{n} 的旧 API 令牌已失效。请立即分享新令牌 —— 不会再有第二次机会。",
  "The old password for {n} stops working immediately. They will be forced to set a new one on first login. Share this temporary password through a secure channel.":
                             "{n} 的旧密码已立刻失效,下次登录会被强制改密。请通过安全渠道分享这个临时密码。",
  "Initial password (use at /login)": "初始密码(用于 /login 登录)",
  "API token (for SDK / CI)":        "API 令牌(给 SDK / CI 用)",
  "I have saved these credentials. I understand they cannot be recovered if lost.":
                             "我已保存这些凭据,理解一旦丢失无法恢复。",
  "Reset password":          "重置密码",
  "Reset failed":            "重置失败",
  "Reset password for {n}?": "为 {n} 重置密码?",
  "A fresh initial password will be generated. The user's existing password stops working immediately, and they will be forced to set a new one on first login. Their API token is NOT affected — rotate it separately if needed.":
                             "会生成一个新的初始密码。该用户的旧密码立即失效,下次登录强制改密。API 令牌不受影响 —— 如需轮换请单独操作。",
  // "Done": already translated elsewhere as "完成" — reuse.
  "A fresh API token will be generated and shown ONCE. Save it somewhere safe before closing the dialog — there is no read-back.":
                             "系统会生成一个新的 API 令牌,仅显示一次。请在关闭对话框前妥善保存 —— 之后无法找回。",
  "An initial password (for the /login form) and an API token (for SDK/CI clients) will be generated and shown ONCE. The user will be forced to change the password on first login.":
                             "会生成一个初始密码(用于 /login 登录页)和一个 API 令牌(给 SDK / CI 客户端),只显示一次。该用户下次登录时会被强制改密。",
  // Role descriptions for the role picker grid.
  "Full access — manage users, permissions, and every cluster operation.":
                             "完全权限 —— 管理用户、权限,以及所有集群操作。",
  "Day-to-day operations — buckets, volumes, S3, maintenance. No user management.":
                             "日常运维 —— 桶、卷、S3、维护。无用户管理权限。",
  "Read-only with audit-log access. Cannot mutate anything.":
                             "只读 + 查看审计日志,不能修改任何内容。",
  "Read-only dashboards. Cannot see audit logs.":
                             "只读看板,不能查看审计日志。",
  // Renamed tab labels (the old keys above stay for legacy callers).
  "Rate limiting":           "限流防护",
  "Stale upload cleanup":    "分片上传清理",
  // Buckets unified panel — segmented control between regular S3 and Tables.
  "General":                 "通用",
  "Tables":                  "表桶",
  "Standard S3 buckets":     "标准 S3 桶",
  "Iceberg / S3 Tables":     "Iceberg / S3 Tables",
  // Identity ↔ bucket cross-linking — "Reach" column on identities and
  // click-jump from bucket bindings back to the identity row.
  "Reach":                   "可达桶",
  "All buckets":             "全部桶",
  "{n} buckets":             "{n} 个桶",
  "Reachable buckets":       "可达桶",
  "Open identity":           "打开身份",
  "Open bucket":             "打开桶",
  "This identity has unscoped verbs ({v}) and can act on every bucket.":
                             "该身份有不限定桶名的权限({v}),可以操作所有桶。",
  "\"{n}\" already exists as a regular S3 bucket. Table buckets share the same global namespace, so this name will be rejected on submit. Pick a different name.":
                             "「{n}」已被一个普通 S3 桶占用。表桶与普通桶共享全局命名空间,此名字提交时会被拒绝。请换一个名字。",
  "S3 Identities":           "S3 身份管理",
  "Access keys and per-bucket permissions. Backed by weed shell s3.configure.": "访问密钥与桶级权限。底层通过 weed shell s3.configure。",
  "New identity":            "新增身份",
  "Edit identity":           "编辑身份",
  "Delete identity {n}?":    "删除身份 {n}?",
  "No identities yet. Click 'New identity' above to create one.": "暂无身份;点击上方「新增身份」创建。",
  "Could not parse identities; showing empty list.": "解析身份列表失败,显示为空。",
  "Access keys":             "访问密钥",
  "Access key":              "Access Key",
  "Secret key":              "Secret Key",
  "Optional. Leave blank if no key auth is needed.": "可选;不需要密钥认证留空即可。",
  "Only sent when set; previous secret stays untouched if left blank.": "仅在填写时下发;留空则保留现有密钥。",
  "Add bare verbs (Read/Write/List/Tagging/Admin) or scope to a bucket with Read:bucket-name.": "可填裸动词(Read/Write/List/Tagging/Admin),或加桶名限定如 Read:my-bucket。",
  "Name required":           "名称必填",
  "S3 Circuit Breaker":      "S3 熔断器",
  "Throttles S3 requests when a bucket or the whole gateway hits the configured limit.": "在桶或整个网关达到配置阈值时限流 S3 请求。",
  "List current":            "查看当前",
  "Show what is configured right now.": "展示当前生效的配置。",
  Enable:                    "启用",
  Disable:                   "停用",
  "Turn the circuit breaker on globally.": "全局启用熔断器。",
  "Turn it off. Use only when you know why.": "停用熔断器,请明确风险后操作。",
  "Set a threshold":         "设置阈值",
  Type:                      "类型",
  Value:                     "值",
  "Clean S3 multipart uploads": "清理 S3 multipart upload",
  "Abort multipart uploads older than the selected window. Frees the temporary parts.": "中止早于指定窗口的 multipart upload,释放临时分片。",
  "Abort all multipart uploads older than {t}?": "中止所有超过 {t} 的 multipart upload?",
  "Custom window (e.g. 24h, 7d)": "自定义窗口(如 24h、7d)",
  "Change owner":            "修改所有者",
  "Owner identity":          "所有者身份",
  "Identity name from /s3/configure.": "身份名称(从 /s3/configure 复制)。",
  "Check disk":              "磁盘检查",
  Replication:               "副本策略",
  "Drain server":            "节点下线",
  "Cluster disk check":      "集群磁盘检查",
  "On-disk integrity scan. Leave volume id blank to check the whole cluster.": "在线磁盘完整性扫描;volume id 留空则检查整个集群。",
  "Volume id (optional)":    "Volume ID(可选)",
  "Run check":               "运行检查",
  "This may take several minutes on a large cluster.": "大集群可能耗时数分钟。",
  Issues:                    "异常",
  OK:                        "正常",
  Detail:                    "详情",
  "Configure replication":   "配置副本策略",
  "Change replication for a whole collection or a single volume. Replication is a 3-digit code (dc rack node).": "为整个 collection 或单个卷修改副本策略;3 位数字编码(dc 机架 节点)。",
  "(all)":                   "(全部)",
  "Volume id (optional, narrows to one volume)": "Volume ID(可选,只改一个卷)",
  "Collections in this cluster": "集群下的 Collection",
  "Sample server":           "样本服务器",
  "Drain a volume server": "下线 Volume Server",
  "Run volumeServer.leave so the master migrates volumes off the node before you take it offline.": "执行 volumeServer.leave,master 会先把该节点上的卷迁走,然后你才可以下线该节点。",
  "Node (host:port)":        "节点 (host:port)",
  "Force (don't wait for replicas to catch up)": "强制(不等副本追平)",
  "Start drain":             "开始下线",
  "Drain {node}? Volumes will migrate to other servers.": "下线 {node}?卷会迁移到其他节点。",
  "Click a node to drain it": "点击节点开始下线",
  Bytes:                     "字节",
  Balance:                   "平衡",
  Grow:                      "增加卷",
  "Delete empty":            "删除空卷",
  "Volume Balance": "卷平衡 (Balance)",
  "Volume Grow":             "增加卷",
  "Delete empty volumes":    "删除空卷",
  "Compute a dry-run plan, inspect the migrations, then apply with one click.": "先试算迁移方案,查看明细,再一键执行。",
  "Pre-allocate new volumes for a collection. The master picks placement.": "为某个 collection 预分配卷;具体放在哪个节点由 master 决定。",
  "Volumes with Size = 0. Each row deletes one replica on its server.": "Size=0 的卷副本;每一行只删除该 server 上的一个副本。",
  "Compute plan":            "试算方案",
  "Apply plan":              "执行",
  "Apply the balance plan? This moves data across nodes.": "执行平衡方案?这会跨节点移动数据。",
  "Migration flow":          "迁移流向",
  "Nothing to balance.":     "无需平衡。",
  "Per-node volume count (before vs after)": "节点卷数(前 vs 后)",
  "Per-node volume count (current)": "节点卷数(当前)",
  Moves:                     "迁移",
  "Click a row to highlight in the flow chart.": "点击行可在流向图中高亮。",
  From:                      "源",
  To:                        "目标",
  "Size (MB)":               "大小 (MB)",
  "Raw shell output":        "原始 shell 输出",
  "Apply output":            "执行输出",
  "Pick a cluster in the top-right to start.": "请先在右上角选择集群。",
  "Replication (e.g. 001)":  "副本策略 (如 001)",
  "empty volume replicas":   "个空卷副本",
  selected:                  "已选",
  "Delete selected": "删除已选",
  "Delete {n} empty volume replicas?": "删除选中的 {n} 个空卷副本?",
  "No empty volumes — nothing to do.": "没有空卷 — 无需操作。",
  "Assign capabilities to roles. Admin always retains the '*' wildcard.": "把功能分配给角色;admin 角色永远保留 '*' 通配符。",
  "You don't have permission to view this page.": "你没有权限访问此页面。",
  "Save changes per role": "按角色逐列保存",
  "Saved":      "已保存",
  Capability:   "功能",
  Overview:     "概览",
  Resources:    "资源",
  Policy:       "策略",
  Execution:    "执行",
  Operations:   "运维",
  "Ops Console": "运维命令",
  "Ops Commands": "运维命令",
  "Run any weed shell command against a cluster with guided forms and audit.":
                "用引导式表单对集群执行任意 weed shell 命令,操作全程审计。",
  "Search commands…":             "搜索命令…",
  "No commands match your search.": "没有匹配的命令。",
  "Select cluster…":              "选择集群…",
  "probing…":                     "探测中…",
  unreachable:                    "不可达",
  "Pick a command on the left to see its arguments and run it.":
                                  "在左侧选一个命令,即可查看参数并运行。",
  "Pick a cluster first.":        "请先选择集群。",
  Arguments:                      "参数",
  "Raw extra args (advanced)":    "额外原始参数(高级)",
  Reason:                         "原因",
  "Why are you running this? (logged in audit)":
                                  "执行原因(将记入审计日志)",
  Run:                            "运行",
  Output:                         "输出",
  read:                           "只读",
  mutate:                         "可变更",
  destructive:                    "破坏性",
  Volume:                         "卷",
  Tiering:                        "分层",
  "Erasure Coding":               "纠删码",
  "Filer FS":                     "Filer 文件系统",
  "S3 Bucket":                    "S3 桶",
  "S3 IAM":                       "S3 IAM",
  "S3 Tables":                    "S3 Tables",
  "Remote Tier":                  "远程后端",
  "Message Queue":                "消息队列",
  Mount:                          "挂载",
  "Show flag reference":          "查看参数说明",
  "Hide flag reference":          "收起参数说明",
  "No help text returned.":       "未返回帮助文本。",
  // Ops templates
  "Ops Templates":                "运维模板",
  Templates:                      "模板",
  "Save and reuse multi-step weed shell playbooks. AI can draft one from a description.":
                                  "保存并复用多步骤的 weed shell 运维剧本。可用 AI 自动起草。",
  "Single-command console":       "单条命令",
  "Generate with AI":             "用 AI 生成",
  "New template":                 "新建模板",
  "Run against:":                 "执行目标:",
  "No templates yet. Create one or ask the AI to draft a sample.":
                                  "暂无模板。新建一个,或让 AI 生成一个示例。",
  "Delete this template?":        "确认删除这个模板?",
  "Edit template":                "编辑模板",
  "What does this playbook do and when should an operator run it?":
                                  "这个剧本做什么?在什么场景下使用?",
  "Add step":                     "添加步骤",
  "— pick a command —":           "— 选择命令 —",
  "Continue on error":            "出错后继续",
  "Reason (recorded in audit)":   "原因(记入审计)",
  "No steps yet.":                "暂未添加步骤。",
  "Name required.":               "请填写名称。",
  "Add at least one step.":       "至少添加一个步骤。",
  "Step {n}: pick a command.":    "第 {n} 步:请选择命令。",
  "Draft a template with AI":     "AI 起草模板",
  "Describe what you want the playbook to do, in your own words. The AI will pick commands from the catalog and propose a draft you can review and edit before saving.":
                                  "用自然语言描述你想要的剧本流程。AI 会从命令目录中挑选合适的命令生成草稿,你可以审核并调整后再保存。",
  "e.g. Create an S3 bucket called acme-logs for tenant Acme, give it a 50GB quota, enable versioning, then create a service account scoped to it.":
                                  "例:为租户 Acme 创建一个名为 acme-logs 的 S3 桶,配额 50GB,开启版本控制,然后为它创建一个受限的服务账号。",
  "Create an S3 bucket called acme-logs for tenant Acme, give it a 50GB quota, enable versioning, then create a service account scoped to it.":
                                  "为租户 Acme 创建一个名为 acme-logs 的 S3 桶,配额 50GB,开启版本控制,然后为它创建一个受限的服务账号。",
  "Identify the volume server with the most volumes, move one volume from it to the server with the fewest volumes, then rebalance the cluster.":
                                  "找出卷数最多的卷服务器,从中挑一个卷迁移到卷数最少的服务器,然后对整个集群做一次均衡。",
  "Encode all volumes in collection 'cold-logs' to EC, then balance shards across racks.":
                                  "把集合 cold-logs 里所有卷编码成 EC,然后把分片在各机架之间做均衡。",
  "Try:":                         "试试:",
  "Interactive (AI + step approval)": "交互式(AI 推断 + 步骤审批)",
  "Pause on confirm_before steps; AI infers variable values from prior outputs.":
                                  "在标记了 confirm_before 的步骤暂停;AI 会从上一步输出中推断变量值。",
  "Stop this run immediately. Already-finished steps are not undone.":
                                  "立刻终止本次执行。已完成的步骤不会回滚。",
  "Cancel run":                   "终止执行",
  "Dismiss":                      "关闭",
  "Awaiting your approval":       "等待你确认",
  "Confirm before running":       "执行前确认",
  "Will execute":                 "即将执行",
  "AI proposed these values. Review and edit before approving.":
                                  "AI 推断了下面的值,审核后可直接修改。",
  "Suggested by AI":              "AI 建议",
  "Approve & continue":           "批准并继续",
  "Require approval":             "需要审批",
  "Pause the interactive runner before this step. The operator sees the rendered command and must approve.":
                                  "执行此步骤前暂停,显示已渲染的命令,需要操作员确认。",
  "AI infers variables from prior steps": "由 AI 从上一步推断变量",
  "variable name":                "变量名",
  "Step number to analyze (0 = any prior step)": "要分析的步骤编号(0 表示前面所有步骤)",
  "Hint, e.g. 'the server with the most volumes'":
                                  "提示词,例如:卷数最多的服务器",
  "Add inference":                "新增推断项",
  "AI analysis":                  "AI 分析",
  "Flow":                         "流程",
  "drag nodes to reposition · drag from a node's right edge to another's left to link · sibling roots run in parallel":
                                  "拖动节点调整位置,从节点右侧拖到另一个节点左侧建立依赖,无依赖的节点并行执行",
  "Click a node above to edit its command, args, AI inference, captures, and approval rule.":
                                  "点击上方任一节点,在此处编辑其命令、参数、AI 推断、抓取规则与审批策略。",
  "No steps yet. Click 'Add step' to create one.": "暂无步骤,点击\"添加步骤\"创建。",
  "Selected step":                "当前步骤",
  "Delete step":                  "删除步骤",
  "Click a node to see its output, errors, and approve any pending action.":
                                  "点击节点查看输出、错误,审批暂停中的步骤。",
  "Awaiting approval:":           "待审批:",
  "Run history":                  "运行历史",
  "No recorded runs yet for this template.": "该模板还没有运行记录。",
  "Show output":                  "查看输出",
  "(legacy)":                     "(早期记录)",
  "Total steps":                  "总步骤数",
  "Enable alerts":                "启用告警",
  "Add analyzer":                 "添加分析脚本",
  "Insert a Python analyzer step that post-processes a prior step's stdout.":
                                  "插入一个 Python 分析步骤,用于处理上一步的 stdout 输出。",
  "Fire on":                      "触发时机",
  "Severity override":            "严重级别覆盖",
  "Analyzer step":                "分析步骤",
  "Input from step":              "输入来自步骤",
  "(empty = use last completed dependency)": "(留空 = 使用最近完成的依赖步骤)",
  "How to use the result":        "如何使用结果",
  "Downstream steps can reference the JSON via": "下游步骤可通过以下方式引用 JSON:",
  "Top-level object keys are exposed individually, e.g.":
                                  "顶层对象的键会被单独暴露,例如:",
  "Add a Capture below to pull regex matches out of the JSON the same way as shell output.":
                                  "可在下方添加抓取规则,通过正则从 JSON 中提取数据,用法与 shell 输出相同。",
  "Channel disabled":             "通道已禁用",
  "Run start":                    "运行开始",
  "Awaiting approval":            "等待审批",
  "Send alerts when this flow runs":  "运行此流程时发送告警",
  "No channels configured. Visit": "尚未配置通道。前往",
  "to add a WeCom / DingTalk / Feishu / webhook destination first.":
                                  "添加企业微信 / 钉钉 / 飞书 / Webhook 目标。",
  "(default — auto-formatted)":   "(默认 —— 自动格式化)",
  "(per-event default)":          "(按事件默认)",
  Success:                        "成功",
  Failure:                        "失败",
  "Close (Esc)":                  "关闭 (Esc)",
  "Analyzer Scripts":             "分析脚本",
  "No analyzer scripts are available. Visit": "暂无可用的分析脚本。前往",
  "to author one — or run the seed migration to load the system library.":
                                  "编写一个 —— 或运行 seed 迁移加载系统库。",
  Script:                         "脚本",
  "— pick a script —":            "— 选择脚本 —",
  auto:                           "自动",
  Params:                         "参数",
  "Search…":                      "搜索…",
  "Search navigation":            "搜索导航",
  "Clear search":                 "清除搜索",
  Results:                        "结果",
  "No matches":                   "无匹配",
  "Nothing matched. Try a shorter keyword.": "未找到匹配项,请尝试更短的关键词。",
  Favorites:                      "常用",
  "Shards (high → low)":          "分片数(多 → 少)",
  "Shards (low → high)":          "分片数(少 → 多)",
  "Node name":                    "节点名",
  "No nodes match the current filter.": "没有节点符合当前筛选。",
  Average:                        "平均",
  nodes:                          "个节点",
  avg:                            "平均",
  "Pin to favorites":             "添加到常用",
  "Unpin from favorites":         "从常用移除",
  "Switch to light theme":        "切换到浅色主题",
  "Switch to dark theme":         "切换到深色主题",
  "AI risk advisor":              "AI 风险提示",
  "Ask AI":                       "请 AI 审核",
  "Re-check":                     "重新审核",
  "Asking AI for risk advice…":   "正在请 AI 审核风险…",
  "AI advice is off for this template. Click \"Ask AI\" to request a one-time check.":
                                  "该模板未开启 AI 审核。可点击\"请 AI 审核\"单独发起一次检查。",
  "Risk: ":                       "风险:",
  "Watch out: ":                  "注意:",
  "Rollback: ":                   "回滚:",
  "AI had no specific advice to offer.": "AI 暂无具体建议。",
  "AI advisor unavailable":       "AI 审核服务不可用",
  "AI advisor unavailable: {err}": "AI 审核服务不可用:{err}",
  "Auto-ask AI for risk/rollback advice before mutating steps":
                                  "在执行修改类命令前,自动请 AI 给出风险/注意/回滚建议",
  "Interactive mode: variable values are collected at each step's approval card, not upfront. Optional defaults still apply.":
                                  "交互模式下变量值在每个步骤的审批卡中分别填入,不在最上面一次性收集。已声明的默认值仍会生效。",
  "Variables for this step":      "本步骤需要的变量",
  "review AI proposal before approving": "批准前请核对 AI 建议",
  "AI returned no usable draft.": "AI 未返回可用的草稿。",
  "Show raw AI response":         "查看 AI 原始响应",
  Draft:                          "起草",
  "Run again":                    "再次执行",
  "Not started yet.":             "尚未开始。",
  pending:                        "待运行",
  running:                        "运行中",
  done:                           "完成",
  error:                          "错误",
  // Volume row actions
  Actions:                          "操作",
  Move:                             "迁移",
  "Copy to node":                   "复制到节点",
  "Delete on this node":            "删除此节点上的副本",
  "Mark read-only":                 "标记为只读",
  "Mark writable":                  "标记为可写",
  "Vacuum (compact)":               "压缩 (Vacuum)",
  "Tier upload":                    "上传到分层后端",
  "Tier download":                  "从分层后端下载",
  "Target node":                    "目标节点",
  "Destination volume server. Must be a different node.":
                                    "目标卷服务器,必须与源节点不同。",
  "Destination volume server. The source stays in place.":
                                    "目标卷服务器(源副本保留)。",
  "Disk type (optional)":           "磁盘类型(可选)",
  "Garbage threshold":              "垃圾阈值",
  "Float 0..1. Lower = more aggressive.":
                                    "0 到 1 之间的小数,值越小越激进。",
  "Remote backend name":            "远程后端名称",
  "Name configured under /backends, e.g. s3-cold-tier.":
                                    "在 /backends 中配置的名称,例:s3-cold-tier。",
  "Collection (optional)":          "Collection(可选)",
  "volume(s) selected":             "个卷已选中",
  "volume(s)":                      "个卷",
  "Clear selection":                "清空选择",
  "This action is destructive and cannot be undone.":
                                    "此操作不可逆,请谨慎!",
  "{n} volume(s) will be skipped (action does not apply).":
                                    "{n} 个卷将被跳过(动作不适用)。",
  "Affected volumes":               "受影响的卷",
  skip:                             "跳过",
  "Skipped (no-op).":               "已跳过(无须操作)。",
  "No cluster id on row.":          "该行缺少集群标识。",
  "Run on {n} volume(s)":           "在 {n} 个卷上执行",
  // Top-level nav (rename / regroup)
  Storage:                          "存储",
  Insights:                         "分析",
  Automation:                       "自动化",
  Activity:                         "动态",
  Monitoring:                       "监控",
  Buckets:                          "S3 桶",
  // "Collections" translation moved to its dedicated block further
  // down (Collections page section). Removed the English placeholder
  // here because duplicate keys in object literals cause Turbopack's
  // dev SSR cache to lock onto the first value and trigger
  // server/client hydration mismatch.
  // Buckets page
  "S3 buckets via weed shell s3.bucket.list. Row actions call s3.bucket.* commands.":
                                    "通过 weed shell s3.bucket.list 获取,行操作调用 s3.bucket.* 命令。",
  "New bucket":                     "新建桶",
  "Search name / owner…":           "搜索名称 / 拥有者…",
  "Search name…":                   "搜索名称…",
  "No buckets found":               "未发现桶",
  "No buckets match the filter":    "没有桶匹配过滤条件",
  "Click New bucket above to create one.": "点击上方「新建桶」创建一个。",
  "Select a cluster to see its buckets.":  "请选择一个集群以查看其桶。",
  Quota:                            "配额",
  Owner:                            "拥有者",
  "Set quota":                      "设置配额",
  "Quota (MB)":                     "配额 (MB)",
  "Set 0 to remove the quota.":     "填 0 表示移除配额。",
  "Enforce quota":                  "开启配额限制",
  "Stop enforcing quota":           "关闭配额限制",
  "Enable versioning":              "开启版本控制",
  "Suspend versioning":             "暂停版本控制",
  "Clean stale uploads":            "清理过期上传",
  "Older than":                     "超过此时长",
  "e.g. 24h, 7d.":                  "例:24h, 7d。",
  "Delete bucket":                  "删除桶",
  "Bucket name":                    "桶名",
  "DNS-compatible name.":           "需符合 DNS 命名规则。",
  "Quota (MB) — optional":          "配额 (MB) — 可选",
  "Create bucket":                  "创建桶",
  // Collections page
  "No collections found":           "未发现 Collection",
  "No collections match the filter": "没有 Collection 匹配过滤条件",
  "Collections are created implicitly when files are stored with a -collection tag.":
                                    "Collection 在写入文件时自动按 -collection 标签创建。",
  "Select a cluster to see its collections.": "请选择一个集群以查看其 Collection。",
  "Delete collection":              "删除 Collection",
  "Balance volumes (plan / apply)…": "均衡卷（预演 / 执行）…",
  "Apply": "执行",
  "Simulate (dry-run)": "预演（dry-run）",
  "Dry-run mode — nothing is changed. Tick \"Apply\" below to actually run this destructive command.":
    "预演模式 — 不做任何更改。勾选下方“执行”才会真正运行该破坏性命令。",
  "Apply (actually run — default is a safe dry-run)": "执行（真正运行 — 默认是安全的预演）",
  "Leave unchecked to preview what the command would do. The shell prints a simulation and changes nothing.":
    "不勾选时仅预览命令会做什么：shell 只打印模拟结果，不改动任何数据。",
  "Apply (actually delete this collection)": "执行（真正删除该 Collection）",
  "Unchecked = simulation: the shell only prints what would be deleted. Checked appends -apply and permanently removes every volume in the collection.":
    "不勾选 = 模拟：shell 只打印将被删除的内容。勾选后追加 -apply，永久删除该 Collection 下的所有卷。",
  Deleted:                          "已删除",
  // Topology node actions
  "Drain (evacuate)":               "排空节点 (evacuate)",
  "Apply (skip dry-run)":           "立即执行 (跳过 dry-run)",
  "Set to false to see what would move without doing it.":
                                    "填 false 仅显示将要迁移的卷,不实际执行。",
  "Skip non-moveable":              "跳过不可迁移的卷",
  "True to ignore volumes that can't move (e.g. EC shards).":
                                    "true 表示忽略 EC 分片等不可迁移卷。",
  "Mark as leaving":                "标记为下线中",
  "Balance volumes here":           "在该节点上平衡卷",
  "Inspect runtime state":          "查看运行时状态",
  "(no output)":                    "(无输出)",
  "Done — command finished with no output.": "执行成功 — 命令未输出内容。",
  "id:1  collection:logs  server:10.0.0.5  rack:r1": "id:1  collection:logs  server:10.0.0.5  rack:r1",
  "Use key:value for exact match (id, collection, server, rack). Bare words match any field.": "使用 key:value 精确匹配(id、collection、server、rack);裸词为全字段模糊匹配。",
  "Click a row to filter the table on the right.": "点击行可在右侧列表筛选;复制按钮可复制名称。",
  Chunks:                           "块数",
  // Global cluster switcher
  "aggregate views only":           "仅聚合视图",
  "No enabled clusters.":           "没有启用的集群。",
  "Pick a cluster in the topbar to run a template.":
                                    "在顶栏选择集群以运行模板。",
  "No cluster selected in the topbar. You'll be asked to pick one when running a template.":
                                    "顶栏未选择集群。运行模板时会要求你先选一个。",
  "AI-inferred variables collected per step below":
                                    "AI 会推断的变量在下面每步的审批卡里收集",
  "Running… stdout will stream here as the command emits lines. Short commands may only print at completion.":
                                    "执行中…命令产生输出时会在这里实时显示。短命令可能要等执行完才有输出。",
  "Target cluster":                  "目标集群",
  "— pick a cluster —":              "— 请选择集群 —",
  "Confirm the cluster before running — commands execute on whichever you pick.":
                                    "运行前请确认集群 — 命令会在你选中的那个集群上执行。",
  Hide:                             "隐藏",
  "Hidden:":                        "已隐藏:",
  "No data.":                       "暂无数据。",
  // Ops templates — variables + captures
  Variables:                        "变量",
  "Add variable":                   "添加变量",
  "Display label":                  "显示名称",
  "Default (optional)":             "默认值(可选)",
  Required:                         "必填",
  "Declare named inputs the operator fills in at run time, then reference them in step args as ":
                                    "声明运行时由操作员填写的输入,然后在步骤参数里通过下面这种方式引用:",
  "Insert:":                        "插入:",
  "Capture from output":            "从输出中捕获",
  alias:                            "别名",
  "Add capture":                    "添加捕获",
  "Variable key is required.":      "变量 key 不能为空。",
  "Variable key must be a snake_case identifier: {key}":
                                    "变量 key 需要是 snake_case 标识符:{key}",
  "Missing required input(s): {keys}": "缺少必填输入:{keys}",
  Resolved:                         "渲染后的命令",
  // Volumes: charts drawer
  Charts:                           "图表",
  "Show charts":                    "显示图表",
  "Hide charts":                    "隐藏图表",
  "All charts are hidden. Click a chip above to bring one back.":
                                    "所有图表都已隐藏,点击上方任意 chip 恢复。",
  "Collapse sidebar":               "收起侧边栏",
  "Expand sidebar":                 "展开侧边栏",
  AI:           "AI",
  System:       "系统",

  // ---- Common buttons / verbs --------------------------------------
  Save:                  "保存",
  Cancel:                "取消",
  Edit:                  "编辑",
  Delete:                "删除",
  Remove:                "移除",
  Discard:               "丢弃",
  Reset:                 "重置",
  Refresh:               "刷新",
  Loading:               "加载中…",
  "Loading…":            "加载中…",
  Running:               "运行中",
  "Running…":            "运行中…",
  Details:               "详情",
  History:               "历史",
  "Version history":     "版本历史",
  Back:                  "返回",
  Previous:              "上一步",
  Next:                  "下一步",
  Open:                  "打开",
  Close:                 "关闭",
  Expand:                "展开",
  Collapse:              "收起",
  yes:                   "是",
  no:                    "否",
  All:                   "All",
  Error:                 "错误",
  "Test connection":     "测试连接",
  "Set as default":      "设为默认",
  "Add provider":        "添加 Provider",
  "Edit provider":       "编辑 Provider",
  "New provider":        "新建 Provider",
  "Run review":          "运行评审",
  "Re-review":           "重新评审",
  "Run diagnosis":       "运行诊断",
  "Re-diagnose":         "重新诊断",
  Wizard:                "向导",
  JSON:                  "JSON",
  Paste:                 "粘贴",

  // ---- Empty / loading states --------------------------------------
  "No data yet":               "暂无数据",
  "No annotations yet":        "暂无标注数据",
  "No annotations yet.":       "暂无标注数据。",
  "No matching ops.":          "没有匹配的算子。",
  "No tasks in this state":    "该状态下没有任务",
  "No clusters yet":           "还没有集群",
  "No backends configured":    "尚未配置存储后端",
  "No monitor targets":        "尚未配置监控目标",
  "No migration policies":     "尚未配置迁移策略",
  "No executions yet":         "尚未有执行记录",
  "No config history":         "尚无配置历史",
  "No volumes found":          "未找到卷",
  "No active alerts":          "暂无活跃告警",
  "No AI providers configured":"尚未配置 AI Provider",
  "No alert events yet":       "暂无告警事件",
  "No channels configured":    "尚未配置告警通道",
  "No alert rules yet":        "尚未配置告警规则",
  "No cohort baselines yet":   "尚未生成 Cohort 基线",
  "No audit events in this range": "时间范围内没有审计事件",
  "No events match the current filter":"没有符合当前筛选的事件",
  "Audit log viewer is not wired yet": "审计日志浏览器尚未完成",
  "No execution record yet":   "尚无执行记录",
  "No volumes returned. Check that at least one enabled cluster master is reachable.":
                               "未返回任何卷数据。请检查至少一个 enabled 集群的 master 是否可达。",
  "No volumes match the current filter":"没有符合当前筛选的卷",
  "No volumes match the current filter.":"没有符合当前筛选的卷。",
  "Clear filters above or broaden the search.":
                               "清除上方筛选或扩大搜索范围。",
  "No volumes found. Check that at least one cluster is enabled and its master is reachable.":
                               "未找到卷。请检查至少一个 enabled 集群的 master 是否可达。",
  // ---- Skills / SOP wizard -----------------------------------------
  "New Skill":              "新建 Skill",
  "New SOP":                "新建 SOP",
  "Fork to custom":         "克隆为自定义",
  Fork:                     "克隆",
  "Skip to raw JSON":       "跳到原始 JSON",
  "Declarative op catalog — every Skill is a playbook with preconditions, steps, postchecks, and rollback.":
    "声明式操作目录:每个 Skill 都是带前置/步骤/后置/回滚的运维剧本。",
  "Build a Skill the controller can run as a versioned, schema-validated procedure.":
    "构建一个可由控制器执行的、带版本和 schema 校验的 Skill。",
  "Forking a system skill into a custom one. Tweak the steps, then save under a new key.":
    "将系统 Skill 克隆为自定义版本。修改步骤后,以新 key 保存。",
  "This is a system skill":  "这是系统 Skill",
  "What is this Skill?":     "这是什么 Skill?",
  "What does the caller pass in?": "调用方需要传入哪些参数?",
  "What does the Skill do?": "Skill 实际做什么?",
  "What protects the cluster?":"哪些保护机制?",
  "Review & save":           "确认并保存",
  Identity:                  "身份",
  Inputs:                    "参数",
  Execute:                   "执行",
  Review:                    "复核",
  "Give the Skill a stable identifier, a one-line purpose, and the right category and risk so it gets the right review path.":
    "给 Skill 一个稳定的标识、一句话目的,以及合适的分类和风险等级,让它走对审核路径。",
  "Parameters are validated before any side effect runs. Most volume-level skills only need cluster_id and volume_id.":
    "参数在任何副作用前都会被校验。卷级 Skill 通常只需要 cluster_id 和 volume_id。",
  "Each step calls a registered op. Order matters. The engine acquires locks, writes a log line, retries on transient failures, and rolls back on configured failures.":
    "每一步调用一个已注册算子。顺序很重要。引擎会加锁、写日志、瞬时失败时重试、按配置回滚。",
  "Preconditions abort before side effects. Rollback runs after a failed destructive step. Postchecks confirm the change actually stuck.":
    "前置检查在副作用之前中断。回滚在破坏性步骤失败后运行。后置检查确认变更真的生效。",
  "Cross-check the structured preview against the JSON. Add a change note and save — every save creates a new immutable version.":
    "对照结构化预览和 JSON 复核。填写变更说明并保存 — 每次保存都会创建一个不可变的新版本。",
  "Saving creates a new version. The latest version is what runs.":
    "保存会创建新版本。最新版本就是运行的版本。",
  "Save new version":    "保存新版本",
  "Create skill":        "创建 Skill",
  "Parameters":          "参数",
  Preconditions:         "前置检查",
  Steps:                 "执行步骤",
  Rollback:              "回滚步骤",
  Postchecks:            "后置检查",
  "Raw JSON":            "原始 JSON",
  "Live preview":        "实时预览",
  "Definition (JSON)":   "定义 (JSON)",
  "schema ok":           "schema 通过",
  invalid:               "无效",
  "checking…":           "校验中…",
  checking:              "校验中",
  "Step {n} of {total}": "第 {n} 步,共 {total} 步",
  "Risk level":          "风险等级",
  Category:              "分类",
  "Display name":        "显示名称",
  Summary:               "概要",
  Description:           "描述",
  "Change note":         "变更说明",
  "audit trail":         "审计追溯",
  "lowercase.dotted":    "小写点分",
  "what operators see":  "操作员看到的名称",
  "ONE sentence — appears in audit logs and tooltips": "一句话 — 出现在审计日志和提示中",
  "optional · 2–4 sentences · plain markdown": "可选 · 2-4 句 · 纯 markdown",
  "Skip to raw JSON →":  "跳到原始 JSON →",

  // ---- Dashboard ---------------------------------------------------
  "Check":                    "检查",
  "Capacity":                 "容量",
  "Run scoring":              "运行评分",
  "Scan selected cluster":    "深度检查",
  "Storage Tiering Overview": "存储分层总览",
  Volumes_label:              "卷",
  "Total Size":               "总容量",
  Pending:                    "待审",
  "hot recs":                 "热推荐",
  "Saving est.":              "节省估算",
  "vs. 3-replica baseline":   "对比 3 副本基线",
  "Top recommendations":      "Top 推荐",
  "Tier Distribution":        "层级分布",
  "Volume count":             "卷数",
  "Storage size":             "存储大小",
  "Slot usage":               "槽位使用率",
  Count:                      "数量",
  Size:                       "总量",
  Usage:                      "使用率",
  Node:                       "节点",
  Rack:                       "机架",
  N:                          "节",
  R:                          "架",
  "All clusters":             "所有集群",
  "Pick a cluster to scope scoring; defaults to all": "选择评分范围的集群,默认全部",
  Review_button:              "查看",
  "EMERGENCY STOP":           "紧急停止",
  "Gate CLOSED":              "Gate 关闭",
  "all-clear":                "全部正常",
  "Access Trend (with holiday windows)": "访问趋势(含节假日窗口)",
  "By business domain":       "按业务域",
  "Scoring complete.":        "评分完成。",
  "Hot (SSD/NVMe)":           "热 (SSD/NVMe)",
  "Warm (HDD/EC)":            "温 (HDD/EC)",
  "Cold (Cloud)":             "冷 (云端)",
  "clusters_lc":              "集群",
  "volumes_lc":               "卷",
  "nodes_lc":                 "节点",
  "racks_lc":                 "机架",
  "slots":                    "槽位",
  "by_node":                  "按节点",
  "by_rack":                  "按机架",
  "No data returned.":        "暂无数据。",
  "No pending recommendations.": "暂无待审推荐。",
  "Freeze:":                  "冻结:",
  "Pressure max":             "压力峰值",
  "busy":                     "繁忙",
  "Pressure threshold":       "压力阈值",
  "buckets":                  "区间",
  "Expand group":             "展开分组",
  "Collapse group":           "折叠分组",
  "AI provider:":             "AI 提供方:",
  "Free headroom":            "可用空间",
  "free":                     "空闲",
  "of fleet": "占总数",
  "Cluster pressure":         "集群压力",
  "threshold":                "阈值",
  // ---- AI Assistant ------------------------------------------------
  "AI Assistant":             "AI 小助手",
  "AI Assistant — drag to move": "AI 小助手 — 拖动可调整位置",
  "Chats":                    "会话",
  "New chat":                 "新建会话",
  "Delete chat":              "删除会话",
  "No chats yet.":            "暂无会话。",
  "Untitled":                 "未命名",
  "Scoped to cluster":        "当前集群",
  "No cluster scope":         "未选择集群",
  "Send (Enter)":             "发送 (Enter)",
  "Ask again":                "重新问",
  "Ask this question again":  "重新问这个问题",
  "SOP proposal":             "SOP 提议",
  "Pending approval":         "待审批",
  "Executing":                "执行中",
  "Approve & run":            "审批并执行",
  "Open in Tasks":            "在任务页打开",
  "Approved — running. Watch Executions for progress.":
    "已审批,正在执行 —— 可在执行历史查看进度。",
  "Drag to move":             "拖动移动",
  "Drag to resize":           "拖动调整大小",
  "Maximize":                 "最大化",
  "Restore size":             "还原大小",
  "Ask anything about this page or the selected cluster…": "针对当前页面或所选集群提问…",
  "Thinking…":                "思考中…",
  "Hi! I'm scoped to your active cluster and the SOPs for the current page.": "你好!我会结合当前集群和本页面相关 SOP 给出指导。",
  "Pick or create a chat on the left to get started. History caps at 50 messages per thread.": "在左侧选择或新建一个会话开始对话。每个会话最多保留 50 条历史消息。",
  // ---- Score report (deep check toast) -----------------------------
  "Error:":                       "错误:",
  "Clusters:":                    "集群:",
  "online":                       "在线",
  "Volumes scanned:":             "扫描卷数:",
  "Cold-score:":                  "冷度评分:",
  "all noop (too hot / too small / cooling window unmet)":
                                  "全部 noop (过热 / 过小 / 冷却窗口未到)",
  "recs":                         "条推荐",
  "noop":                         "无动作",
  "Replication:":                 "副本:",
  "under-replicated":             "副本不足",
  "vol":                          "卷",
  "all replicas present":         "全部副本就绪",
  "Inserted":                     "已插入",
  "new task(s) — see /tasks":     "条新任务 — 见 /tasks",
  "task insert(s) failed (see errors below)":
                                  "条任务插入失败 (见下方错误)",
  "No new tasks":                 "无新任务",
  "deduped on idempotency key":   "通过幂等键去重",
  "Errors:":                      "错误:",
  "Per cluster:":                 "各集群:",
  "vols":                         "卷",
  "new":                          "新增",
  "dup":                          "去重",
  "failed":                       "失败",
  "Reset layout":                 "重置布局",
  // ---- Volume balance ----------------------------------------------
  "Current volume count by node": "当前各节点卷数",
  "Current storage size by node": "当前各节点存储大小",
  "Per-node storage size (before vs after)": "各节点存储大小 (前 vs 后)",
  "Before":                       "之前",
  "After":                        "之后",
  "Computing…":                   "试算中…",
  "(any)":                        "(任意)",
  "Cluster is already balanced — no moves needed.": "集群已均衡 — 无需迁移。",
  "Plan ready:":                  "方案就绪:",
  "moves across":                 "次迁移,跨",

  // ---- Volumes -----------------------------------------------------
  "id / collection / server / rack": "id / collection / server / rack",
  "All collections": "所有 Collection",
  "Any disk":        "任意磁盘",
  Writable:          "可写",
  "Read-only":       "只读",
  Distribution:      "分布",
  Collection:        "Collection",
  Server:            "节点",
  Disk:              "磁盘",
  Files:             "文件数",
  "R/O":             "只读",
  Modified:          "修改时间",
  "7-day Read Heatmap":   "7 天读热力图",
  Composition:            "构成",
  "No access events recorded yet — start the collector.":
                          "尚无访问事件 — 请先启动 collector。",
  "Volume distribution by {mode}": "按{mode}的卷分布",

  // ---- Tasks -------------------------------------------------------
  Vol:                "卷",
  Action:             "动作",
  Score:              "得分",
  Status:             "状态",
  Created:            "创建于",
  Why:                "原因",
  "View progress":    "查看进度",
  "View execution":   "查看执行",
  "Multi-round AI review": "多轮 AI 审查",
  "No AI review yet. Click \"Run review\" to start the 3-round check.":
    "尚未运行 AI 审查。点击\"运行评审\"启动 3 轮检查。",
  "Initial scan":     "初步扫描",
  "Deep analysis":    "深度分析",
  "Devil's advocate":"反向质询",
  "Raw response":     "原始响应",
  "Auto-approved by autonomy pipeline": "自治流水线自动放行",

  // ---- Executions --------------------------------------------------
  "AI decision archive":    "AI 决策档案",
  "AI postmortem":          "AI 失败诊断",
  "AI execution plan":      "AI 执行计划",
  "Pipeline timeline":      "流程时间线",
  "Step waterfall":         "步骤瀑布图",
  "Total time":             "总耗时",
  "Started at":             "开始时间",
  "Finished at":            "结束时间",
  "Rollback kind":          "回滚类型",
  "Auto-proceed":           "自动放行",
  "Needs human":            "需人工",
  "Blocked (high risk)":    "强制人工(高风险)",
  "Skill risk":             "Skill 风险",
  "Blast radius":           "影响范围",
  "Change window":          "时间窗口",
  "AI consensus":           "AI 共识",
  "Root cause":             "根因",
  "Suggested action":       "建议处置",
  "Idempotent retry":       "幂等可重试",
  "Transient — retry recommended":  "暂时性故障 · 建议重试",
  "Adjust args and retry":          "需调参后重试",
  "No longer needed — abort":       "已不需要 · 终止",
  "Needs human judgement":          "需人工判断",
  "Roll back":              "回滚",
  rebutted:                 "已反驳",
  kept:                     "保留",
  "AI-concern rebuttals":   "AI 顾虑反驳清单",
  "auto-refresh every 1.5s": "每 1.5s 自动刷新",

  // ---- AI Config ---------------------------------------------------
  "AI Providers": "AI Provider",
  "Works with OpenAI, Anthropic Claude, DeepSeek, Ollama, and any OpenAI-compatible gateway. API keys are encrypted at rest in PostgreSQL with AES-GCM.":
    "支持 OpenAI / Anthropic Claude / DeepSeek / Ollama / 任意 OpenAI 兼容网关。API Key 通过 AES-GCM 加密存储于 PostgreSQL。",
  Active:                 "当前生效",
  encrypted:              "已加密",
  "no credentials":       "无凭据",
  "Not configured":       "未配置",
  "not tested":           "未测试",
  Vendor:                 "厂商",
  Name:                   "名称",
  Enabled:                "启用",

  // ---- AI Learning -------------------------------------------------
  "AI counterfactual learning": "AI 反事实学习",
  "Total verdicts": "总判决数",
  Correct:          "正确数",
  Accuracy:         "准确率",
  "Observation window": "观测窗口",
  "By provider":    "按 Provider",
  "Recent annotations": "最近标注",
  Provider:         "Provider",
  Verdict:          "判决",
  Samples:          "样本",
  "Avg conf":       "平均置信度",
  Domain:           "业务域",

  // ---- Cohort ------------------------------------------------------
  "Cohort overview": "Cohort 总览",
  "Top 3 outliers":  "Top 3 离群卷",

  // ---- Holidays / Safety -------------------------------------------
  "During the pre/post windows of each holiday the executor **auto-pauses** all migration tasks to avoid IO jitter at peak.":
    "在节前/节后窗口内,执行器会**自动暂停**所有迁移任务,防止业务高峰期 IO 抖动。",
  "Resources permanently blocked from migration (finance / compliance / live drills). Match: exact or *prefix/suffix wildcard.":
    "永远禁止迁移的资源(财务/合规/正在做迁移演练)。匹配方式:精确 或 * 通配前后缀。",

  // ---- Login -------------------------------------------------------
  "Paste your API token. Tokens are issued by an admin in the users table.":
    "粘贴你的 API token。Token 由管理员在 users 表生成。",
  "First-boot seed is dev-admin-token-change-me — change it ASAP.":
    "首次启动种子值为 dev-admin-token-change-me(请尽快修改)。",

  // ---- Audit -------------------------------------------------------
  "Audit log":           "审计日志",
  When:                  "时间",
  Actor:                 "操作者",
  Target:                "目标",
  Payload:               "Payload",
  "All actors":          "所有操作者",
  "All actions":         "所有动作",
  "All kinds":           "所有类型",
  "refreshes every 15s": "每 15s 刷新",

  // ---- Policies ----------------------------------------------------
  Showing:                    "显示",
  of:                         "共",
  "Per page":                 "每页",
  "First page":               "首页",
  "Previous page":            "上一页",
  "Next page":                "下一页",
  "Last page":                "末页",
  "Search by name, key, or description…": "按名称、键名或描述搜索…",
  "All categories":           "所有类别",
  "Any risk":                 "任意风险",
  "Enabled only":             "仅已启用",
  "Reset filters":            "重置筛选",
  // ---- Clusters ----------------------------------------------------
  "SeaweedFS clusters managed by this controller.": "本控制器管理的 SeaweedFS 集群。",
  "New cluster":              "新建集群",
  "Edit cluster":             "编辑集群",
  "Create cluster":           "创建集群",
  "Register a SeaweedFS master so the controller can talk to it.":
                              "登记一个 SeaweedFS master，让控制器能够连接它。",
  "Register a SeaweedFS master to start tiering.":
                              "登记一个 SeaweedFS master 开始做分层。",
  registered:                 "已注册",
  Master:                     "Master 地址",
  "Master address":           "Master 地址",
  "host:9333 of the SeaweedFS master.":
                              "SeaweedFS master 的 host:9333。",
  "Filer address":            "Filer 地址",
  "Optional. host:8888 of the SeaweedFS filer.":
                              "可选。SeaweedFS filer 的 host:8888。",
  "Primary business domain":  "主业务域",
  "Used by cohort baselines and routing.":
                              "用于 cohort 基线与路由。",
  "Free-form note shown in the cluster list.":
                              "在集群列表中显示的自由备注。",
  "Short identifier, e.g. prod-flight-bj.":
                              "简短标识符，例如 prod-flight-bj。",
  "weed binary":              "weed 二进制",
  "weed binary path (optional)": "weed 二进制路径（可选）",
  "Absolute path used for `weed shell` calls against this cluster. Leave empty to fall back to $WEED_BIN / $PATH.":
                              "针对该集群执行 `weed shell` 时使用的绝对路径。留空则回退到 $WEED_BIN / $PATH。",
  "Use gRPC TLS":             "启用 gRPC TLS",
  Disabled:                   "已禁用",
  "global fallback":          "全局回退",
  "Delete cluster {name}?":   "确认删除集群 {name}？",
  "Name and master address are required.":
                              "名称和 Master 地址为必填。",

  // ---- Storage backends ---------------------------------------------
  "Storage backends":         "存储后端",
  "S3-compatible destinations the controller can upload cold-tier data to.":
                              "控制器可上传冷数据的 S3 兼容目标。",
  "New backend":              "新建后端",
  "Edit backend":             "编辑后端",
  "Create backend":           "创建后端",
  "Connect an S3-compatible bucket where cold volumes can be offloaded.":
                              "连接一个 S3 兼容的存储桶，用作冷卷的卸载目标。",
  "Wire an S3/GCS bucket so cold-tier moves have a destination.":
                              "连接一个 S3/GCS 存储桶，让冷分层有去处。",
  Kind:                       "类型",
  "Backend protocol or vendor.": "后端协议或厂商。",
  Endpoint:                   "Endpoint",
  "Host of the S3 endpoint, without scheme.": "S3 Endpoint 的主机名，不含协议。",
  Region:                     "Region",
  "AWS region or vendor equivalent.": "AWS Region 或厂商等价值。",
  "Target S3 bucket name.":   "目标 S3 存储桶名称。",
  "Path prefix":              "路径前缀",
  "Optional path prefix inside the bucket.": "存储桶内的可选路径前缀。",
  Encryption:                 "加密",
  "Server-side encryption mode.": "服务端加密模式。",
  "Access Key ID":            "Access Key ID",
  "Stored encrypted, never echoed back.":
                              "加密存储，不会回显。",
  "Secret Access Key":        "Secret Access Key",
  "Secret (leave empty to keep existing)":
                              "Secret（留空则保留现值）",
  "Stored encrypted; never displayed again.":
                              "加密存储，不会再次显示。",
  "Already encrypted on disk. Type a new value to rotate.":
                              "已加密落盘。填新值即可轮换。",
  Notes:                      "备注",
  "Free-form note shown in the backend list.":
                              "在后端列表中显示的自由备注。",
  "Force path style (MinIO)": "强制 path-style（MinIO）",
  "Short identifier referenced from policies.":
                              "策略中引用的简短标识符。",
  Secret:                     "Secret",
  "Last test":                "上次测试",
  Test:                       "测试",
  stored:                     "已保存",
  none:                       "未设置",
  ok:                         "正常",
  "just now":                 "刚刚",
  "Access keys are encrypted with": "Access Key 加密算法",
  "the master key comes from": "主密钥来自",
  "(32 bytes hex). The console never shows plaintext keys.":
                              "（32 字节十六进制）。控制台不会显示明文密钥。",
  "Delete backend {name}?":   "确认删除存储后端 {name}？",
  "No skills match the current filter.": "没有符合当前筛选的 Skill。",
  Custom:                     "自定义",
  Clear:                      "清空",
  "New policy":               "新建策略",
  "Edit policy":              "编辑策略",
  "Create policy":            "创建策略",
  "Save changes":             "保存修改",
  "Saving…":                  "保存中…",
  "New / update policy":      "新建 / 更新策略",
  "A policy answers: which volumes, by what rule, get moved to which tier.":
    "策略回答三件事：哪些卷、按什么规则、迁到哪一层。",
  "A short identifier, e.g. archive-cold-logs.":
    "一个简短标识，例如 archive-cold-logs。",
  "Pattern matched against the scope kind. Use * to match everything.":
    "按作用域类型进行匹配的模式。使用 * 表示匹配全部。",
  "0–1 fraction of matching volumes to enqueue per run (1 = all).":
    "每轮入队的匹配卷比例（0–1，1 表示全部）。",
  "Plan only, no real moves.":
    "仅生成计划，不执行真实迁移。",
  "Inactive policies are skipped by the scorer.":
    "未启用的策略会被打分器跳过。",
  "Strategy parameters":     "策略参数",
  "Edit raw JSON":           "编辑原始 JSON",
  "Edit JSON":               "切换 JSON",
  "Form view":               "切换表单",
  "Edit values directly. Switch back to Form view for guided fields.":
    "直接编辑取值。切回表单视图可获得字段引导。",
  "Params must be a JSON object.": "参数必须是 JSON 对象。",
  "Give the policy a name to save.": "请先填写策略名称再保存。",
  "Scope kind":               "作用域类型",
  "Scope value":              "作用域取值",
  "Sample rate":              "采样率",
  "Dry run":                  "演练模式",
  "Params (JSON)":            "参数 (JSON)",
  "Save policy":              "保存策略",
  Scope:                      "作用域",
  Sample:                     "采样",
  "Dry-run":                  "演练",
  "Policies decide which volumes get warm-ed or cold-ed.":
                              "策略决定哪些卷会被 warm 化或 cold 化。",
  hot_replicate:              "热数据多副本",
  warm_ec:                    "温数据 EC",
  cold_cloud:                 "冷数据上云",
  archive:                    "归档",
  global:                     "全局",
  collection:                 "集合",
  bucket:                     "桶",
  regex:                      "正则",

  // ---- Misc --------------------------------------------------------
  "Filter by this actor":  "按此操作者筛选",
  "Filter by this action": "按此动作筛选",
  "Filter by this kind":   "按此类型筛选",
  events:                  "条事件",
  steps:                   "步骤",

  // ---- Settings page -----------------------------------------------
  "All runtime config lives here.":     "所有运行时配置集中在此管理。",
  "hot reload":                          "热加载",
  "restart required":                    "需重启",
  hot:                                   "热加载",
  restart:                               "重启",
  sensitive:                             "敏感",
  CRITICAL:                              "关键",
  "Configuration groups":                "配置分组",
  "Contains critical setting":           "包含关键配置项",
  entries:                               "项",
  "Search keys / description":           "搜索键名 / 描述",
  "No matching configuration":           "没有匹配的配置项",
  "Adjust the search or pick another group.": "调整搜索或选择其他分组。",
  "edited by":                           "编辑者",
  Show:                                  "查看",
  Restore:                               "回滚",
  "old:":                                "旧值:",
  "new:":                                "新值:",
  "Edits to system_config appear here with version + actor.": "对 system_config 的修改将带版本号与操作人显示于此。",
  true:                                  "是",
  false:                                 "否",

  // ---- Settings: group display names (keys come from server) -------
  scoring:                               "评分",
  scheduler:                             "调度器",
  executor:                              "执行器",
  ai:                                    "AI",
  ai_review:                             "AI 评审",
  aireview:                              "AI 评审",
  safety:                                "安全",
  cluster:                               "集群",

  // ---- Settings: impact / description strings shipped from migrations
  "New scoring runs only":                          "仅影响后续新评分任务",
  "Affects new scoring decisions":                  "影响后续评分决策",
  "Affects new AI calls":                           "影响后续 AI 调用",
  "Affects in-flight AI calls":                     "影响进行中的 AI 调用",
  "Restart required":                               "需重启生效",
  "Requires controller restart":                    "需重启 controller",
  "Requires controller restart to re-register":     "需重启 controller 以重新注册",
  "Newly created tasks only":                       "仅影响新建任务",
  "Lowering may pause running tasks":               "调低可能暂停运行中的任务",
  "Pauses or resumes all auto-scoring/execution":   "暂停或恢复所有自动评分/执行",
  "Stagger to avoid network spikes":                "错峰以避免网络峰值",
  "Tasks queue outside window":                     "窗口外任务进入队列等待",
  "Token bucket caps egress":                       "令牌桶限制出口带宽",
  "When ON, executor is bypassed":                  "开启时执行器被旁路(不真正执行)",

  // ---- EC (erasure coding) -----------------------------------------
  EC:                                    "EC",
  Normal:                                "普通",
  "EC only":                             "仅 EC",
  "Normal only":                         "仅普通",

  // ---- EC overview page --------------------------------------------
  "EC overview":                         "EC 概览",
  "RS(10+4): 10 data + 4 parity shards. Up to 4 shards can be lost before a volume becomes unrecoverable.":
                                         "RS(10+4):10 数据分片 + 4 校验分片,最多容忍 4 分片丢失。",
  "EC volumes": "EC 卷",
  "shards total":                        "分片总数",
  Healthy:                               "健康",
  Degraded:                              "降级",
  unrecoverable:                         "不可恢复",
  UNRECOVERABLE:                         "不可恢复",
  "RP violations":                       "RP 违规",
  "same shard on multiple nodes":        "同一分片落在多个节点",
  "No EC volumes in the current scope.": "当前范围内没有 EC 卷。",
  "Run ec.encode in weed shell or wait for the auto-EC worker to encode cold volumes.":
                                         "在 weed shell 里执行 ec.encode,或等待自动 EC worker 编码冷卷。",
  "Shard × node heatmap":                "分片 × 节点 热图",
  "1 shard (normal)":                    "1 分片(正常)",
  ">1 shard (RP violation)":             ">1 分片(RP 违规)",
  "0 shards":                            "0 分片",
  "Shards per node":                     "每节点分片数",
  "Shards per rack (by DC)":             "每机架分片数(按 DC)",
  "Per-volume shard distribution":       "每卷分片分布",
  Shard:                                 "分片",
  Shards:                                "分片",
  missing:                               "缺失",

  // ---- EC dry-run modal --------------------------------------------
  "Probe missing shards":                "检测缺失分片",
  "Preview balance plan":                "预览均衡方案",
  "Pick a single cluster to run a dry-run.": "请先选择单一集群再执行 dry-run。",
  "ec.rebuild dry-run":                  "ec.rebuild 试算",
  "ec.balance dry-run":                  "ec.balance 试算",
  "Scans every EC volume for missing shards. No data is written.":
                                         "扫描所有 EC 卷查找缺失分片,不写入任何数据。",
  "Computes the move plan to balance shards across DCs / racks / nodes. No data is written.":
                                         "计算跨 DC / rack / 节点的分片均衡方案,不写入任何数据。",
  "Click Run to execute. The cluster lock is acquired briefly; no data is written.":
                                         "点击运行执行。期间会短暂占用集群 lock,不写入任何数据。",
  "Re-run":                              "重新运行",
  "Raw output":                          "原始输出",
  "unrecoverable volume(s)":             "个不可恢复的卷",
  rebuildable:                           "可重建",
  "volume(s) need rebuild — pass -apply in weed shell to fix.":
                                         "个卷需要重建 — 到 weed shell 加 -apply 执行。",
  "All EC volumes are healthy.":         "所有 EC 卷健康。",
  "shard move(s) planned — pass -apply in weed shell to rebalance.":
                                         "条分片迁移已规划 — 到 weed shell 加 -apply 执行。",
  "Shards already balanced — no moves needed.": "分片已均衡 — 无需迁移。",

  // ---- EC encode / decode dialogs ----------------------------------
  "Encode collection…":                  "整 Collection 转 EC…",
  "Encode to EC":                        "转为 EC",
  "Encode to EC (RS 10+4)":              "转为 EC (RS 10+4)",
  "Decode EC → normal volume":           "EC 转回普通卷",
  "Decode this EC volume back to a normal volume": "把该 EC 卷转回普通卷",
  Decode:                                "解码",
  "Pick a single cluster first.":        "请先选择单一集群。",
  "Source:":                             "来源:",
  "(pick a collection)":                 "(选择 collection)",
  volumes:                               "个卷",
  "Volumes:":                            "卷:",
  "EC encoding is mutating: source .dat is removed once 14 shards land on peers. Plan capacity (1.5× the source size) before submitting.":
                                         "EC 编码会修改数据:14 个分片成功分发到目标节点后源 .dat 会被删除。提交前确认有 1.5× 源卷大小的余量。",
  "Decode pulls all 14 shards to one node and rebuilds .dat/.idx. The target node needs free space ≥ the original volume size. Runs serially per volume.":
                                         "解码会把 14 个分片汇聚到一台节点重建 .dat/.idx。目标节点空闲空间需 ≥ 原卷大小。按卷串行执行。",
  "Collection is required.":             "Collection 不能为空。",
  'Use a regex like "^mybucket$" for exact match.': '正则匹配,精确匹配请使用 "^mybucket$"。',
  "Full percent":                        "占用阈值 %",
  "Only encode volumes >= this fullness ratio (default 95).":
                                         "仅对占用率 ≥ 该比例的卷编码(默认 95)。",
  "Quiet for":                           "静默时长",
  "Skip volumes with writes inside this window (e.g. 1h, 30m).":
                                         "跳过该窗口内有写入的卷(如 1h、30m)。",
  "Source disk type":                    "源磁盘类型",
  "Source side. Leave blank for any.":   "源端类型。留空匹配所有。",
  "Target disk type":                    "目标磁盘类型",
  "EC shards land on nodes with this label.": "EC 分片落到带该标签的节点。",
  "Shard replica placement":             "分片副本布局",
  "DC/rack/node distribution, e.g. 001 or 200. Blank = master default.":
                                         "DC/rack/node 分布,如 001 或 200。留空使用 master 默认。",
  "Max parallelization":                 "最大并行度",
  "Concurrent shard copies. Default 10.": "并发分片复制数,默认 10。",
  "Rebalance after encode":              "编码后自动均衡",
  "Force (skip safety checks)":          "强制(跳过安全校验)",
  "Must match the diskType the EC shards were placed on.": "必须与 EC 分片所在的 diskType 一致。",
  "Start ec.encode":                     "开始 ec.encode",
  "Start ec.decode":                     "开始 ec.decode",
  "No volumes selected.":                "未选择卷。",
  "Pick volumes from a single cluster.": "请选择同一集群下的卷。",
  "Selection contains EC volumes (already encoded).": "选中包含 EC 卷(已编码)。",
  "Selection mixes EC and normal volumes.": "选中混合了 EC 卷和普通卷。",

  // ---- EC progress stream ------------------------------------------
  "ec.encode in progress":               "ec.encode 进行中",
  "ec.encode (no force)":                "ec.encode(不带 force)",
  "ec.encode (force)":                   "ec.encode(带 force)",
  "ec.decode in progress":               "ec.decode 进行中",
  Elapsed:                               "已耗时",
  ETA:                                   "预计剩余",
  "calculating…":                        "计算中…",
  "Shards / sec":                        "分片/秒",
  "Lines / sec":                         "行/秒",
  "Overall progress":                    "总体进度",
  shards:                                "分片",
  "Per-volume":                          "逐卷进度",
  "Target nodes":                        "目标节点",
  "Output (tail)":                       "输出(尾部)",
  "(waiting for output…)":               "(等待输出…)",

  // ---- EC plan dialog (rebuild + balance with Apply checkbox) ------
  "转 EC":                                "转 EC",
  "(optional extra filter)":             "(可选,附加过滤)",
  "Volumes outside this collection are skipped. Leave blank to ignore.": "不属于该 collection 的卷会被跳过。留空则忽略此过滤。",
  "Verbose (log skipped volumes)":       "详细日志(记录被跳过的卷)",
  "Disk type":                           "磁盘类型",
  "Must match the diskType EC shards live on. Blank = default hdd.": "需匹配 EC 分片所在的 diskType。留空默认 hdd。",
  "Limit balancing to this DC. Blank = all DCs.": "仅在该 DC 内均衡。留空 = 全部 DC。",
  "Default 10. Lower under load.":       "默认 10,集群有压力时调低。",
  "Apply (actually run)":                "Apply 实际执行",
  "Unchecked = dry-run (plan only, no data is written). Checked = real run with live streaming progress.":
                                         "不勾 = 试算(只输出方案,不写数据)。勾上 = 真跑,实时流式进度。",
  "Run dry-run":                         "运行试算",
  "Re-run dry-run":                      "重新试算",
  "Run (apply)":                         "运行(真跑)",
  "in progress":                         "进行中",
  "Fix replication":                     "修复副本",
  "Detect and fix under/over/misplaced replicas (volume.fix.replication).":
                                         "检测并修复副本不足/过多/位置错误的卷 (volume.fix.replication)。",
  "Pick a cluster in the topbar first.": "请先在顶栏选择一个集群。",
  "Detect under/over/misplaced replicas. With Apply: copy new replicas and delete extras.":
                                         "检测副本不足/过多/位置错误的卷。勾选 Apply 后会实际复制新副本并删除多余副本。",
  "Collection pattern":                  "Collection 模式",
  'Wildcards * and ? allowed. Blank = all collections.':
                                         "支持通配符 * 和 ?。留空 = 所有 collection。",
  "Retry count":                         "重试次数",
  "How many times to retry topology after a copy.":
                                         "复制后检查拓扑的重试次数。",
  "Delete over-replicated copies":       "删除多余副本",
  "Check sync before deleting":          "删除前检查同步",
  "Verbose output":                      "详细输出",
  "All volumes meet their replication policy.": "所有卷均满足副本策略。",
  "over-replicated":                     "副本过多",
  "misplaced":                           "位置错误",
  "Tick Apply to repair.":               "勾选 Apply 后实际修复。",
  "Shell takes ~15s to collect topology before printing — be patient.":
                                         "命令开头需要约 15 秒收集集群拓扑,期间不会打印日志,请耐心等待。",
  "Done.":                               "完成。",
  Command:                               "命令",
  Copy:                                  "复制",
  Copied:                                "已复制",
  "Back to form":                        "返回表单",
  "Streaming…":                          "输出流中…",
  "Re-run (apply)":                      "再次运行(真跑)",
  "Run volumeServer.leave so the master migrates volumes off the node before you take it offline. Pick a node → review impact → confirm.":
                                         "运行 volumeServer.leave,让 master 在停机前把所有卷迁出。选节点 → 看影响 → 确认。",
  "Pick a cluster in the topbar to start.": "请先在顶栏选择一个集群。",
  "Pick a node":                         "选择节点",
  "filter by host / rack / DC":          "按主机 / rack / DC 筛选",
  Sort:                                  "排序",
  "Sole copies":                         "孤本",
  "No volume servers reported by this cluster.": "该集群没有报告任何 Volume Server。",
  "No nodes match the filter.":          "没有节点匹配筛选条件。",
  "Pick a node above to see what draining it will move.": "先选一个节点,即可查看下线将迁移哪些卷。",
  "Review impact":                       "查看影响",
  "EC shards":                           "EC 分片",
  "{n} volume(s) on this node have NO replica elsewhere.":
                                         "本节点有 {n} 个卷在其他节点没有副本。",
  "Draining will move them — but if the migration fails or the cluster has no other space, you lose those volumes. Run volume.fix.replication first to make sure every volume has at least one peer copy.":
                                         "下线会迁移它们 —— 但若迁移失败或集群没有其他空间,这些卷将会丢失。先运行 volume.fix.replication 让每个卷至少有一份副本。",
  "All volumes on this node have at least one replica elsewhere.":
                                         "本节点所有卷在其他节点至少有一份副本。",
  "Confirm and run":                     "确认并执行",
  "Select a node and review impact before running.":
                                         "请先选择节点并查看影响。",
  "Only use this when the node is unreachable — the master will mark volumes lost if replicas haven't synced.":
                                         "仅当节点已不可达时才勾选 —— 副本未同步时 master 会把卷标记为丢失。",
  "Type the node address to confirm":    "输入节点地址以确认",
  "Doesn't match the selected node.":    "与所选节点不一致。",
  "Force drain {node}":                  "强制下线 {node}",
  "Drain {node}":                        "下线 {node}",
  "Cluster operations.":                 "集群级操作。",
  "Pick from the cluster, or type a new collection name.":
                                         "从集群中选择,或键入一个新的 Collection 名称。",
  "Three-digit string: DC/rack/node copies. Blank = master default.":
                                         "三位数字:DC/rack/节点副本数。留空使用 master 默认。",
  "Limit placement to this DC. Blank = any.": "限定放置 DC,留空则不限。",
  "Limit placement to this rack. Blank = any.": "限定放置 rack,留空则不限。",
  "How many new volumes to pre-allocate. 1–100.": "预分配卷的数量,范围 1–100。",
  "Asking master to allocate new volumes…": "正在向 master 请求新卷…",
  "Per-node volume count":               "各节点卷数",
  Added:                                 "新增",
  "Allocated {n} volume(s).":            "已新增 {n} 个卷。",
  "Grow again":                          "再次新增",
  "Waiting for master to register volumes… {cur}/{tgt}":
                                         "等待 master 注册新卷… {cur}/{tgt}",
  "Master accepted volume.grow but no new volumes appeared within 20s. They may still arrive — refresh in a moment.":
                                         "Master 已接受 volume.grow 请求,但 20 秒内未观察到新卷出现 — 可能还在传播,稍后刷新页面。",
  "Shell output":                        "Shell 输出",
  target:                                "目标",
  "No nodes reporting volumes.":         "没有节点上报卷数据。",
  "Plan a redistribution of volumes across servers. Shows the moves the master would make.":
                                         "规划卷在服务器间的重分布,展示 master 拟执行的迁移。",
  "Blank = all collections.":            "留空 = 所有 Collection。",
  "Limit balancing to this rack. Blank = all racks.":
                                         "限定均衡到该 rack,留空 = 全部 rack。",
  "Asking master to plan moves…":        "正在向 master 规划迁移计划…",
  "Volumes are already balanced — no moves needed.":
                                         "卷已均衡,无需迁移。",
  "move(s) planned":                     "次迁移待执行",
  "Planned moves":                       "拟执行的迁移",
  "Plan moves":                          "规划迁移",
  "Re-run plan":                         "重新规划",
  'ALL_COLLECTIONS = balance globally, EACH_COLLECTION = per-collection, or pick a specific one.':
                                         "ALL_COLLECTIONS = 全局均衡;EACH_COLLECTION = 按 Collection 分别均衡;也可指定具体 Collection。",
  "Default = balance across all collections. EACH_COLLECTION = balance each one separately. Or pick a specific collection.":
                                         "默认 = 跨所有 Collection 一起均衡;EACH_COLLECTION = 按 Collection 分别均衡;也可指定具体 Collection。",
  "(default — all collections)":         "默认(全部 Collection)",
  "EACH_COLLECTION (per-collection)":    "EACH_COLLECTION(分别均衡)",
  Racks:                                 "Rack",
  Nodes:                                 "节点",
  "Click to toggle. Picks ≥1 means only balance volumes in those racks.":
                                         "点击切换。选中 ≥ 1 个则只均衡这些 rack 上的卷。",
  "Click to toggle. Picks ≥1 means only balance volumes on those nodes.":
                                         "点击切换。选中 ≥ 1 个则只均衡这些节点上的卷。",
  "(no racks reported)":                 "(未发现 rack)",
  "(no nodes reported)":                 "(未发现节点)",
  "Writable only":                       "仅可写卷",
  "No-lock (skip admin shell lock)":     "免锁(跳过管理 shell 锁,有风险)",
  "Master is executing moves…":          "Master 正在执行迁移…",
  "Master is calculating the balance plan…": "Master 正在计算均衡方案…",
  "{n} move(s) executed":                "已执行 {n} 次迁移",
  "{n} move(s) planned":                 "已规划 {n} 次迁移",
  "I confirm deletion of {n} empty replica(s).":
                                         "确认删除 {n} 个空副本。",
  "Empty replicas hold no data, but the operation is irreversible at the master level.":
                                         "空副本不含数据,但 master 上的删除不可恢复。",
  "Remove size=0 volume replicas.":      "删除 Size=0 的卷副本。",
  "Plan volume redistribution across servers.":
                                         "在服务器间规划卷迁移。",
  "Detect and fix under/over/misplaced replicas.":
                                         "检测并修复副本不足/过多/位置错误的卷。",
  Detected:                              "检测到",
  Fixed:                                 "已修复",
  Failed:                                "失败",
  fixed:                                 "已修复",
  detected:                              "已检测",
  "By placement":                        "按副本策略",
  replicas:                              "副本",
  "Scan EC volumes for missing shards. With Apply: rebuild them using surviving shards.":
                                         "扫描 EC 卷查找缺失分片。勾选 Apply 则使用剩余分片实际重建。",
  "Move EC shards to balance load across DCs / racks / nodes. With Apply: actually move them.":
                                         "在 DC / rack / 节点间均衡 EC 分片。勾选 Apply 则实际迁移分片。",
  'Empty = EACH_COLLECTION (all). Regex like "^mybucket$" for exact.': '留空 = 所有 collection。精确匹配请用 "^mybucket$"。',
  "volume(s) need rebuild — tick Apply to run.": "个卷待重建 — 勾选 Apply 后执行。",
  "shard move(s) planned — tick Apply to run.": "条分片迁移已规划 — 勾选 Apply 后执行。",
  'Pick from the cluster, or type a regex like "^mybucket$".':
                                         "从集群中选择,或键入正则如 \"^mybucket$\"。",
  "Only encode volumes ≥ this fullness ratio.": "仅对占用率 ≥ 该比例的卷编码。",
  "Skip volumes with writes inside this window.": "跳过该窗口内有写入的卷。",
  "Concurrent shard copies.":            "并发分片复制数。",
  'Empty = EACH_COLLECTION (all). Pick from list or type a regex.':
                                         "留空 = 所有 collection。可下拉选择或键入正则。",
  "DC/rack/node distribution. Blank = master default.":
                                         "DC/rack/node 分布。留空使用 master 默认。",
  seconds:                               "秒",
  minutes:                               "分钟",
  hours:                                 "小时",
  "Volume IDs":                          "卷 ID",
  "(empty — required)":                  "(必填)",
  "Storage estimate":                    "存储估算",
  Saves:                                 "节省",
  "Before (physical)":                   "迁移前(物理)",
  "Logical data":                        "逻辑数据",
  "After EC (1.4×)":                     "迁移后(1.4×)",
  "After EC":                            "迁移后",
  collections:                           "个 Collection",
  "(none)":                              "(无)",
  "(default)":                           "(默认)",
  more:                                  "更多",
  collapse:                              "收起",
  "Source disk type (-sourceDiskType)":  "源磁盘类型 (-sourceDiskType)",
  "Target disk type (-diskType)":        "目标磁盘类型 (-diskType)",
  "Pick source volumes from this disk type. Blank = any.": "从该磁盘类型挑选源卷。留空 = 任意。",

  // ---- Encode dialog dry-run + execute --------------------------------
  Simulate:                              "模拟执行",
  "Simulate (no force)":                 "模拟执行(不带 force)",
  "Re-simulate":                         "重新模拟",
  "Execute (force)":                     "执行(带 force)",
  "Run ec.encode without -force (safety checks enforced).":
                                         "运行 ec.encode 不带 -force(强制执行安全检查)。",
  "Run ec.encode with -force (safety checks bypassed).":
                                         "运行 ec.encode 带 -force(跳过安全检查)。",
  "Cannot simulate without volume data.": "缺少卷数据,无法模拟。",
  "Volume data unavailable; tick Force to skip dry-run.":
                                         "缺少卷数据,勾选强制后可跳过模拟直接执行。",
  "Simulation result":                   "模拟结果",
  "volumes will encode":                 "个卷将被编码",
  skipped:                               "已跳过",
  physical:                              "物理占用",
  "Clear simulation":                    "清除模拟结果",
  "Will encode":                         "待编码",
  Skipped:                               "已跳过",
  "Fullness estimated against default 30 GB volume size limit. Backend uses the cluster's actual value.":
                                         "按默认 30 GB 卷大小估算占用率,后端实际使用集群配置的值。",
  "No volumes match. Loosen the filter or tick Force to skip simulation.":
                                         "无卷匹配。放宽过滤条件,或勾选强制以跳过模拟直接执行。",

  // ---- Deep check (scan) modal -------------------------------------
  "Deep check":                          "深度检查",
  "Scan configuration":                  "扫描配置",
  "Pick what to inspect. Each step shows what was checked and the conclusion.": "选择要检查的项目。每一步会展示扫描目标和结论。",
  "Connectivity":                        "连通性",
  "Probe each cluster master and report which are reachable.": "探测每个集群 master，报告可达情况。",
  "Volume inventory":                    "卷清单",
  "Enumerate volumes across reachable clusters.": "枚举所有可达集群的卷。",
  "Cold scoring":                        "冷热打分",
  "Score volumes against cooling windows and recommend movement.": "按冷却窗口对卷打分并推荐迁移动作。",
  "Replication health":                  "副本健康",
  "Detect under-replicated volumes and surface missing volume IDs.": "检测副本不足的卷，并列出缺失的 volume ID。",
  "Task generation":                     "任务生成",
  "Insert new tiering tasks based on the recommendations.": "根据推荐结果生成新的分层任务。",
  "Start deep check":                    "开始深度检查",
  "Running deep check…":                 "深度检查进行中…",
  "Step":                                "步骤",
  "Target:":                             "目标:",
  "Result:":                             "结论:",
  "Waiting":                             "等待中",
  "Done":                                "完成",
  "Pick at least one check.":            "请至少选择一项检查。",
  "Probed":                              "已探测",
  "clusters reachable":                  "个集群可达",
  "Discovered":                          "发现",
  "volumes total":                       "个卷",
  "recommendations generated":           "条推荐已生成",
  "All volumes are within policy — no action needed.": "全部卷在策略范围内 — 无需迁移。",
  "All replicas present.":               "全部副本完整。",
  "under-replicated volume(s)":          "个副本不足的卷",
  "new task(s) queued.":                 "条新任务已入队。",
  "No new tasks (deduplicated against in-flight work).": "无新任务（已与在途任务去重）。",

  // --- Cluster diagnostics: Masters / Lock probe / drilldown pages (2026-05-20) ---
  // Cluster layout tabs + generic chrome
  "Masters":                                "主节点",
  "enabled":                                "已启用",
  "disabled":                               "已禁用",
  "Loading...":                             "加载中…",
  "You do not have permission to view this cluster.":              "您无权查看此集群。",
  "You do not have permission to use this shell console.":         "您无权使用此 Shell 控制台。",

  // Masters page
  "You do not have permission to view cluster diagnostics.":       "您无权查看集群诊断信息。",
  "Loading masters…":                       "正在加载主节点…",
  "probing admin lock…":                    "正在探测管理锁…",
  "Masters & raft quorum":                  "主节点与 Raft 仲裁",
  "Configured master":                      "配置的主节点",
  "discovered":                             "个已发现",
  "Address":                                "地址",
  "Role":                                   "角色",
  "Reported leader":                        "上报的 Leader",
  "Reported peers":                         "上报的 Peers",
  "Latency":                                "延迟",
  "Lock holder":                            "锁持有者",
  "Warnings":                               "警告",
  "Lock probe":                             "锁探测",
  "Leases the SeaweedFS shell admin lock for one round-trip and releases immediately. Use this when a shell action is hanging — the response identifies the current holder without granting any mutating capability.": "申请一次 SeaweedFS shell 管理锁后立即释放。当某个 shell 操作卡住时使用此功能可以查看当前锁持有者，且不会授予任何写权限。",
  "Probe admin lock":                       "探测管理锁",
  "Requires cluster.lock.probe capability": "需要 cluster.lock.probe 权限",
  "Quorum healthy":                         "仲裁健康",
  "Quorum issues":                          "仲裁存在问题",
  "leader disagreement":                    "Leader 不一致",
  "peer-set disagreement":                  "Peer 集合不一致",
  "leader(s)":                              "Leader",
  "expected peers":                         "预期 peers",
  "warn":                                   "警告",
  "err":                                    "错误",
  "leader":                                 "Leader",
  "voter":                                  "投票者",
  "nonvoter":                               "非投票者",
  "unknown":                                "未知",
  "none reported":                          "未上报",
  "No probe run yet.":                      "尚未执行探测。",
  "Acquired and released the lock on":      "已在以下节点获取并释放锁：",
  "in":                                     "，用时",
  "A shell command should be able to start now.": "Shell 命令现在应该可以执行了。",
  "held":                                   "已被持有",
  "Currently held by":                      "当前持有者：",
  "on":                                     "，节点：",
  "Other shell commands will block until this holder releases.": "其他 shell 命令会阻塞直到该持有者释放锁。",
  "quorum unhealthy":                       "仲裁不健康",
  "probe failed":                           "探测失败",

  // Collection detail page
  "You do not have permission to view collection details.":        "您无权查看集合详情。",
  "Loading collection…":                    "正在加载集合…",
  "Back to all collections":                "返回所有集合",
  "Open balance plan/apply dialog":         "打开均衡 计划/应用 对话框",
  "Requires volume.balance capability":     "需要 volume.balance 权限",
  "Balance volumes…":                       "均衡卷…",
  "Replicas":                               "副本数",
  "rows across all nodes":                  "所有节点上的副本行数",
  "Total size":                             "总大小",
  "deleted":                                "已删除",
  "read-only":                              "只读",
  "Replication placement":                  "副本放置策略",
  "Placement":                              "放置策略",
  "Replica rows":                           "副本行数",
  "Per-server distribution":                "按服务器分布",
  "Flags":                                  "标记",

  // Volume server detail page
  "You do not have permission to view volume servers.":            "您无权查看卷服务器。",
  "Loading volume server…":                 "正在加载卷服务器…",
  "Back to topology":                       "返回拓扑",
  "DC":                                     "数据中心",
  "full":                                   "已用",
  "Used bytes":                             "已用字节",
  "Max volumes":                            "最大卷数",
  "Free slots":                             "空闲卷槽",
  "Disks":                                  "磁盘",
  "No disk topology reported.":             "未上报磁盘拓扑。",
  "Max":                                    "上限",
  "Free":                                   "空闲",
  "Used":                                   "已用",
  "Collections on this server":             "该服务器上的集合",
  "No volumes hosted here.":                "此处未托管任何卷。",

  // --- Filers / Volume detail / EC Shards pages (2026-05-20) ---
  "Filers":                                 "Filer 节点",
  "EC Shards":                              "EC 分片",
  "You do not have permission to view filers.":                   "您无权查看 Filer 列表。",
  "Loading filers…":                        "正在加载 Filer…",
  "registered with master":                 "已在 master 注册",
  "No filers registered with this cluster.": "此集群尚未注册任何 Filer。",
  "config-only (heartbeat missing)":        "仅在配置中(心跳未收到)",
  "Master did not return a filer list":     "Master 未返回 Filer 列表",
  "Falling back to the filers configured at cluster registration.":
                                            "退回到集群注册时填写的 Filer 列表。",
  "Filer/master heartbeat is broken":       "Filer 与 Master 之间的心跳异常",
  "These filer addresses come from cluster.filer_addr but the master never saw them. Check the filer was started with -master=<this cluster's master> and that the network allows the heartbeat.":
                                            "这些 Filer 地址来自集群配置 cluster.filer_addr,但 master 从未收到它们的心跳。请检查 filer 启动参数 -master=<本集群 master> 是否正确,以及网络是否允许心跳通信。",
  "Source":                                 "来源",
  "master":                                 "master",
  "master+config":                          "master+配置",
  "config-only":                            "仅配置",
  "Version":                                "版本",
  "Registered at":                          "注册时间",
  "Open filer in new tab":                  "在新标签页中打开 Filer",
  "Data center":                            "数据中心",

  "You do not have permission to view volume details.":           "您无权查看卷详情。",
  "Loading volume…":                        "正在加载卷…",
  "EC shard layout":                        "EC 分片布局",
  "EC shards present":                      "存在的 EC 分片",
  "EC replicas":                            "EC 副本",
  "Replica placements":                     "副本分布",
  "present":                                "存在",
  "Missing shards":                         "缺失分片",

  "You do not have permission to view EC shards.":                "您无权查看 EC 分片视图。",
  "Loading EC shards…":                     "正在加载 EC 分片…",
  "with missing shards":                    "存在分片缺失",
  "all volumes complete":                   "所有 EC 卷分片完整",
  "Filter by collection…":                  "按集合过滤…",
  "Only show incomplete":                   "仅显示缺失",
  "This cluster has no EC volumes yet. Run ec.encode to convert volumes.": "此集群尚无 EC 卷。运行 ec.encode 进行转换。",
  "No EC volumes match the filter.":        "没有匹配过滤条件的 EC 卷。",
  "Shard 0–13":                             "分片 0–13",

  // EC volume detail page
  "EC volume":                              "EC 卷",
  "All EC volumes":                         "所有 EC 卷",
  "Loading EC volume…":                     "正在加载 EC 卷…",
  "Missing shard indices":                  "缺失的分片索引",
  "Run ec.rebuild from the shell to recover missing shards while ≥10 remain.":
                                            "在 shell 中运行 ec.rebuild,只要还有 ≥10 个分片即可恢复缺失的分片。",
  "Recoverable: ≥10 shards still present. ec.rebuild can regenerate the missing ones.":
                                            "可恢复:至少 10 个分片仍然存在,ec.rebuild 可以重建缺失的分片。",
  "UNRECOVERABLE: fewer than 10 shards remain. ec.rebuild cannot help.":
                                            "不可恢复:剩余分片少于 10 个,ec.rebuild 无法重建。",
  "Rebuild shards":                         "重建分片",
  "Open ec.rebuild plan for this collection": "打开此集合的 ec.rebuild 计划",
  "Rebuild":                                "重建",
  "Rebuild degraded volumes":               "重建降级的 EC 卷",
  "No analytics snapshot yet for this volume": "该卷暂无分析快照",
  "This page shows read patterns and cohort comparisons, which are produced by the hourly analytics pipeline. New volumes (and volumes the pipeline hasn't reached yet) won't have data here.":
                                            "此页面展示读取模式和同类比较,数据由每小时分析任务产出。新创建的卷或分析任务尚未覆盖的卷在这里没有数据。",
  "Back to volume list":                    "返回卷列表",
  "Cluster unknown — open the volume's cluster to see placement":
                                            "无法确定该卷所在集群 — 请进入对应集群查看布局",
  "Want to see replicas / EC shards / nodes? Open the placement view directly:":
                                            "想看副本 / EC 分片 / 所在节点?直接打开布局视图:",
  "Analytics is taking longer than expected": "分析数据加载时间超出预期",
  "If this hangs forever, your browser may be running stale JS. Try a hard refresh (Cmd/Ctrl+Shift+R). Or skip analytics and go straight to the placement view:":
                                            "如果一直转圈,可能是浏览器还在跑旧的 JS。请用 Cmd/Ctrl+Shift+R 硬刷新;或者跳过分析,直接进入布局视图:",
  "AI provider is not configured":          "尚未配置 AI 服务提供商",
  "Open the AI config page, add an OpenAI / Anthropic / Azure / local provider, and mark one as default.":
                                            "打开 AI 配置页,添加 OpenAI / Anthropic / Azure / 本地模型等任一个提供商,并把其中一个设为默认。",
  "Open AI config":                         "打开 AI 配置",
  "Tool failed":                            "工具调用失败",
  "Result":                                 "结果",
  "Back to AI config":                      "返回 AI 配置",
  "Assistant tool authorization":           "小助手工具授权",
  "Each row is a tool the floating AI assistant could call. Flip the switch to control whether the AI is allowed to invoke it autonomously. Tools that are off never appear in the model's tool spec — it physically cannot choose them. Operators can still invoke any tool directly through the controller UI; this gate is only for AI.":
                                            "每一行都是小助手可以调用的工具。拨动开关决定 AI 能否自主调用。关闭的工具不会出现在模型的工具列表里 —— 它根本看不到这些选项,也就无法调用。操作员仍可通过控制台 UI 直接调用任何工具;这道门只针对 AI。",
  "Read tools — safe, default on":          "只读工具 —— 安全,默认开启",
  "Query-only tools. The assistant uses these to look up cluster state and SOPs.":
                                            "只查询、不修改。小助手用这些工具查看集群状态和 SOP。",
  "Write tools — reversible, default off":  "写入工具 —— 可逆,默认关闭",
  "Mutating tools that change platform state but can be rolled back. Turn on only if you trust the assistant to manage these.":
                                            "会修改平台状态但可回滚的工具。只有信任小助手能管好这些时才打开。",
  "Destructive tools — irreversible, default off": "破坏性工具 —— 不可逆,默认关闭",
  "Tools whose effects cannot be undone (deletes, decode, etc). Strongly recommended to keep off and only invoke from the controller UI with explicit confirmation.":
                                            "无法撤销的工具(删除、解码等)。强烈建议保持关闭,仅在控制台 UI 二次确认后由人手动触发。",
  "Orphaned policies":                      "孤儿策略",
  "These tools exist in the database but the running binary no longer registers them. Safe to ignore — they are not exposed to the assistant. Clean them up after a deploy when you're sure they're gone for good.":
                                            "数据库里有但当前后端二进制已经不再注册的工具。可以暂时忽略 —— 它们不会被暴露给小助手。确认部署后真的不再需要时再清理。",
  "AI allowed":                             "允许 AI",
  "AI blocked":                             "禁止 AI",
  "orphan":                                 "孤儿",
  "Last toggled by":                        "上次切换者",
  "Filer JWT signing secret (optional)":    "Filer JWT 签名密钥(可选)",
  "Paste the `key =` value from security.toml under [jwt.filer_signing] (or [jwt.signing] for older builds). The controller signs a short-lived HS256 token per request — DO NOT paste a JWT here, paste the HMAC secret. Location: typically /etc/seaweedfs/security.toml or ~/.seaweedfs/security.toml on the filer host; check `weed filer -h` for the active path. Leave empty if your filer has JWT disabled.":
                                            "粘贴 filer 主机上 security.toml 里 [jwt.filer_signing] (或老版本的 [jwt.signing])下的 `key =` 值。控制器每次请求会用它签发短期 HS256 token — 这里要填 **HMAC 密钥**,不是 JWT。位置通常是 /etc/seaweedfs/security.toml 或 ~/.seaweedfs/security.toml,可用 `weed filer -h` 查看实际路径。如果你的 filer 未开启 JWT,留空即可。",
  "(opens dry-run; Apply runs the rebuild)": "(打开试算;勾选 Apply 后才会真正执行)",
  "Shard layout":                           "分片布局",
  "DC(s)":                                  "数据中心数",
  "rack(s)":                                "机架数",
  "Hosts holding this volume":              "持有该卷的主机",
  "No host holds any shard of this volume.": "没有主机持有该卷的任何分片。",
  "Indices":                                "分片索引",
  "Shard → hosts":                          "分片 → 节点",
  "Hosts":                                  "节点",
  "MISSING":                                "缺失",
  // Preflight lock probe (shell-action.tsx)
  "Probing lock…":                          "正在探测锁…",
  "Continue anyway":                        "仍然继续",
  "Cluster admin lock is held":             "集群管理锁已被持有",
  "Cluster quorum is unhealthy":            "集群仲裁不健康",
  "Running now will block until they release.": "现在运行将会阻塞,直到持有者释放锁。",
  "Click \"Continue anyway\" to bypass and run.": "点击\"仍然继续\"将绕过检查并执行。",
  "View read pattern / cohort analytics":   "查看读取模式 / 同期对比分析",
  "View placement (replicas / EC shards)":  "查看放置详情(副本 / EC 分片)",
  "View placement":                         "查看放置详情",
  "View analytics":                         "查看分析",

  // File browser. Note: bare-ident `Files:` already maps to "文件数"
  // (KPI label), so the tab uses a distinct title-case key here.
  "File browser":                           "文件浏览器",
  "You do not have permission to browse files.": "您无权浏览文件。",
  "Loading files…":                         "正在加载文件…",
  "This folder is empty.":                  "此目录为空。",
  "Root":                                   "根目录",
  "Up":                                     "上一级",
  "Upload…":                                "上传…",
  "New folder":                             "新建文件夹",
  "New folder name":                        "新文件夹名称",
  "Choose filer":                           "选择 Filer 节点",
  "No filer":                               "无 Filer",
  "MIME":                                   "MIME",
  "Select":                                 "选择",
  "Download":                               "下载",
  "folder":                                 "目录",
  "Delete {n} item(s)? This cannot be undone.": "删除 {n} 项?此操作不可撤销。",

  // Today's attention dashboard panel
  "Today's attention":                      "今日关注",
  "Hide for today":                         "今日忽略",
  // Distinct key from the existing "Restore" (which is "回滚" / rollback
  // for migrations and executions) — semantics here are "un-dismiss".
  "Show hidden":                            "显示已忽略",
  "{n} hidden for today":                   "已忽略 {n} 条",
  // Per-signal time chip — "Since" uses server-side truth (e.g. alert
  // created_at); "First seen at" is the client-side fallback for signals
  // the API doesn't timestamp (Raft consistency, EC degradation).
  "Since":                                  "起始",
  "First seen at":                          "本机首次发现",
  "(may have started earlier)":             "(实际开始时间可能更早)",
  "Signals that warrant operator action":   "需要运维关注的信号",
  "Pending task approvals":                 "待审批任务",
  "waiting for review":                     "条等待审核",
  "Health gate is closed":                  "健康闸门已关闭",
  "automated jobs blocked":                 "自动作业已被阻断",
  "Emergency stop is engaged":              "紧急停止已启用",
  "All executor activity is suspended.":    "所有执行器活动已暂停。",
  "Safety guard is blocking ops":           "安全围栏正在阻断操作",
  "Operations temporarily disallowed.":     "暂时不允许执行操作。",
  "Critical alerts firing":                 "严重告警正在触发",
  "Warnings firing":                        "警告级告警触发中",
  "Ignore all":                             "全部忽略",
  "Ignore selected":                        "忽略所选",
  "Show ignored":                           "显示已忽略",
  "ignored":                                "已忽略",
  "Select event":                           "选择事件",
  "Select all on page":                     "选择本页全部",
  "Ignore selected events":                 "忽略所选事件",
  "Ignore everything currently shown":      "忽略当前列表中的全部事件",
  "Ignore {n} selected alert(s)?":          "忽略所选的 {n} 条告警?",
  "They won't show up in Today's Attention or the default events list.": "它们将不再出现在今日关注或默认事件列表中。",
  "Ignore all {n} unacked alert(s)?":       "忽略当前 {n} 条未确认告警?",
  "Affects only events older than now — anything that fires after this stays visible.": "仅影响此刻之前的事件;之后触发的告警仍会显示。",
  "Ignore all {n} active alert(s)?":        "忽略全部 {n} 条活动告警?",
  "New alerts that fire after this stay visible. Use the alerts page to undo.": "之后触发的新告警仍会显示。如需恢复,请到告警页面操作。",
  "Ignored {n}":                            "已忽略 {n} 条",
  "Ignore failed":                          "忽略失败",
  "Ignored by":                             "忽略者",
  "Ignored":                                "已忽略",
  "critical":                               "严重",
  "warning":                                "警告",

  // ---- Sidebar nav items missing translations ----
  "Dashboard":                              "总览",
  "Backends":                               "存储后端",
  "Cohort":                                 "同业横比",
  "Policies":                               "迁移策略",
  "Skills":                                 "技能(SOP)",
  "Holidays":                               "节假日",
  "EC":                                     "EC",

  // ---- Skills page extras ----
  "High risk":                              "高风险",
  "Custom":                                 "自定义",
  "All":                                    "全部",
  "All categories":                         "全部分类",
  "Any risk":                               "全部风险等级",
  "Enabled only":                           "仅显示已启用",
  "Reset":                                  "重置",

  // ---- Admin tabs ----
  "Admin":                                  "管理后台",
  "Configure":                              "配置",
  "Review":                                 "复核",
  "Settings":                               "设置",
  "Permissions":                            "权限",
  "Audit":                                  "审计",

  // ---- Admin tabs + config groups ----
  "Users":                                  "用户",
  "Autonomy":                               "自动化等级",
  "Pressure":                               "压力",
  "Server":                                 "服务",

  // ---- Policies + Lifecycle pages ----
  "Live":                                   "运行中",
  "Dry-run":                                "演练",
  "Lifecycle":                              "生命周期",
  "Data lifecycle":                         "数据生命周期",
  "Buckets w/ retention":                   "已设保留期的桶",
  "Expired data":                           "已过期数据",
  "No buckets have a retention rule yet":   "尚无桶配置了保留规则",
  "Open the Buckets page, edit a bucket's governance, and set a retention period.": "前往「桶」页面，编辑桶的治理设置并设定保留期。",

  // ---- Cluster maintenance tabs ----
  "Drain history":                          "下线历史",

  // ---- Tools: ops templates + scripts ----
  "Categories":                             "分类",
  "Scripts":                                "脚本",
  "System":                                 "系统",
  "User":                                   "用户",

  // ---- Cohort / temperature pages ----
  "Cohorts":                                "同业组",
  "Anomalies":                              "异常",
  "Collection":                             "集合",
  "flat":                                   "平稳",

  // ---- Backends page ----
  "Last test OK":                           "上次测试通过",
  "Last test failed":                       "上次测试失败",

  // ---- S3 page ----
  "Past retention":                         "已过保留",
  "With quota":                             "已设配额",
  "How does access control work?":          "访问控制如何工作？",

  // ---- Collections page ----
  "Collections":                            "集合",
  "Volumes":                                "卷",
  "Total size":                             "总大小",
  "total":                                  "总计",

  // ---- Cluster list page (app/clusters/page.tsx) ----
  "Registered":                             "已注册",
  "Enabled":                                "已启用",
  "Disabled":                               "已禁用",
  "New cluster":                            "新建集群",
  "Clusters":                               "集群",

  // ---- Activity / tasks panel empty states + filters ----
  "More":                                   "更多",
  "No tasks":                               "无任务",
  "No pending tasks":                       "无待处理任务",
  "No approved tasks":                      "无已批准任务",
  "No running tasks":                       "无运行中任务",
  "No failed tasks":                        "无失败任务",
  "No scheduled tasks":                     "无定时任务",
  "No succeeded tasks":                     "无已完成任务",
  "No rolled_back tasks":                   "无已回滚任务",
  "No cancelled tasks":                     "无已取消任务",
  "Tasks land here after Dashboard \"Run scoring\" or when policies trigger.": "运行评分或策略触发后，任务会出现在这里。",
  "Approve a pending task above to move it here.": "批准上方的待处理任务后会移到这里。",
  "Tasks appear once you click Run on an approved task.": "点击已批准任务上的「运行」后会出现在这里。",
  "Nothing is on fire — failed tasks would show here with a retry button.": "一切正常 —— 出现失败时会显示在这里并附带重试按钮。",
  "Tasks appear after Dashboard \"Run scoring\" or as policies trigger.": "评分运行或策略触发后任务会出现在这里。",
  "{n} tasks":                              "{n} 个任务",
  "Run failed":                             "运行失败",

  // ---- Capacity forecast panel (components/capacity-forecast.tsx) ----
  "Capacity forecast":                      "容量预测",
  "{n} critical":                           "{n} 个严重",
  "no data":                                "无数据",
  "stable":                                 "稳定",
  "full":                                   "已写满",
  "full in >10y":                           ">10 年后写满",
  "full in ~{n}d":                          "约 {n} 天后写满",
  "day":                                    "天",
  "confidence":                             "置信度",

  "No enabled clusters":                    "没有启用中的集群",
  "Add a cluster in /clusters to start monitoring.": "请前往 /clusters 添加集群以开始监控。",
  "All clear":                              "一切正常",
  "No action items right now. Routine reviews still recommended.": "目前没有待处理项;仍建议进行例行审查。",
  "Raft quorum issues":                     "Raft 仲裁问题",
  "consistency issue(s)":                   "项一致性问题",
  "Admin lock is held":                     "管理锁被持有",
  "Held by":                                "持有者:",
  "EC volumes with missing shards":         "存在缺失分片的 EC 卷",
  "incomplete volume(s)":                   "个不完整的卷",
  "Diagnostics unreachable":                "诊断接口不可达",
  "pending approval":                       "待审批",

  // ---- Analyzer scripts page (/scripts) ----
  "Analyzer scripts":                       "分析脚本",
  "Python scripts that parse shell-command output deterministically. Templates can plug a script between two shell steps to extract sorted lists, filter by collection, find max/min nodes, etc. — no LLM guesswork on the math.":
    "用于确定性解析 shell 命令输出的 Python 脚本。模板可以在两个 shell 步骤之间插入脚本,用于排序列表、按 collection 过滤、找最大/最小节点等 —— 不依赖大模型推算。",
  "filter by name / tag / command":         "按名称 / 标签 / 命令筛选",
  "New script":                             "新建脚本",
  "For":                                    "适用命令",
  "Origin":                                 "来源",
  "No scripts":                             "暂无脚本",
  "No matches for current filter.":         "当前筛选无匹配项。",
  "Click 'New script' to author one, or run a migration to seed the system library.":
    "点击「新建脚本」开始编辑,或运行迁移脚本播种系统库。",
  "For commands":                           "适用命令",
  "system":                                 "系统",
  "user":                                   "用户",
  "off":                                    "已禁用",
  "Delete script":                          "删除脚本",
  "Delete script \"{name}\"?":              "确定删除脚本「{name}」?",
  "Delete failed":                          "删除失败",
  "Edit script":                            "编辑脚本",
  "Title":                                  "标题",
  "What this script does and when to use it (the AI assistant uses this to pick scripts).":
    "脚本的作用以及使用场景(AI 助手会根据这段文字挑选合适的脚本)。",
  "For commands (comma separated)":         "适用命令(逗号分隔)",
  "Tags (comma separated)":                 "标签(逗号分隔)",
  "Params (JSON array of {name,type,required?,default?,doc?,enum?})":
    "参数定义(JSON 数组,字段:name,type,required?,default?,doc?,enum?)",
  "Python body":                            "Python 主体",
  "· stdin = { input, params } JSON · stdout = { ok, result, error }":
    "· stdin = { input, params } JSON · stdout = { ok, result, error }",
  "Enabled (available to templates and the assistant)":
    "启用(可被模板和 AI 助手调用)",
  "Name and body are required":             "名称和脚本主体为必填",
  "Save failed":                            "保存失败",
  "AI optimize":                            "AI 优化",
  "Asks the configured AI to refactor the body for clarity / robustness. Preview the proposal, optionally accept; saving creates a new version with reason ai-optimize.":
    "调用已配置的 AI,对脚本主体进行重构(可读性 / 健壮性)。可先预览结果,再选择是否应用;保存后将以 ai-optimize 为原因创建新版本。",
  "Focus (e.g. 'handle missing collection field', 'speed up by parsing line-by-line')":
    "侧重点(例如:「兼容缺失 collection 字段」「改成逐行解析以提速」)",
  "Ask AI to optimize":                     "请 AI 优化",
  "Asking AI…":                             "正在请求 AI…",
  "AI optimize failed":                     "AI 优化失败",
  "no body returned":                       "未返回脚本主体",
  "Save the script first so the AI has something to optimize":
    "请先保存脚本,AI 才能对它做优化",
  "Applied. Click Save to persist as a new version.":
    "已应用到编辑器,点击保存即可作为新版本入库。",
  "Apply to editor":                        "应用到编辑器",
  "Proposed body (diff in your head)":      "AI 建议的主体(请自行比对差异)",
  "sandbox":                                "沙箱",
  "(current: v{n})":                        "(当前版本:v{n})",
  "hide":                                   "收起",
  "show {n}":                               "展开 {n} 条",
  "edit":                                   "编辑",
  "by":                                     "操作人",
  "revert":                                 "回滚",
  "Revert to v{n}":                         "回滚到 v{n}",
  "Revert to v{n}? This creates a new version that copies the historical body.":
    "回滚到 v{n}?将基于该历史版本创建一个新版本(不会重写历史)。",
  "Reverted to v{n}":                       "已回滚到 v{n}",
  "Revert failed":                          "回滚失败",
  "Sandbox":                                "沙箱",
  "Paste sample shell output → run the script ephemerally → inspect result. Nothing persists until you Save.":
    "粘贴一段示例 shell 输出 → 临时运行脚本 → 查看结果。保存之前不会落库。",
  "Sample input (typically a `weed shell` stdout dump)":
    "示例输入(通常是一段 weed shell 的 stdout)",
  "Save as fixture on this script":         "保存为该脚本的固定示例",
  "Params (JSON object)":                   "参数(JSON 对象)",
  "Params is not valid JSON":               "参数不是合法的 JSON",
  "Sandbox run failed":                     "沙箱运行失败",
  "input":                                  "输入",
  "hash":                                   "哈希",
  "stderr":                                 "标准错误",
  "v{n} — saving creates v{next}":          "v{n} — 保存后将创建 v{next}",

  // ---- File browser (/files) ----
  "File Browser":                           "文件浏览",
  "Browse the cluster's filer namespace. Use this to inspect what's stored under a path before crafting a tiering policy or move plan.":
    "浏览集群 filer 的命名空间。可在制定分层策略或迁移计划前查看路径下实际存储了什么。",
  "Path":                                   "路径",
  "root":                                   "根目录",
  "Go to root":                             "回到根目录",
  "Folder name cannot be empty or contain '/'": "文件夹名不能为空或包含 '/'",
  "Folder created":                         "文件夹已创建",
  "Failed to create folder":                "创建文件夹失败",
  "Empty directory":                        "空目录",
  "Drop files here to upload, or use the Upload button above.":
    "可将文件拖到此处上传,或使用上方的「上传」按钮。",
  "Drop to upload to {path}":               "拖放到此处上传到 {path}",
  "Uploaded {n} file(s)":                   "成功上传 {n} 个文件",
  "Failed to upload {n} file(s)":           "{n} 个文件上传失败",
  "Download failed":                        "下载失败",
  "Delete file":                            "删除文件",
  "Delete folder":                          "删除文件夹",
  "Delete \"{name}\"?":                     "确定删除「{name}」?",
  "Delete folder \"{name}\" and ALL its contents?":
    "确定删除文件夹「{name}」及其全部内容?",
  "More entries available. Open a sub-directory to narrow, or use the filer-side paging directly.":
    "目录条目较多,只展示了一部分。可进入子目录缩小范围,或在 filer 侧直接分页查询。",
  "Mime":                                   "MIME",

  // ---- Temperature dashboard (/temperature) ----
  "Temperature":                            "温度",
  "Volume temperature classified from access patterns. Use this to find collections that have cooled down — they're the candidates for warm/cold tiering.":
    "依据访问行为对卷进行温度分级。可用于识别已冷却下来的 collection —— 那些就是温/冷分层的候选对象。",
  "Mixed temperature only":                 "只看温度混合的 collection",
  "Total volumes":                          "卷总数",
  "Hot":                                    "热",
  "Warm":                                   "温",
  "Cool":                                   "凉",
  "Cold":                                   "冷",
  "Frozen":                                 "冻结",
  "Cold + Frozen":                          "冷 + 冻结",
  "Cool (recently cooled)":                 "凉(近期降温)",
  "watch list":                             "重点关注",
  "No mixed-temperature collections":       "没有温度混合的 collection",
  "Every collection has a uniform temperature. Tier-by-collection policies will work cleanly here.":
    "所有 collection 内部温度一致,按 collection 维度的分层策略可以放心使用。",
  "Volume features haven't been computed yet. Run the scorer or wait for the next snapshot.":
    "卷特征尚未计算。可运行 scorer 或等待下一次快照。",
  "Reads (7d)":                             "读次数(7d)",
  "Drill down":                             "下钻",
  "Showing {n} volumes — biggest first per band.": "展示 {n} 个卷 —— 每个温度带按大小倒序。",
  "Draft a policy for this collection":     "为该 collection 起草策略",
  "No volumes in this collection.":         "该 collection 暂无卷。",
  "Reads 7d":                               "7d 读取",
  "Reads 30d":                              "30d 读取",
  "Temperature thresholds":                 "温度阈值",
  "reads(7d) ≥ 50 or active in 1h":         "7d 读取 ≥ 50 或 1 小时内有访问",
  "any reads in 7d":                        "7 天内有任意读取",
  "no 7d reads, had 30d reads":             "7 天内无读取但 30 天内有过",
  "zero 30d reads, last seen <90d":         "30 天内零读取且 90 天内有过访问",
  "untouched for ≥90d":                     "90 天以上无访问",
  "{n}d":                                   "{n}d",

  // ---- Drain jobs (/clusters/drains, /clusters/leave) ----
  "Failed to start drain":                  "启动 drain 失败",
  "Reason (optional)":                      "原因(可选)",
  "e.g. planned maintenance — replacing failing disk on rack r3":
    "例如:计划维护 —— 更换 r3 机架失效磁盘",
  "View drain history":                     "查看 drain 历史",
  "In-flight drains":                       "进行中的 drain",
  "vols remaining":                         "卷剩余",
  "Drain history":                          "Drain 历史",
  "Every volumeServer.leave job recorded by the controller. Click a row to follow live progress or read the past run log.":
    "控制器记录的所有 volumeServer.leave 任务。点击行进入详情查看实时进度或回看日志。",
  "Drain new server":                       "新建 Drain",
  "No drains recorded yet":                 "尚无 drain 记录",
  "When you drain a volume server, the job is recorded here for the rest of its lifetime.":
    "Drain 一个 volume server 时,任务会在此长期留档。",
  "Cluster":                                "集群",
  "Progress":                               "进度",
  "Started":                                "开始时间",
  "Requested by":                           "发起人",
  "verifying":                              "验证中",
  "cancelled":                              "已取消",
  "Cancel this drain? The shell will be interrupted and the node may end up partially drained.":
    "确认取消此 drain?Shell 会被中断,节点可能仅部分清空。",
  "Cancellation requested":                 "已请求取消",
  "Cancel failed":                          "取消失败",
  "retry of":                               "重试自",
  "Retry failed":                           "重试失败",
  "On cluster":                             "所在集群",
  "Cancelling…":                            "正在取消…",
  "Cancel drain":                           "取消 drain",
  "Starting…":                              "启动中…",
  "Retry as new drain":                     "重试为新 drain",
  "Drain id":                               "Drain ID",
  "Finished":                               "结束时间",
  "volumes remaining":                      "卷剩余",
  "Node is empty and safe to power off.":   "节点已清空,可以安全下线。",
  "Stream error":                           "事件流错误",
  "Run log":                                "运行日志",
  "lines":                                  "行",
  "Waiting for output…":                    "正在等待输出…",

  // ---- Costs + pricing ----
  "Costs":                                  "成本",
  "Backend pricing":                        "存储后端单价",
  "Current monthly storage spend per backend and per collection. Reasoned against the counterfactual: 'what if every byte were on hot with 3 replicas?'":
    "按后端 / collection 维度的当月存储开销,并与反事实「全部 hot + 3 副本」做对比。",
  "$/TB/month per storage backend. Exactly one row must be the hot reference — its price is the basis for 'savings vs all-hot-3x' on the Costs dashboard.":
    "每个 backend 的 $/TB/月 单价。必须有且仅有一行被标为 hot reference,其价格用作 Costs 页「对比全 hot 3 副本」的基准。",
  "Manage pricing":                         "管理单价",
  "Snapshot this month":                    "本月快照",
  "Snapshot saved":                         "快照已保存",
  "Snapshot failed":                        "快照失败",
  "AI plan migrations":                     "AI 规划迁移",
  "AI plan failed":                         "AI 规划失败",
  "Monthly spend":                          "月支出",
  "priced backends only":                   "仅含已配置单价的 backend",
  "All-hot 3x baseline":                    "全 hot 3 副本基线",
  "no hot reference":                       "未设 hot 参考",
  "Realised saving":                        "已实现节省",
  "vs baseline":                            "对比基线",
  "Potential extra saving":                 "还能再省",
  "recommendations":                        "条建议",
  "{n} of storage is on backends with no pricing configured.":
    "有 {n} 数据存放在未配置单价的后端上。",
  "Configure pricing":                      "配置单价",
  "to include it in the monthly bill.":     "以便纳入月账单。",
  "Per-backend monthly spend":              "按后端的月支出",
  "Backend":                                "后端",
  "$ / TB / mo":                            "$ / TB / 月",
  "Monthly cost":                           "月成本",
  "Share":                                  "占比",
  "unpriced":                               "未定价",
  "Top collections by monthly cost":        "按月成本排序的 collection",
  "Backend mix":                            "后端构成",
  "Last 12 months":                         "过去 12 个月",
  "actual":                                 "实际",
  "counterfactual":                         "反事实",
  "Unrealised savings (rule-based)":        "尚未实现的节省(规则)",
  "Monthly saving":                         "月节省",
  "AI migration proposals":                 "AI 迁移建议",
  "The AI didn't find any worthwhile migrations. Everything looks well-placed.":
    "AI 没找到值得做的迁移,当前布局看起来已经合理。",
  "risk":                                   "风险",
  "conf":                                   "信心",
  "low":                                    "低",
  "medium":                                 "中",
  "high":                                   "高",
  "Open in Ops console":                    "在运维命令页打开",
  "Save as template":                       "保存为模板",
  "No volumes to price yet":                "尚无可计价的卷",
  "Once the cluster has volumes, this dashboard fills in. Make sure pricing is configured in /pricing.":
    "集群有卷后此页会填充内容;请确认 /pricing 已配置单价。",
  "New backend price":                      "新增后端单价",
  "No pricing configured":                  "尚未配置任何单价",
  "Click 'New backend price' to add one. Migration 036 seeds local-ssd/local-hdd/local out of the box.":
    "点击「新增后端单价」开始;迁移 036 已默认 seed 了 local-ssd / local-hdd / local 三行。",
  "$/TB/month":                             "$/TB/月",
  "Hot reference (counterfactual basis)":   "Hot 参考(反事实基线)",
  "Delete pricing for \"{name}\"?":         "确定删除「{name}」的单价配置?",
  "Edit pricing":                           "编辑单价",
  "Name (matches RemoteStorageName or local-<disk_type>)":
    "名称(匹配 RemoteStorageName 或 local-<disk_type>)",
  "Currency":                               "币种",
  "Storage price ($/TB/month)":             "存储单价($/TB/月)",
  "Egress price ($/TB)":                    "流出流量单价($/TB)",
  "Request price ($ per million)":          "请求单价($/百万次)",
  "Replication factor (cloud-side, leave 1 for local)":
    "副本因子(云侧,本地填 1)",
  "Where this number came from. Helps the next operator who picks up.":
    "这个数字的来源说明,方便后续接手的运维。",
  "Use as hot reference for counterfactual baseline":
    "用作反事实基线的 hot 参考",
  "Exactly one row must be the hot reference. Saving this row clears the flag on any other row.":
    "必须且只能有一行被标为 hot 参考。保存本行时其它行的标记会自动清掉。",
  "Name is required":                       "名称必填",

  // ---- Path migration wizard (/path-migrate, file browser actions) ----
  "Path migration wizard":                  "路径迁移向导",
  "Path migrate":                           "路径迁移",
  "Tier this folder…":                      "对此目录做分层…",
  "Tier this folder":                       "对此目录做分层",
  "Open the path-scoped migration wizard for this directory":
    "为该目录打开路径维度的迁移向导",
  "Pick a path, see its impact, and ask the AI to draft a tiering plan for the data underneath. The wizard never executes migrations directly — proposals open in the Ops console for review.":
    "选一个路径,先看影响范围,然后让 AI 为该路径下的数据起草分层方案。向导本身不直接执行迁移,所有提案都会在 Ops 控制台展开复核。",
  "Glob (filename pattern, e.g. *.log.gz)": "Glob 文件名模式(例如 *.log.gz)",
  "Min file size (MB)":                     "最小文件大小(MB)",
  "Min age (days)":                         "最小存留时长(天)",
  "Recursive (walk subdirectories)":        "递归(深入子目录)",
  "Run preview":                            "运行预览",
  "Capped at 50k entries / depth 12. Filters apply during the walk.":
    "上限 50,000 条 / 深度 12,过滤条件在遍历时直接生效。",
  "No files matched":                       "没有匹配的文件",
  "Walked {n} entries but none matched the filters. Adjust glob / size / age to broaden.":
    "已遍历 {n} 条目但都未命中过滤条件,可放宽 glob / 大小 / 年龄继续筛选。",
  "Impact":                                 "影响范围",
  "walk truncated":                         "遍历被截断",
  "Matched files":                          "匹配文件数",
  "Total bytes":                            "总字节",
  "Oldest mtime":                           "最早修改时间",
  "Newest mtime":                           "最近修改时间",
  "By collection":                          "按 collection",
  "By age":                                 "按年龄",
  "By extension":                           "按扩展名",
  "Sample files ({n})":                     "样例文件({n} 条)",
  "Ask AI to plan the migration":           "请 AI 规划迁移",
  "Preferred target backend (AI may override with rationale)":
    "目标后端(AI 可基于理由覆盖)",
  "Let AI pick":                            "由 AI 选择",
  "Extra context (optional)":               "附加说明(可选)",
  "e.g. 'compliance requires 7-year retention'":
    "例如:「合规要求保留 7 年」",
  "Generate migration plan":                "生成迁移方案",
  "Run preview first so the AI sees the impact numbers.":
    "请先运行预览,AI 才能看到具体的影响数据。",
  "AI migration proposals for {path}":      "针对 {path} 的 AI 迁移建议",
  "The AI didn't find a worthwhile migration for this scope.":
    "AI 没找到值得在该范围内执行的迁移方案。",

  // ---- Replication / Raft panel (/raft) ----
  "Replication & Raft":                     "副本 & Raft",
  "Replication / Raft":                     "副本 / Raft",
  "Master raft quorum + per-volume replication health. Auto-refreshes every 15s.":
    "Master raft 仲裁与卷级副本健康状态,每 15 秒自动刷新。",
  "Loading replication health…":            "正在加载副本健康数据…",
  "Master raft":                            "Master Raft",
  "quorum healthy":                         "仲裁健康",
  "quorum issue":                           "仲裁异常",
  "Leaders observed":                       "观测到的 Leader",
  "single leader (good)":                   "单一 Leader(正常)",
  "no leader (split-brain)":                "没有 Leader(脑裂)",
  "multiple leaders (split-brain)":         "多个 Leader(脑裂)",
  "Leader agreement":                       "Leader 一致性",
  "all masters agree":                      "所有 master 达成一致",
  "masters disagree":                       "master 之间不一致",
  "Peer set agreement":                     "Peer 列表一致性",
  "expected: {n} peers":                    "期望 {n} 个 peer",
  "Peers reported":                         "上报的 Peer",
  "peer(s)":                                "个 peer",
  "Configured master:":                     "已配置 master:",
  "Open masters detail":                    "查看 master 详情",
  "Volume replication":                     "卷副本",
  "all volumes healthy":                    "所有卷健康",
  "{n} need attention":                     "{n} 项需关注",
  "data-loss risk":                         "数据丢失风险",
  "Under-replicated":                       "副本不足",
  "fewer copies than configured":           "实际副本数少于配置",
  "EC at risk":                             "EC 风险",
  "<10 shards observed":                    "观测到分片少于 10",
  "All volumes match their configured replication.":
    "所有卷的副本状态都符合配置。",
  "Open volumes page":                      "打开卷列表页",
  "Severity":                               "严重程度",
  "Observed":                               "实际",
  "Shards observed":                        "观测分片数",
  // unrecoverable + Replication strings reuse existing keys

  // ---- Durability score (/raft overview) ----
  "Durability":                             "持久性",
  "Loading durability score…":              "正在计算持久性评分…",
  "Cluster durability":                     "集群持久性",
  "Rolled up from raft quorum and volume replication risk.":
    "综合 Raft 仲裁与卷副本风险汇总得出。",
  "All durability checks passed.":          "所有持久性检查均通过。",
  // "Healthy" / "Degraded" grade labels reuse the existing keys above.
  "At risk":                                "存在风险",
  "Critical":                               "严重",
  "Quorum":                                 "仲裁",
  "No raft leader":                         "没有 Raft Leader",
  "Split-brain: multiple raft leaders":     "脑裂:存在多个 Raft Leader",
  "{n} master(s) unreachable":              "{n} 个 master 不可达",
  "Masters disagree on the leader":         "master 之间对 Leader 不一致",
  "Masters disagree on the peer set":       "master 之间对 Peer 列表不一致",
  "{n} sole-copy volume(s) below policy":   "{n} 个孤本卷低于副本策略",
  "{n} EC volume(s) with too few shards":   "{n} 个 EC 卷分片不足",
  "{n} under-replicated volume(s)":         "{n} 个卷副本不足",
  "Single-copy volumes":                    "单副本卷",
  "data-loss exposure":                     "数据丢失敞口",
  "below configured policy":                "低于配置策略",

  // ---- AI migration-policy advisor (/policies) ----
  "AI advice":                              "AI 建议",
  "AI migration advice":                    "AI 迁移建议",
  "Analyses volume temperature and proposes migration policies you can review and save.":
    "分析卷的访问温度,给出可审阅并保存的迁移策略建议。",
  "Re-analyse":                             "重新分析",
  "Analysing volume temperature…":          "正在分析卷温度…",
  "This can take a few seconds.":           "这可能需要几秒钟。",
  "AI analysis failed.":                    "AI 分析失败。",
  "No migration is worth recommending right now.":
    "当前没有值得推荐的迁移。",
  "Generated by":                           "生成自",
  "Use this draft":                         "用此建议",
  "Est. impact":                            "预计影响",

  // ---- AI volume-balance advice (balance dialog) ----
  "AI balance advice":                      "AI 平衡建议",
  "Analysing volume distribution…":         "正在分析卷分布…",
  "Cluster is already balanced — no run needed.":
    "集群已均衡 —— 无需执行。",
  "Apply to form":                          "填入表单",
  "balance:balanced":                       "已均衡",
  "balance:minor":                          "轻微倾斜",
  "balance:significant":                    "明显倾斜",
  "balance:severe":                         "严重倾斜",

  // ---- AI proposal: Create as Task ----
  "Task created":                           "已创建任务",
  "Awaiting approval in the Tasks queue.":  "已加入任务队列,等待审批。",
  "Duplicate task":                         "已存在重复任务",
  "An active task already exists for this volume + target.":
    "针对该卷与目标的活动任务已存在。",
  "Create task failed":                     "创建任务失败",
  "Open created task":                      "打开已创建任务",
  "Create as Task":                         "创建为任务",
  "Create a pending Task from this proposal. Approval is still required to execute.":
    "基于此提案创建一个 pending 任务,执行前仍需审批。",

  // ---- Policy time-machine ----
  "Policy time machine":                    "策略时光机",
  "Simulate against current cluster state": "针对当前集群状态做模拟",
  "Pick a cluster in the top-right before simulating.":
    "模拟前请在右上角选择集群。",
  "Simulating against live cluster state…":  "正在针对当前集群状态模拟…",
  "This is a dry-run against current state. No volumes are migrated.":
    "这是一次基于当前状态的演练,不会真实迁移任何卷。",
  "Considered":                             "纳入考量",
  "in scope":                               "处于策略作用域",
  "Would match":                            "将命中",
  "Would skip":                             "将跳过",
  "filtered out":                           "被过滤",
  "Est. monthly saving":                    "预计月节省",
  "set target_backend + hot ref":           "请设置 target_backend + hot reference",
  "Effective params":                       "生效参数",
  "unlimited":                              "无上限",
  "Skip reasons":                           "跳过原因",
  "Matches by collection":                  "按 collection 的命中数",
  "Sample matched volumes ({n})":           "命中样本({n} 个)",
  "Quiet days":                             "静默天数",
  "No volumes match this policy under current state. Adjust params and retry, or wait for more cold data to accumulate.":
    "当前状态下没有卷符合此策略。可调整参数后重试,或等待更多冷数据沉淀。",

  // ---- Run dialog: simulate / dry-run ----
  "Dry-run: read-only commands + analyzer scripts execute against the live cluster; mutating commands are reported but skipped.":
    "演练模式:只读命令和 analyzer 脚本会真实执行,变更类命令仅汇报参数而不会执行。",

  // ---- Task failure / retry ----
  "Auto-retry scheduled at": "自动重试时间",

  // ---- Dashboard operator pulse ----
  "in flight":            "执行中",
  "Failed (24h)":         "失败 (24h)",
  "auto-retrying":        "自动重试中",
  "Monthly savings":      "月度节省",
  "vs. all-hot baseline": "对比全热基线",
  "Coldest collections":  "最冷集合排行",
  "vols_lc":              "卷",

  // ---- i18n bulk fill (skills, health, safety, alerts, executions, AI, cohort, holidays, wall, cluster details) ----

  // Skills pages
  "Fork {key}":           "Fork {key}",
  // (dup of line 541) "New Skill":            "新建技能",
  // (dup of line 550) "Forking a system skill into a custom one. Tweak the steps, then save under a new key.":
  // "从系统技能 Fork 出自定义版本。编辑步骤后以新 key 保存。",
  // (dup of line 548) "Build a Skill the controller can run as a versioned, schema-validated procedure.":
  // "构建一个控制器可作为版本化、Schema 验证流程执行的技能。",
  "Source skill":         "来源技能",
  "not found. Starting from a blank template.": "不存在,从空白模板开始。",
  // (dup of line 505) "Wizard":               "向导",
  // (dup of line 506) "JSON":                 "JSON",
  // (dup of line 507) "Paste":                "粘贴",
  "Skill not found:":     "技能未找到:",
  "DISABLED":             "已禁用",
  // (dup of line 484) "Version history":      "版本历史",
  "Fork this system skill into a custom skill you can edit": "将此系统技能 Fork 为可编辑的自定义技能",
  // (dup of line 543) "Fork to custom":       "Fork 为自定义",
  // (dup of line 576) "Parameters":           "参数",
  "default:":             "默认:",
  // (dup of line 577) "Preconditions":        "前置条件",
  // (dup of line 578) "Steps":                "步骤",
  // (dup of line 298) "Rollback":             "回滚",
  // (dup of line 580) "Postchecks":           "后置检查",
  // (dup of line 581) "Raw JSON":             "原始 JSON",
  "fatal":                "致命",
  "SeaweedFS":            "SeaweedFS",
  "internal":             "内部",
  "timeout":              "超时",
  "on_failure:":          "失败时:",
  "retry:":               "重试:",
  "args:":                "参数:",
  "Failed to load skills.": "加载技能失败。",
  "Skill":                "技能",
  "not found.":           "未找到。",
  // (dup of line 552) "This is a system skill": "这是一个系统技能",
  "ships with the controller and cannot be modified in place. Fork it into a custom skill — your forked copy is fully editable and runs in place of the system one if the engine resolves your custom key first.":
                          "随控制器内置,无法就地修改。可 Fork 为自定义技能 —— 你的副本完全可编辑,引擎优先解析自定义 key 时会替代系统版本。",
  // (dup of line 572) "Saving creates a new version. The latest version is what runs.":
  // "保存即创建新版本,最新版本会被实际执行。",
  "Failed to load history.": "加载历史失败。",
  // (dup of line 483) "History":              "历史",
  "No history for {name} yet.": "{name} 暂无历史记录。",
  "Version list":         "版本列表",
  "no note":              "无备注",
  "set left":             "设为左侧",
  "set right":            "设为右侧",
  "v{n} (left)":          "v{n}(左)",
  "v{n} (right)":         "v{n}(右)",
  // (dup of line 998) "steps":                "步骤数",
  "rollback":             "回滚",
  "No runs in last 7 days.": "近 7 天无执行记录。",

  // Health page
  "Health Monitoring":    "健康监控",
  "Add target":           "添加监控目标",
  "Health gate:":         "健康闸门:",
  "OPEN":                 "开启",
  "CLOSED":               "关闭",
  "Scheduler is allowed to start new migration tasks.": "调度器允许启动新迁移任务。",
  "Scheduler will refuse to start new tasks. Reason: {reason}": "调度器将拒绝启动新任务。原因: {reason}",
  // (dup of line 1434) "unknown":              "未知",
  // (dup of line 905) "Kind":                 "类型",
  "State":                "状态",
  "Failures":             "失败次数",
  // (dup of line 1416) "Latency":              "延迟",
  "Last error":           "最近错误",
  "Gating":               "闸门作用",
  "Last check":           "最近检测",
  "gates":                "闸控",
  "info":                 "仅提示",
  "Delete target {name}?": "删除监控目标 {name}?",
  // (dup of line 517) "No monitor targets":   "暂无监控目标",
  "Probes hit master / volume / s3 endpoints and gate tiering when they fail.":
                          "探针检查 master / volume / s3 端点,失败时闸住分层。",
  "healthy":              "健康",
  "degraded":             "降级",
  "Edit target":          "编辑监控目标",
  "URL":                  "URL",
  "PromQL query":         "PromQL 查询",
  "Threshold op":         "阈值操作",
  "Threshold value":      "阈值",
  // (dup of line 1975) "Severity":             "严重度",
  "Interval (s)":         "检测间隔(秒)",
  "Timeout (s)":          "超时(秒)",
  "Fail threshold":       "失败阈值",
  "Recover threshold":    "恢复阈值",
  // (dup of line 926) "Notes":                "备注",
  "Gates scheduler":      "作为调度器闸门",
  "When ON, this target's degraded state will pause the scheduler.":
                          "开启后,此目标降级会暂停调度器。",

  // Safety page
  // (dup of line 32) "Safety":               "安全防护",
  "Emergency stop ENGAGED": "紧急停机已启用",
  "Normal operation":     "正常运行",
  "All auto migrations are paused globally. Manual task runs from /tasks are also blocked by the scheduler.":
                          "所有自动迁移已全局暂停。/tasks 页的手工任务也会被调度器阻断。",
  "Press to immediately freeze every auto and manual migration across all clusters.":
                          "点击立即冻结所有集群的自动与手工迁移。",
  "Overall verdict:":     "总体裁决:",
  "Why are you releasing the stop?": "解除停机的原因?",
  "Why are you engaging the stop?":  "启用停机的原因?",
  "Release emergency stop?": "解除紧急停机?",
  "ENGAGE emergency stop?":  "启用紧急停机?",
  "Release":              "解除",
  "Engage stop":          "启用停机",
  "Blocklist":            "黑名单",
  "Resources permanently blocked from migration (finance / compliance / live drills). Match: exact or * prefix/suffix wildcard.":
                          "永久禁止迁移的资源(财务 / 合规 / 现网演练)。匹配:精确或 * 前后缀通配。",
  // (dup of line 979) "Scope":                "范围",
  "Pattern":              "匹配模式",
  // (dup of line 318) "Actions":              "操作",
  // (dup of line 177) "Reason":               "原因",
  "Expires":              "到期",
  "all":                  "全部",
  "never":                "永不",
  "Delete {kind}={value}?": "删除 {kind}={value}?",
  "No blocklist entries": "黑名单为空",
  "Block specific collections, buckets, or volumes from automated actions.":
                          "禁止特定 collection / bucket / 卷的自动化操作。",
  "Edit block":           "编辑黑名单",
  "Add block":            "新增黑名单",
  // (dup of line 973) "Scope kind":           "范围类型",
  "Pattern (* allowed)":  "匹配模式(允许 *)",
  "Actions (comma; empty=all)": "操作(逗号分隔;空=全部)",
  "Expires (ISO, blank=never)": "到期(ISO 时间,空=永不)",
  "Maintenance windows":  "维护窗口",
  "Scheduled maintenance windows. The scheduler refuses to run during these.":
                          "已排定的维护窗口。窗口期内调度器拒绝执行。",
  // (dup of line 1798) "Cluster":              "集群",
  "Starts":               "开始",
  "Ends":                 "结束",
  "ACTIVE":               "进行中",
  // (dup of line 988) "global":               "全局",
  "No maintenance windows": "暂无维护窗口",
  "Schedule windows when the controller should hold back automated work.":
                          "排定控制器应暂停自动化工作的时段。",
  "Edit window":          "编辑窗口",
  "Add window":           "新增窗口",
  "Starts at":            "开始时间",
  "Ends at":              "结束时间",
  "Cluster ID (blank=global)": "集群 ID(空=全局)",

  // Alerts page
  // (dup of line 31) "Alerts":               "告警",
  // (dup of line 997) "events":               "事件",
  "channels":             "通道",
  "rules":                "规则",
  "templates":            "模板",
  // (dup of line 405) "Deleted":              "已删除",
  // (dup of line 1666) "Delete failed":        "删除失败",
  "Alert templates":      "告警模板",
  "Reusable subject + body templates. Reference one from an Ops flow's alert config.":
                          "可复用的标题 + 正文模板。可在 Ops 流的告警配置中引用。",
  "Supports Go template syntax — vars:": "支持 Go 模板语法 —— 变量:",
  // (dup of line 205) "New template":         "新建模板",
  "No templates yet":     "暂无模板",
  "Built-in defaults seed on first install. Create one to customise per-flow alert bodies.":
                          "首次安装时会内置默认模板。可创建自定义模板调整流级告警正文。",
  // (dup of line 593) "Description":          "描述",
  "Title preview":        "标题预览",
  // (dup of line 80) "Name required":        "名称必填",
  // (dup of line 157) "Saved":                "已保存",
  // (dup of line 1681) "Save failed":          "保存失败",
  "Preview failed":       "预览失败",
  "Edit alert template":  "编辑告警模板",
  "New alert template":   "新建告警模板",
  "Severity (default — flow config may override)": "严重度(默认 —— 流配置可覆盖)",
  "Title template":       "标题模板",
  "(Go text/template)":   "(Go text/template)",
  "Body template":        "正文模板",
  "(markdown + Go template)": "(markdown + Go 模板)",
  "Preview with sample vars": "使用示例变量预览",
  // (dup of line 1668) "Title":                "标题",
  "(empty)":              "(空)",
  "Body":                 "正文",
  // (dup of line 951) "Saving…":              "保存中…",
  "Time":                 "时间",
  // (dup of line 1112) "Source":               "来源",
  "Delivered":            "已投递",
  "Suppressed":           "已抑制",
  // (dup of line 492) "yes":                  "是",
  // (dup of line 493) "no":                   "否",
  // (dup of line 524) "No alert events yet":  "暂无告警事件",
  "Recent triggers from monitoring rules will show up here.":
                          "监控规则触发的事件会在此显示。",
  "Add channel":          "新增通道",
  "Severities":           "严重度",
  "Rate/hr":              "速率/小时",
  // (dup of line 525) "No channels configured": "未配置任何通道",
  "Add a Slack / webhook / email destination so alerts have somewhere to go.":
                          "添加 Slack / Webhook / 邮件目的地,让告警有去处。",
  "Test alert":           "测试告警",
  "Triggered from console — please confirm receipt.": "从控制台触发 —— 请确认收到。",
  "Test alert queued. Check the Events tab + your channel.":
                          "测试告警已入队。请到事件标签页与你的通道确认。",
  // (dup of line 934) "Test":                 "测试",
  "Add rule":             "新增规则",
  "Event":                "事件",
  "Min sev":              "最低严重度",
  "Channels":             "通道",
  "Silence":              "静默",
  // (dup of line 526) "No alert rules yet":   "暂无告警规则",
  "Rules turn metric thresholds into events sent to channels.":
                          "规则将指标阈值转化为发送到通道的事件。",
  "Edit channel":         "编辑通道",
  "Config (JSON)":        "配置(JSON)",
  "Severities (comma)":   "严重度(逗号分隔)",
  "Rate per hour (0=∞)":  "每小时速率(0=不限)",
  "Edit rule":            "编辑规则",
  "Event kind":           "事件类型",
  "Source match (* = all)": "来源匹配(* = 全部)",
  "Min severity":         "最低严重度",
  "Silence (s)":          "静默(秒)",
  "No channels yet — create one first.": "暂无通道 —— 请先创建。",

  // Executions list page
  // (dup of line 29) "Executions":           "执行历史",
  "Task":                 "任务",
  // (dup of line 749) "Created":              "创建于",
  // (dup of line 519) "No executions yet":    "暂无执行记录",
  "When tasks run, their step-by-step output and AI postmortem land here.":
                          "任务执行后,逐步输出与 AI 复盘会汇集于此。",

  // Executions detail extras
  "Legacy execution log (no Skill metadata) — see raw log below.":
                          "旧版执行日志(无 Skill 元数据)—— 请查看下方原始日志。",
  "Raw log":              "原始日志",

  // AI Providers config
  // (dup of line 793) "AI Providers":         "AI 服务商",
  "Works with OpenAI, Anthropic Claude, DeepSeek, Ollama, and any OpenAI-compatible gateway.":
                          "支持 OpenAI、Anthropic Claude、DeepSeek、Ollama 及任意 OpenAI 兼容网关。",
  "API keys are encrypted at rest in PostgreSQL with AES-GCM.":
                          "API key 通过 AES-GCM 加密存储于 PostgreSQL。",
  "Active:":              "活跃:",
  "Tool authorization":   "工具授权",
  // (dup of line 498) "Add provider":         "新增服务商",
  "Delete provider \"{name}\"?": "删除服务商 \"{name}\"?",
  "Tools and skills bound to this provider will fall back to the default. You can recreate it later.":
                          "绑定此服务商的工具和技能会回落到默认。后续可重新创建。",
  // (dup of line 523) "No AI providers configured": "未配置 AI 服务商",
  "Click \"Add provider\" above to wire OpenAI, Anthropic, or another vendor.":
                          "点击上方\"新增服务商\"接入 OpenAI、Anthropic 等。",
  "default":              "默认",
  "(disabled)":           "(已禁用)",
  // (dup of line 800) "not tested":           "未测试",
  // (dup of line 108) "OK":                   "正常",
  "FAIL":                 "失败",
  // (dup of line 496) "Test connection":      "测试连接",
  // (dup of line 497) "Set as default":       "设为默认",
  "API key stored encrypted": "API key 已加密存储",
  // (dup of line 797) "encrypted":            "已加密",
  "Read from env var {name}": "从环境变量 {name} 读取",
  "env":                  "环境变量",
  // (dup of line 798) "no credentials":       "无凭证",
  // (dup of line 799) "Not configured":       "未配置",
  "save failed":          "保存失败",
  // (dup of line 499) "Edit provider":        "编辑服务商",
  // (dup of line 500) "New provider":         "新建服务商",
  // (dup of line 489) "Close":                "关闭",
  // (dup of line 801) "Vendor":               "厂商",
  "Model":                "模型",
  "Base URL":             "Base URL",
  "https://api.anthropic.com (blank = official endpoint)":
                          "https://api.anthropic.com (空 = 官方端点)",
  "API key (e.g. {hint})": "API key (例如 {hint})",
  "API key":              "API key",
  "Stored — blank keeps it, fill to replace": "已存储 —— 留空保留,填入则替换",
  "Paste API key":        "粘贴 API key",
  "Encrypted at rest with AES-GCM; never visible to the UI again. Or use an env var ↓":
                          "使用 AES-GCM 加密存储,之后界面不再可见。或使用环境变量 ↓",
  "Or: env var name":     "或:环境变量名",
  "Clear the stored encrypted key, fall back to env var":
                          "清除已存加密 key,回落到环境变量",

  // AI counterfactual learning
  // (dup of line 806) "AI counterfactual learning": "AI 反事实学习",
  "After {h}h we look back at actual access and auto-grade whether the verdict was right.":
                          "{h} 小时后回看实际访问,自动评判裁决是否正确。",
  "Thresholds live under Settings → ai_review.*": "阈值位于 系统配置 → ai_review.*",
  // (dup of line 807) "Total verdicts":       "裁决总数",
  // (dup of line 808) "Correct":              "正确",
  // (dup of line 809) "Accuracy":             "准确率",
  // (dup of line 810) "Observation window":   "观测窗口",
  // (dup of line 811) "By provider":          "按服务商",
  "No annotations yet —": "暂无标注 ——",
  "wait {n} day(s) after tasks run.": "请在任务执行 {n} 天后查看。",
  // (dup of line 813) "Provider":             "服务商",
  // (dup of line 631) "By business domain":   "按业务域",
  // (dup of line 512) "No annotations yet.":  "暂无标注。",
  // (dup of line 812) "Recent annotations":   "最近标注",
  // (dup of line 511) "No annotations yet":   "暂无标注",
  "Operator feedback on past AI verdicts will accumulate here.":
                          "运维对历史 AI 裁决的反馈会在此累积。",
  // (dup of line 814) "Verdict":              "裁决",
  // (dup of line 815) "Samples":              "样本数",
  // (dup of line 816) "Avg conf":             "平均置信度",
  "PROCEED":              "执行",
  "ABORT":                "终止",
  "NEEDS HUMAN":          "需人工",
  // (dup of line 817) "Domain":               "业务域",
  "re-warmed":            "被重新激活",

  // Cohort page
  // (dup of line 820) "Cohort overview":      "同业横比概览",
  "Cross-business-domain comparison": "跨业务域对比",
  // (dup of line 1114) "volumes":              "卷",
  "cohorts":              "横比组",
  "anomalies":            "异常",
  // (dup of line 481) "Running…":             "运行中…",
  // (dup of line 477) "Refresh":              "刷新",
  // (dup of line 494) "All":                  "全部",
  // (dup of line 527) "No cohort baselines yet": "暂无同业基线",
  "Wait for the next analytics pass (~1h) or click Refresh above.":
                          "等待下次分析任务(约 1 小时)或点击上方刷新。",
  "Anomalous volumes (|z| ≥ {n})": "异常卷 (|z| ≥ {n})",
  "No volumes crossed the threshold.": "无卷越过阈值。",
  "Cycle":                "周期",
  "Z-score":              "Z 分数",
  "7d reads":             "7 天读取",
  "reads/byte":           "读/字节",
  // (dup of line 708) "vols":                 "卷",
  "anomaly":              "异常",
  "μ reads/byte":         "μ 读/字节",
  "σ":                    "σ",
  "P50 reads":            "P50 读取",
  "P95 reads":            "P95 读取",
  // (dup of line 821) "Top 3 outliers":       "Top 3 离群值",

  // Holidays page
  "Holiday calendar (CN)": "节假日日历(国内)",
  "Freeze active:":       "冻结生效:",
  // (dup of line 824) "During the pre/post windows of each holiday the executor **auto-pauses** all migration tasks to avoid IO jitter at peak.":
  // "节假日前后窗口期内,执行器**自动暂停**所有迁移任务,避免高峰 IO 抖动。",
  "Each holiday's":       "每个节假日的",
  "is tunable via SQL.":  "可通过 SQL 调整。",
  "Date":                 "日期",
  "Pre window":           "前置窗口",
  "Post window":          "后置窗口",
  "days":                 "天",

  // NOC wall
  "SeaweedFS Tiering NOC": "SeaweedFS 分层 NOC 大屏",
  "Gate CLOSED: {reason}": "闸门关闭:{reason}",
  "Safety: {code}":       "安全防护:{code}",
  // (dup of line 1637) "All clear":            "一切正常",
  // (dup of line 796) "Active":               "活跃",
  // (dup of line 608) "Pending":              "待处理",
  // (dup of line 157) "Saved":                "已节省",
  "Alerts/day":           "告警/天",
  "Migration Flow (last 24h)": "迁移流量(近 24 小时)",
  "Access Trend (24h)":   "访问趋势(24 小时)",
  "Recent alerts":        "最近告警",
  "(untitled alert)":     "(无标题告警)",
  // (dup of line 522) "No active alerts":     "无活跃告警",
  "OPERATIONAL":          "正常运行",
  "DEGRADED":             "降级",
  "No clusters registered.": "未注册任何集群。",

  // Cluster detail permission / topology fallbacks
  // (dup of line 1402) "You do not have permission to view this cluster.":          "你没有查看此集群的权限。",
  "Data centers":         "数据中心",
  // (dup of line 1274) "Nodes":                "节点",
  "Used / Capacity":      "已用 / 容量",
  "used":                 "已使用",
  "Cannot reach SeaweedFS master": "无法连接 SeaweedFS master",
  "topology unavailable": "拓扑不可用",
  "Cluster overview needs live topology from the master. Try again when the master is reachable.":
                          "集群概览需要 master 的实时拓扑。请在 master 可达后重试。",
  "You do not have permission to view this cluster topology.": "你没有查看此集群拓扑的权限。",
  "Topology requires a live master response. Try again when the cluster is reachable.":
                          "拓扑需要 master 实时响应。请在集群可达后重试。",
  // (dup of line 1403) "You do not have permission to use this shell console.":     "你没有使用此 Shell 控制台的权限。",
  "You do not have permission to view cluster tags.":          "你没有查看集群标签的权限。",

  // Misc
  "actor / target / payload": "操作者 / 目标 / 载荷",

  // Merged-page tabs and headers (Activity / AI / S3 / Costs / Admin / Reliability / Cluster maintenance)
  "Activity":                     "活动",
  "What the system is doing and what it has done.": "系统正在做什么,以及已经做过什么。",
  "AI":                           "AI",
  "Provider configuration and counterfactual learning.": "服务商配置与反事实学习。",
  "S3":                           "S3",
  "S3 gateway management: buckets, identities, circuit breaker, and stale-upload cleanup.":
                                  "S3 网关管理:Bucket、身份、熔断器、过期 upload 清理。",
  "S3 gateway management: buckets, table buckets (Iceberg), identities, circuit breaker, and stale-upload cleanup.":
                                  "S3 网关管理:对象桶、表桶(Iceberg)、身份与密钥、限流防护、分片上传清理。",
  // ---- S3 Tables (table buckets / Iceberg) ----
  "Table buckets":                "表桶(Tables)",
  "S3 Tables (Iceberg)":          "S3 Tables(Iceberg 表桶)",
  "scoped by owner account ID":   "按所属账号 ID 隔离",
  "Owner account ID":             "所属账号 ID",
  "Required. AWS-style 12-digit ID or any identifier configured on the cluster.":
                                  "必填。AWS 风格的 12 位数字,或集群里配置的任意账号标识。",
  "Name prefix filter":           "名称前缀过滤",
  "Optional. Leave blank to list all buckets in the account.":
                                  "可选。留空则列出该账号下所有表桶。",
  "New table bucket":             "新建表桶",
  "Enter an owner account ID above to load table buckets.":
                                  "请在上方输入所属账号 ID 以加载表桶列表。",
  "No table buckets in this account.": "该账号下还没有表桶。",
  "Click 'New table bucket' to create one.": "点击\"新建表桶\"创建一个。",
  "ARN":                          "ARN(资源 ID)",
  "Copy ARN":                     "复制 ARN",
  "Bucket policy":                "授权策略",
  "Delete table bucket {n}?":     "删除表桶 {n}?",
  "This removes the table bucket and is not reversible. Namespaces and tables under it must already be deleted.":
                                  "此操作不可恢复。删除前请先删掉表桶下的命名空间和表。",
  "More buckets exist. Pagination not yet wired — narrow with a prefix filter for now.":
                                  "还有更多表桶。分页暂未接入,请用名称前缀过滤来缩小范围。",
  "Could not parse shell output.": "无法解析 shell 输出。",
  "Name must be 3-63 lowercase alphanumerics and hyphens, no leading/trailing hyphen.":
                                  "名称长度 3-63 位,仅允许小写字母、数字和中划线,且不能以中划线开头或结尾。",
  "3-63 chars, lowercase + digits + hyphen. Cannot collide with a regular S3 bucket name.":
                                  "3-63 位,小写字母 + 数字 + 中划线。不能和普通对象桶重名。",
  "Tags":                         "标签",
  "Optional. Comma-separated key=value pairs, e.g. env=prod,team=analytics.":
                                  "可选。逗号分隔的 key=value 列表,例如 env=prod,team=analytics。",
  "Resource policy":              "资源策略",
  "Delete policy on {n}?":        "删除 {n} 的资源策略?",
  "Removes the resource policy. Default access rules will apply afterwards.":
                                  "删除资源策略后,将回退到默认访问规则。",
  "Paste an IAM-style JSON policy here. Leave blank to keep no policy attached.":
                                  "粘贴 IAM 风格的 JSON 授权策略。留空表示不附加任何策略。",
  "Invalid JSON: ":               "JSON 格式有误:",
  "Policy must be valid JSON: ":  "策略必须是合法 JSON:",
  "Delete policy":                "删除策略",
  "Apply policy":                 "应用",
  // ---- Inline explainers for ARN / resource policy ----
  "What is this?":                "这是什么?",
  "ARN = the bucket's globally unique resource ID (\"arn:aws:s3tables:…:bucket/<name>\"). Used by Iceberg engines and IAM policies. For everyday use you only need the name.":
                                  "ARN = 表桶在整个集群里的唯一资源 ID(形如 arn:aws:s3tables:…:bucket/<名称>)。Iceberg 引擎和 IAM 策略需要它。日常使用只看名字即可。",
  "A resource policy is an optional JSON rule attached to this bucket that says \"who can do what\" on it. Most buckets don't need one — leave it empty unless you need cross-account sharing or principal-specific permissions.":
                                  "资源策略是挂在这个表桶上的可选 JSON 规则,用来定义\"谁能对它做什么\"。大多数桶不需要 —— 除非你要做跨账号共享或单独给某个 principal 开权限,否则留空即可。",
  "Show example":                 "查看示例",
  "Hide example":                 "收起示例",
  "Use this as a starting point": "用这个作为起点",
  "Table bucket created":         "表桶已创建",
  "Policy applied":               "策略已应用",
  "Policy deleted":               "策略已删除",
  "Create failed":                "创建失败",
  "Apply policy failed":          "应用失败",
  // ---- Bind credentials dialog (bucket → identity AK/SK) ----
  "Bind credentials (AK/SK)":     "绑定凭据 (AK/SK)",
  "Bind credentials to bucket":   "为桶绑定凭据 (AK/SK)",
  "AK/SK belong to an identity, not a bucket. We'll grant the chosen identity scoped permissions on this bucket (e.g. Read:{n}, Write:{n}). The identity's existing access keys stay unchanged.":
                                  "AK/SK 是挂在 identity(身份)上的,不是挂在桶上的。这里会给选中的 identity 加上对该桶的权限(例如 Read:{n}、Write:{n})。它原有的 AK/SK 不会变。",
  "Loading identities…":          "加载身份列表中…",
  "Use existing identity":        "使用已有身份",
  "Create new identity":          "新建身份",
  "Existing access keys for this identity remain unchanged. Only the action list is updated.":
                                  "该身份原有的 AK/SK 不会改动,只更新权限(actions)列表。",
  "Access key (AK)":              "Access Key (AK)",
  "Secret key (SK)":              "Secret Key (SK)",
  "Permissions on this bucket":   "对该桶的权限",
  "These will be appended to the identity's actions list. Read = GET/HEAD, Write = PUT/POST/DELETE, List = ListBucket, Tagging = read+write tags.":
                                  "这些会追加到身份的 actions 列表里。Read=读取对象、Write=写入/删除、List=列桶、Tagging=读写标签。",
  "Final action list (preview)":  "保存后该身份的完整 actions 列表(预览)",
  "(empty — pick at least one permission)": "(空 —— 至少勾选一种权限)",
  "Create & bind":                "创建并绑定",
  "Grant access":                 "授予访问权限",
  "Identity created and bound":   "身份已创建并绑定",
  "Bucket access granted":        "桶访问权限已授予",
  "Bind failed":                  "绑定失败",
  // ---- Owner field help (Change owner dialog) ----
  "Owner is a metadata label only. Access is controlled by the identity's actions (e.g. Read:<bucket>), not by who owns the bucket.":
                                  "所有者只是一个元数据标记。真正控制访问的是该身份的 actions(例如 Read:<bucket>),而不是谁\"拥有\"这个桶。",
  "Could not load options":       "无法加载选项",
  "Pick one…":                    "请选择…",
  // ---- Bucket panel: model explainer + Bound access column ----
  "How does access control work? (read me first)": "S3 桶的访问控制是怎么工作的?(强烈建议先看)",
  "SeaweedFS S3 is identity-centric. Access keys and permissions live on identities, not on buckets.":
                                  "SeaweedFS S3 是以身份(identity)为核心的:AK/SK 和权限都挂在身份上,不在桶上。",
  "Bound access":                 "可访问凭据",
  "identities whose actions include Read:<bucket> / Write:<bucket>. This is what actually controls who can read/write.":
                                  "actions 里写了 Read:<bucket> / Write:<bucket> 的那些身份。这才是真正决定谁能读写的东西。",
  "a metadata label naming a single identity as the bucket's nominal owner. Affects ListAllMyBuckets and default ACL only — it does NOT grant access by itself.":
                                  "只是一个名称标签,指向一个\"名义所有者\"身份。只影响 ListAllMyBuckets 和默认 ACL,本身不授予任何访问权限。",
  "(metadata)":                   "(仅元数据)",
  "Identities whose actions list grants access on this bucket. This is the real authorization signal.":
                                  "actions 里授予了对此桶访问权限的身份。这才是真正的授权信号。",
  "Metadata label only — does not grant access. Real access is in 'Bound access'.":
                                  "仅元数据,不授予访问权限。真正的访问权限看\"可访问凭据\"列。",
  "No identity currently has access to this bucket.": "目前没有任何身份能访问这个桶。",
  "Bind…":                        "绑定…",
  "no key":                       "无 AK",
  "Hide access key":              "隐藏 AK",
  "Show access key":              "显示 AK",
  "These identities have bare verbs (no bucket scope) — they apply to every bucket. Tighten with Read:<bucket> if not intended.":
                                  "这些身份的 actions 是裸的(没有指定 bucket),会对所有桶生效。如非本意,请改成 Read:<bucket> 等带桶名的写法。",
  "+{n} with global access":      "另有 {n} 个身份拥有全局权限",
  // ---- Global-access NoticeChip (panel-level summary) ----
  "{n} identity has access to all buckets":
                                  "{n} 个身份可以访问所有桶",
  "Identities with cluster-wide access":
                                  "对全集群有访问权限的身份",
  "These identities have unscoped verbs (e.g. \"Read\" instead of \"Read:my-bucket\"), which means they can act on every bucket in the cluster. This may be intentional (admin / service account) or accidental (a bucket-scope was forgotten).":
                                  "这些身份的动作没有限定到桶(例如 \"Read\" 而不是 \"Read:my-bucket\"),意味着它们对集群里**每个**桶都生效。可能是有意的(管理员 / 服务账号),也可能是忘了加 bucket 限定。",
  "To tighten: edit the identity and replace bare verbs with scoped form like \"Read:<bucket>\".":
                                  "如要收紧:编辑该身份,把无限定的动作改成 \"Read:<bucket>\" 这种形式。",
  "Copy access key":              "复制访问密钥",
  "Copy secret key":              "复制保密密钥",
  "Create":                       "创建",
  // ---- Inline name validation hints (S3 / S3 Tables) ----
  "Name must be at least 3 characters.":   "名称至少 3 个字符。",
  "Name must be at most 63 characters.":   "名称最多 63 个字符。",
  "Underscores aren't allowed in bucket names — use hyphens instead, e.g. \"iceberg-catalog\".":
                                  "桶名不能包含下划线 _,改用短横线 - ,例如 \"iceberg-catalog\"。",
  "Bucket names must be all lowercase.":   "桶名必须全部小写。",
  "Only lowercase letters, digits, and hyphens are allowed.":
                                  "只允许小写字母、数字和短横线。",
  "Only lowercase letters, digits, hyphens and dots are allowed.":
                                  "只允许小写字母、数字、短横线和点号。",
  "Name can't start or end with a hyphen.":
                                  "名称不能以短横线开头或结尾。",
  // ---- AccountBar popover ----
  "No accounts used yet. Type one below.":
                                  "还没用过任何账号,从下方输入一个。",
  "Add new":                      "添加新账号",
  "Use":                          "使用",
  "{u} can now {v} on {b}. Look for it in the 'Bound access' column.":
                                  "{u} 现在可以对 {b} 执行 {v}。请查看\"可访问凭据\"列。",
  // ---- Identity dialog: silent-drop fix ----
  "\"{x}\" is not added yet — press Enter or click Add. We'll auto-add it on Save.":
                                  "\"{x}\" 还没有加入列表 —— 按回车或点 Add。保存时会自动帮你加上。",
  "Secret key is required when setting a new access key.": "设置新 AK 时必须同时填 SK。",
  "{n} action(s): {a}":           "{n} 条权限:{a}",
  "No actions — this identity cannot access any bucket yet.": "无权限 —— 这个身份目前还不能访问任何桶。",
  // ---- AI policy assistant (popover form) — most keys reuse the
  // pre-existing AI panel translations defined later in this file. ----
  "AI assist":                    "AI 助手",
  "AI policy assistant — describe access in plain English and review a proposed identity.":
                                  "AI 策略助手 —— 用大白话描述访问意图,AI 会给你一份建议的身份配置等你审核。",
  "Describe your access goal in plain English. The AI will propose a minimal IAM policy — you must review and approve before it is applied.":
                                  "用大白话描述你的访问意图。AI 会给你一份最小化的 IAM 策略 —— 你必须先审核确认才会落库。",
  "read-only access to logs-* buckets, no delete":
                                  "对 logs-* 系列桶只读,不允许删除",
  "Approve & create":             "采纳并创建",
  "Just bound":                   "刚刚绑定",
  "Just bound \"{u}\" but not visible yet — try Refresh.":
                                  "刚刚绑定了 \"{u}\",但列表还没看到 —— 试试点 Refresh 刷新。",
  // ---- BoundAccessCell redesign (AK/SK + verb tags) ----
  "Reveal secret key":            "显示 Secret Key",
  "Hide secret key":              "隐藏 Secret Key",
  "Need s3.configure (admin) to view secret keys.":
                                  "查看 Secret Key 需要 s3.configure(管理员)权限。",
  "Secret key not found for this AK on the cluster.":
                                  "在集群上找不到该 AK 对应的 Secret Key。",
  "no access key":                "无 Access Key",
  "Show {n} more":                "再展开 {n} 条",
  // ---- Policy editor (dual-mode visual/JSON) ----
  "Visual":                       "可视化",
  "Uses features not shown here": "包含可视化无法展示的字段",
  "This policy uses features the visual editor can't display.":
                                  "这条策略包含可视化编辑器无法展示的字段",
  "Examples: Condition blocks, NotAction/NotResource, Service principals, or array Resources. Switch to JSON tab to edit, or delete it and rebuild here.":
                                  "比如 Condition 条件、NotAction/NotResource、Service 主体、或数组形式的 Resource。请切到 JSON 标签编辑,或者清空策略后在这里重建。",
  "No policy attached. Most buckets don't need one.":
                                  "没有附加策略,大多数桶都不需要。",
  "Add a rule":                   "添加一条规则",
  "Add another rule":             "再加一条规则",
  "Rule {n} of {total}":          "规则 {n} / {total}",
  "Remove rule":                  "删除该规则",
  "Effect":                       "效果",
  "Allow":                        "允许",
  "Deny":                         "拒绝",
  "Who":                          "授权对象",
  "AWS account ID, IAM user ARN, or * for everyone":
                                  "AWS 账号 ID、IAM 用户 ARN,或 * 表示所有人",
  "Examples: 123456789012 (whole account) · arn:aws:iam::123456789012:user/analyst · *":
                                  "举例:123456789012(整个账号)· arn:aws:iam::123456789012:user/analyst · *",
  "Advanced (resource scope, custom actions)":
                                  "高级(自定义资源范围 / 额外动作)",
  "Resource ARN":                 "资源 ARN",
  "Extra actions (comma separated)":
                                  "额外动作(逗号分隔)",
  "Use this for permissions not covered by the checkboxes above.":
                                  "上面没列出的细粒度权限可以填在这里。",
  "List & browse":                "浏览(List)",
  "See namespaces and tables in this bucket":
                                  "查看桶里的 namespace 和表",
  "Read data":                    "读取数据(Read)",
  "Query table contents and metadata":
                                  "查询表数据和元数据",
  "Write data":                   "写入数据(Write)",
  "Create namespaces/tables, append rows, update metadata":
                                  "创建 namespace/表、写入数据、更新元数据",
  "Drop tables or whole namespaces — destructive":
                                  "删除表或整个 namespace —— 不可恢复",
  "Manage this policy":           "管理本策略",
  "Edit or remove the resource policy itself":
                                  "修改或删除本资源策略本身",
  "Paste an IAM-style JSON policy here. Leave blank to detach.":
                                  "粘贴 IAM 风格的 JSON 策略,留空则解除绑定",
  "Bucket permissions":           "桶访问授权",
  "Optional. Use this to let other AWS accounts or specific IAM users access this table bucket. Leave empty if only the owner account needs access — that's the default.":
                                  "可选。用来让别的 AWS 账号或具体的 IAM 用户访问这个 Table 桶。如果只有本账号需要用,留空即可(默认就是这样)。",
  "No policy to delete":          "当前没有策略可删",
  // ---- Identities panel: batch ops + compact toolbar ----
  "identities":                   "个身份",
  "Filter by name…":              "按名称过滤…",
  "No identities match the filter.": "没有符合条件的身份。",
  "{n} selected":                 "已选 {n} 项",
  "Deleting {cur}/{total}: {name}": "正在删除 {cur}/{total}:{name}",
  "Delete {n}":                   "删除 {n} 项",
  "Select all":                   "全选",
  "Select {n}":                   "选中 {n}",
  "Delete {n} identity?":         "确认删除 {n} 个身份吗?",
  "This permanently removes the identities and all their access keys. Anyone using those AK/SK pairs will be immediately denied.":
                                  "这将永久删除这些身份和它们的全部 AK/SK。正在用这些凭据的客户端会立刻被拒绝访问。",
  "Identities ({n})":             "身份 ({n})",
  "Delete {n} identity":          "删除 {n} 个身份",
  "Deleted {n} identity":         "已删除 {n} 个身份",
  "Failed to delete any identity":"全部删除失败",
  "Deleted {ok} identity, {fail} failed":
                                  "成功删除 {ok} 个,{fail} 个失败",
  // ---- NoticeChip summaries (collapsed warning banners) ----
  "{n} stale":                    "{n} 个过期",
  "{n} unknown":                  "{n} 个未知",
  "Parse warning":                "解析告警",
  "Could not parse identities":   "无法解析身份列表",
  "The shell returned output that didn't fit the expected schema. Showing an empty list. Raw error:":
                                  "shell 返回的输出不符合预期格式,列表已置空。原始错误:",
  "Bindings unreadable":          "无法读取绑定",
  "Scan failed":                  "扫描失败",
  "Lifecycle scan error":         "生命周期扫描错误",
  // ---- S3 Tables drill-down (buckets / namespaces / tables / tags) ----
  "Account":                      "账号",
  "name prefix filter…":          "按前缀过滤…",
  "Danger":                       "危险操作",
  "Table bucket · {a}":           "Table 桶 · {a}",
  "Namespace in":                 "命名空间属于",
  "namespaces in {b}":            "{b} 下的命名空间",
  "tables in {ns}":               "{ns} 下的表",
  "New namespace":                "新建 Namespace",
  "New table":                    "新建表",
  "Inside bucket":                "所属 bucket",
  "Owner account":                "所属账号",
  "Version token":                "版本令牌",
  "Format":                       "格式",
  "Tags (optional)":              "标签(可选)",
  "Tag key cannot be empty.":     "标签 key 不能为空。",
  "Tag keys/values cannot contain ',' or '='.":
                                  "标签 key/value 不能包含 ',' 或 '='。",
  "Tags saved":                   "标签已保存",
  "Tags are AWS-style key=value labels. Use them for billing, ownership tracking, or to drive automation. They don't grant access.":
                                  "标签是 AWS 风格的 key=value 标识。用于计费归属、权属跟踪、自动化触发。它本身不授予任何权限。",
  "No tags yet.":                 "暂无标签。",
  "Add tag":                      "新增标签",
  "Add another":                  "再加一条",
  "Remove tag":                   "删除标签",
  "Save tags":                    "保存标签",
  "key":                          "键",
  "value":                        "值",
  "Delete namespace {n}?":        "确认删除 namespace {n} 吗?",
  "All tables in this namespace must already be deleted. This action is not reversible.":
                                  "该 namespace 下必须没有 table。本操作不可恢复。",
  "Delete namespace":             "删除 namespace",
  "Namespace created":            "Namespace 已创建",
  "New namespace in {b}":         "在 {b} 下新建 namespace",
  "Alphanumerics, hyphens and underscores. 1-255 chars.":
                                  "字母数字、连字符、下划线,1-255 字符。",
  "No namespaces in this bucket yet.":
                                  "这个 bucket 还没有 namespace。",
  "Delete table {n}?":            "确认删除表 {n} 吗?",
  "All data and metadata for this table will be removed. This is not reversible.":
                                  "该表的所有数据和元数据都会被清除,不可恢复。",
  "Delete table":                 "删除表",
  "Table created":                "表已创建",
  "New table in {ns}":            "在 {ns} 下新建表",
  "No tables in this namespace yet.":
                                  "这个 namespace 还没有表。",
  "Destructive actions":          "危险操作",
  "Permanent. Cannot be undone.": "永久操作,不可恢复。",
  "Delete bucket {n}?":           "确认删除 bucket {n} 吗?",
  "All namespaces and tables under this bucket must already be deleted. This is not reversible.":
                                  "该 bucket 下的所有 namespace 和 table 必须已被删除,操作不可恢复。",
  "Remove policy?":               "确认移除该策略?",
  // ---- S3 Tables tree-layout refresh ----
  "Start with an owner account":  "先填一个所属账号",
  "S3 Tables groups every bucket / namespace / table under an \"owner account\" — usually an AWS-style 12-digit ID. The shell commands require it for every action, so we ask once upfront. The browser remembers it for next time.":
                                  "S3 Tables 把所有 bucket / namespace / table 都挂在一个\"所属账号\"下,通常是 AWS 风格的 12 位 ID。shell 命令每次都要,所以先问一次。浏览器会记住,下次不用再填。",
  "Continue":                     "继续",
  "Recent":                       "最近",
  "More create options":          "更多创建选项",
  "Click to change account":      "点击切换账号",
  "Viewing account":              "查看账号",
  "not set — click to pick one":  "未设置 — 点击选择",
  "Click to switch the viewing account. This doesn't move data — it just changes which account's resources are listed.":
                                  "点击切换查看账号 —— 不会移动任何数据,只是切换列出哪个账号的资源。",
  "This is a viewing filter — it tells the panel which account's resources to load. You can also pick an account directly when creating a bucket.":
                                  "这只是一个查看过滤器 —— 决定加载哪个账号的资源。创建 bucket 时也可以单独指定账号。",
  "No viewing account picked yet.": "尚未选择查看账号。",
  "Click \"+ New bucket\" on the right to create one — you'll set its account in that dialog.":
                                  "点右上角 \"+ 新建桶\" 创建一个 —— 在对话框里指定它的账号。",
  "Owner account is required.":   "所属账号必填。",
  "Permanent. The bucket's owner cannot be changed after creation.":
                                  "永久属性。bucket 的所属账号在创建后无法更改。",
  "This account becomes the bucket's permanent owner — moving a bucket between accounts is not supported.":
                                  "这个账号将成为 bucket 的永久所属账号 —— 不支持把 bucket 转移到其他账号。",
  "Bucket names cannot be changed after creation.": "bucket 名称创建后不可更改。",
  "A bucket's owner is set at creation and cannot be changed. To move data, create a new bucket under the new account and copy the contents.":
                                  "bucket 的所属账号在创建时确定,之后无法更改。如需迁移数据,请在新账号下创建一个新 bucket 并复制内容过去。",
  "ARN is derived from owner + name. Both are immutable, so ARN is too.":
                                  "ARN 由 owner + name 推导而来。两者都不可变,所以 ARN 也不可变。",
  "Namespace names cannot be changed after creation.":
                                  "namespace 名称创建后不可更改。",
  "Inherited from the parent bucket; can't be changed independently.":
                                  "继承自父 bucket,无法独立更改。",
  "A namespace cannot be moved between buckets.":
                                  "namespace 无法在 bucket 之间迁移。",
  "Table names cannot be changed after creation.":
                                  "表名创建后不可更改。",
  "Tables cannot be moved between namespaces.":
                                  "表无法在 namespace 之间迁移。",
  "Inherited from the bucket; can't be changed independently.":
                                  "继承自 bucket,无法独立更改。",
  "\"{n}\" is already taken by a regular S3 bucket. Table buckets share the global S3 namespace — pick a different name.":
                                  "\"{n}\" 已被一个普通 S3 桶占用。Table 桶和普通桶共用全局命名空间 —— 换一个名字试试。",
  "\"{n}\" already exists in this account. Pick a different name.":
                                  "\"{n}\" 在该账号下已存在,请换一个名字。",
  "\"{n}\" already exists in this bucket. Pick a different name.":
                                  "\"{n}\" 在这个 bucket 下已存在,请换一个名字。",
  "\"{n}\" already exists in this namespace. Pick a different name.":
                                  "\"{n}\" 在这个 namespace 下已存在,请换一个名字。",
  // ---- Combined create-bucket-with-access wizard ----
  "DNS-compatible: lowercase + digits + . - · 3-63 chars.":
                                  "DNS 兼容:小写字母 + 数字 + . - · 3-63 字符。",
  "Optional. Leave blank for no quota.": "可选,留空表示不限。",
  "Grant access (optional)":      "授权访问(可选)",
  "create new identity":          "新建身份",
  "use existing identity":        "选择已有身份",
  "Without this, the bucket has no AK/SK pair attached — only the admin (root) can access it. Most operators want at least one identity bound at create time.":
                                  "不勾选则桶不绑定任何 AK/SK —— 只有 admin (root) 能访问。一般建议至少绑一个身份。",
  "Use existing":                 "选已有",
  "Skip":                         "跳过",
  "New actions will be appended to this identity's existing list.":
                                  "新动作会追加到这个身份原有的动作列表里。",
  "Regenerate AK/SK":             "重新生成 AK/SK",
  "Copy SK":                      "复制 SK",
  "Copy this Secret Key now — it's only fully visible right after creation.":
                                  "立刻复制 SK —— 只在创建后这一次完整显示。",
  "Scoped to bucket {b}: e.g. Read:{b}, Write:{b}.":
                                  "限定到桶 {b}:形如 Read:{b}、Write:{b}。",
  "Pick an identity from the list.": "请从列表选择一个身份。",
  "Identity name: 1-64 chars, alphanumerics + . _ -":
                                  "身份名:1-64 字符,字母数字 + . _ -",
  "Access key required.":         "访问密钥必填。",
  "Secret key required.":         "保密密钥必填。",
  "Pick at least one permission to grant.":
                                  "至少选一个要授予的权限。",
  "Equivalent commands (Apply)":  "对应命令(执行)",
  "Bucket created":               "桶已创建",
  "{u} can now {v} on {b}.":      "{u} 现在可以 {v} 桶 {b} 了。",
  "Granted {v} on {b} to {u}.":   "已把桶 {b} 的 {v} 权限授予 {u}。",
  "Bucket \"{n}\" already exists. Pick a different name.":
                                  "桶 \"{n}\" 已存在,请换一个名字。",
  "Bucket was created OK, but binding credentials failed: {e}":
                                  "桶已创建成功,但绑定凭据失败:{e}",
  "New bucket via wizard":        "通过向导新建桶",
  "Creating bucket…":             "创建桶中…",
  "Binding identity…":            "绑定身份中…",
  "Select a resource from the tree": "在左侧树形选择一个资源",
  "Pick a bucket, namespace, or table from the tree to see its details.":
                                  "在左侧选一个 bucket / namespace / table 查看详情。",
  "Or click \"+ New\" to create one.": "或点 \"+ New\" 新建。",
  "Default access rules will apply afterwards.":
                                  "移除后会回退到默认访问规则。",
  // ---- CommandPreview component (audit transparency) ----
  "Equivalent command":           "对应命令",
  "Equivalent command (dry-run)": "对应命令(预演,不会真执行)",
  "Equivalent command (Apply)":   "对应命令(执行)",
  "Copy to clipboard":            "复制到剪贴板",
  // ---- CommandAuditToast (auto post-action display) ----
  "Executed":                     "已执行",
  "Copy all commands":            "复制全部命令",
  // ---- Bind credentials diagnostics ----
  "You don't have permission to manage identities (s3.configure). Ask an admin to grant the s3.configure capability or to run the bind themselves.":
                                  "你没有管理身份的权限(s3.configure)。请管理员授予 s3.configure 权限,或让管理员代为绑定。",
  "The identity name is empty. Pick an existing identity or fill in a name in 'Create new identity'.":
                                  "身份名为空。请在上方选择已有身份,或切到\"新建身份\"并填入名字。",
  "Setting a new access key requires the matching secret key.":
                                  "设置新 AK 时必须同时填对应的 SK。",
  "Save is disabled:":            "保存按钮不可点的原因:",
  "identities still loading":     "身份列表还在加载",
  "name required (letters, digits, . _ -)": "名字必填(字母、数字、点、下划线、中划线)",
  "pick an identity":             "请选择一个身份",
  "pick at least one permission": "至少勾选一种权限",
  "AK required":                  "需要填 AK",
  "SK required":                  "需要填 SK",
  "Fill in all required fields first": "请先填好所有必填字段",
  "Cannot read identity bindings": "无法读取身份绑定信息",
  "The 'Bound access' column will be empty until this is fixed. Most common cause: your role lacks s3.read on this cluster.":
                                  "\"可访问凭据\"列在此问题修复前会一直空着。最常见的原因:你的角色在该集群上没有 s3.read 权限。",
  "Could not load existing identities — your role may lack s3.read on this cluster. You can still create a new identity below.":
                                  "无法加载已有身份 —— 你的角色可能没有 s3.read 权限。可以继续在下方新建身份。",
  "Equivalent command: s3.configure -user={n} -delete -apply":
                                  "对应命令: s3.configure -user={n} -delete -apply",
  "Equivalent command: s3tables.bucket -delete -name={n} -account={a}":
                                  "对应命令: s3tables.bucket -delete -name={n} -account={a}",
  "Equivalent command: s3tables.bucket -delete-policy -name={n} -account={a}":
                                  "对应命令: s3tables.bucket -delete-policy -name={n} -account={a}",
  "This kicks off a multi-step drain job. Each step runs a separate weed shell command (volume.fix.replication / volumeServer.leave); they will appear in the bottom-right command audit toast as they execute. You can also follow them on the drain detail page.":
                                  "这会启动一个多步骤的排空任务。每一步都会单独执行一条 weed shell 命令(volume.fix.replication / volumeServer.leave),执行时会在右下角的命令审计提示中陆续显示;也可以在排空详情页跟踪进度。",
  "Equivalent command: weed shell -- \"s3.configure -user={n} -delete -apply\"":
                                  "对应命令:weed shell -- \"s3.configure -user={n} -delete -apply\"",
  "Equivalent command: weed shell -- \"s3tables.bucket -delete -name={n} -account={a}\"":
                                  "对应命令:weed shell -- \"s3tables.bucket -delete -name={n} -account={a}\"",
  "Equivalent command: weed shell -- \"s3tables.bucket -delete-policy -name={n} -account={a}\"":
                                  "对应命令:weed shell -- \"s3tables.bucket -delete-policy -name={n} -account={a}\"",
  // ---- AI policy assistant (Tier 1.2) ----
  "AI policy assistant":          "AI 策略助手",
  // ---- Circuit-breaker AI limit advisor (Tier 2.4) ----
  "AI limit advisor":             "AI 限流顾问",
  // ---- Audit AI summary (Tier 3.6) ----
  "AI summary":                   "AI 摘要",
  "Summarises the same audit slice you have filtered. The narrative is AI-generated; the event counts come straight from the database.":
                                  "对你当前筛选的审计数据生成摘要。叙述由 AI 生成,事件计数直接来自数据库。",
  "Generic summary":              "通用摘要",
  "Focus on S3 changes":          "聚焦 S3 变更",
  "Focus on deletions":           "聚焦删除操作",
  "Who did what?":                "谁做了什么?",
  "Focus (optional)":             "聚焦(可选)",
  "e.g. 'who changed quotas this week' — empty for a generic summary":
                                  "例如:本周谁改了配额 —— 留空则生成通用摘要",
  "Summarising…":                 "正在生成摘要…",
  "Summarise":                    "生成摘要",
  "No audit events in this window — nothing to summarise.":
                                  "此时间窗内没有审计事件,无可摘要。",
  "Highlights":                   "要点",
  "Risks to double-check":        "需复核的风险",
  "By action":                    "按动作",
  "By actor":                     "按操作者",
  "By kind":                      "按对象类型",
  // "Provider" key already defined earlier (line ~813)
  "AI saw only the most recent 500 rows.": "AI 仅看到最近 500 行。",
  "{n} events":                   "{n} 条事件",
  "Get AI suggestion":            "获取 AI 建议",
  "The advisor reads current circuit-breaker state and trigger history, then proposes one threshold change. Review and apply explicitly — nothing auto-applies.":
                                  "顾问会读取当前熔断器状态和触发历史,给出一个阈值调整建议。需人工确认后才会生效,不会自动应用。",
  "Proposed limit":               "建议阈值",
  // "Apply" key already defined earlier (line ~395) as "执行"
  "Limit applied":                "阈值已应用",
  "Apply failed":                 "应用失败",
  "Value must be a positive number": "值必须为正数",
  "Circuit-breaker proposals":    "熔断器建议",
  "From the AI limit advisor":    "来自 AI 限流顾问",
  "No circuit-breaker proposals in this window. Open S3 → Circuit Breaker and click \"Get AI suggestion\" to start collecting data.":
                                  "本时间窗内暂无熔断器建议。打开 S3 → 熔断器,点击 \"获取 AI 建议\" 即可开始积累数据。",
  // ---- S3 proposals card on AI Learning panel ----
  "S3 policy proposals":          "S3 策略提案",
  "From the NL → IAM assistant":  "来自 NL → IAM 助手",
  "No S3 policy proposals in this window. Open the AI policy assistant on the S3 → Identities tab to start collecting data.":
                                  "本时间窗内暂无 S3 策略提案。打开 S3 → 身份 标签页的 AI 策略助手即可开始积累数据。",
  "Total settled":                "已决数",
  "Approved":                     "已批准",
  "Edited":                       "已编辑",
  "Discarded":                    "已丢弃",
  "Acceptance":                   "接受率",
  "Total":                        "总数",
  "Approved+Edited":              "批准+编辑",
  "{n} proposal(s) still pending an operator decision.":
                                  "还有 {n} 条提案等待运维确认。",
  // ---- Assistant tool-result deep-link cards ----
  "Show raw":                     "显示原始数据",
  "Hide raw":                     "隐藏原始数据",
  "Open Buckets":                 "打开 Bucket",
  "Open Identities":              "打开身份",
  "Open Circuit Breaker":         "打开熔断器",
  "Open Clean Uploads":           "打开清理上传",
  "Open Clusters":                "打开集群",
  "Open Volumes":                 "打开卷",
  "Open Temperature":             "打开温度",
  "Open Costs":                   "打开成本",
  "Open Reliability":             "打开可靠性",
  "Open Skills":                  "打开 SOP",
  "Open Path migrate":            "打开路径迁移",
  "{n} bucket(s)":                "{n} 个 Bucket",
  "{n} ≥90% quota":               "{n} 个 ≥90% 配额",
  "{n} without quota":            "{n} 个无配额",
  "{n} identity(s)":              "{n} 个身份",
  "{n} with Admin":               "{n} 个具备 Admin",
  "{n} stuck upload(s)":          "{n} 个卡住的上传",
  "oldest":                       "最久",
  "truncated":                    "结果被截断",
  "{n} cluster(s) registered":    "已注册 {n} 个集群",
  "{n} volume(s)":                "{n} 个卷",
  "{n} EC":                       "{n} 个 EC",
  "Temperature data for {n} collection(s)": "{n} 个集合的温度数据",
  "{n} cluster(s) tracked":       "跟踪中 {n} 个集群",
  "{n} under 30 days":            "{n} 个不足 30 天",
  "{n} incident(s)":              "{n} 个事件",
  "{n} open":                     "{n} 个未关闭",
  "{n} skill(s) available":       "可用 SOP {n} 个",
  "Circuit breaker configuration on {c}": "{c} 上的熔断器配置",
  "of quota":                     "占配额",
  "owner":                        "归属",
  "mo":                           "月",
  "files":                        "文件",
  // "risk" key already defined earlier (line ~1865)
  "Describe the access you want in plain English. The assistant proposes an IAM action set; you still review and approve before any identity is created.":
                                  "用自然语言描述你想要的访问权限。助手会给出 IAM 动作建议,你确认后才会创建身份。",
  "Goal":                         "目标",
  "Bucket scope hint":            "Bucket 范围提示(可选)",
  "Generate":                     "生成",
  "Generating…":                  "生成中…",
  "Proposed policy":              "建议策略",
  "Approve & create identity":    "批准并创建身份",
  "Discard":                      "丢弃",
  "Low risk":                     "低风险",
  "Medium risk":                  "中风险",
  "High risk":                    "高风险",
  // ---- Clean Uploads classification (Tier 1.3) ----
  "Abandoned":                    "已废弃",
  "Suspicious":                   "可疑",
  "In-flight":                    "进行中",
  "Delete all Abandoned ({n})":   "全部清理已废弃({n})",
  "Nothing abandoned — your gateway is clean.": "没有废弃上传——网关很干净。",
  "No suspicious uploads right now.": "目前没有可疑上传。",
  "Delete {n} multipart upload(s)?": "删除 {n} 个分片上传?",
  "All partial data for the selected upload(s) will be permanently destroyed and cannot be recovered. Any client currently uploading these parts will receive errors. This cannot be undone.":
                                  "所选上传的所有分片数据将被永久销毁,无法恢复。正在上传这些分片的客户端会收到错误。此操作不可撤销。",
  // ---- Bucket bulk-delete risk preview (Tier 3.7) ----
  "Delete {n} buckets?":          "删除 {n} 个 Bucket?",
  "Risk":                         "风险",
  "Factors":                      "因素",
  "Re-check the high-risk rows above, then type {phrase} to confirm":
                                  "请再次确认上方高风险项,然后输入 {phrase} 进行确认",
  "{high} high-risk · {med} medium · {low} low": "{high} 个高风险 · {med} 个中风险 · {low} 个低风险",
  "+{n} more — click to expand":  "+{n} 个更多——点击展开",
  "Tier-storage savings tracker and per-TB pricing table.": "分层存储节省追踪与每 TB 定价表。",
  "Once the cluster has volumes, this dashboard fills in. Make sure pricing is configured on the Pricing tab.":
                                  "等集群有卷后,此看板会自动填充。请确认在\"定价\"标签页里配置好了价格。",
  "Admin":                        "管理后台",
  "System configuration, role permissions, and audit log.": "系统配置、角色权限与审计日志。",
  "System configuration, role permissions, audit log, and AI provider setup.":
                                  "系统配置、角色权限、审计日志,以及 AI 服务商配置。",
  "Reliability":                  "可靠性",
  "Health probes that gate the scheduler, alert delivery, and the emergency-stop switch.":
                                  "健康探针、告警投递与紧急停机开关。",
  "Cluster maintenance":          "集群维护",
  "Disk check, replication setup, server drain, and drain history.": "磁盘巡检、副本配置、节点下线与下线历史。",
  "Overview":                     "概览",
  // Nav group labels (post-2026-05-26 reorg: 8 groups → 6).
  "Storage":                      "存储",
  "Insights":                     "洞察",
  "Tools":                        "工具",
  "Automation":                   "自动化",
  "System":                       "系统",
  // Cross-links between path-migrate (Tools) and Lifecycle/Policies
  // (Automation) so the "migration" concept stays reachable from both
  // sides after the nav reorg.
  "Recurring instead?":           "需要常态化?",
  "Lifecycle rules":              "生命周期规则",
  "Tiering policies":             "分层策略",
  "Run one-off path migration":   "执行一次性路径迁移",

  // Bulk bucket delete
  "Select all on page":           "选择本页全部",
  "Select {name}":                "选择 {name}",
  "{n} bucket(s) selected":       "已选中 {n} 个 bucket",
  "Clear selection":              "清空选择",
  "Delete selected":              "删除所选",
  "Delete {n} bucket(s)?":        "删除 {n} 个 bucket?",
  "Delete {n} bucket(s)":         "删除 {n} 个 bucket",
  "Each bucket must be empty (no objects, no multipart uploads). Buckets that still hold data will fail individually and stay listed.\n\nThis cannot be undone.":
                                  "每个 bucket 必须为空(无对象、无未完成的 multipart upload)。仍有数据的 bucket 会单独失败并保留在列表中。\n\n此操作不可撤销。",
  "Deleting {cur} of {total}: {name}": "正在删除 {cur} / {total}:{name}",
  "Deleted {n} bucket(s)":        "已删除 {n} 个 bucket",
  "Failed to delete any bucket":  "全部 bucket 删除失败",
  "Deleted {ok} bucket(s), {fail} failed": "已删除 {ok} 个,失败 {fail} 个",

  // --- Identity key rotation reminder ---
  "Key rotation reminder":        "密钥轮换提醒",
  "access key(s) not rotated in {n}+ days": "个 access key 已超过 {n} 天未轮换",
  "with unknown age":             "轮换时间未知",
  "Stale ({n})":                  "陈旧({n} 个)",
  "Unknown rotation age ({n})":   "轮换时间未知({n} 个)",
  "These identities exist in s3.configure but have never been edited through the controller. Their access keys may have been rotated via the CLI; the audit log doesn't know.":
                                  "这些身份存在于 s3.configure 中,但从未通过控制台编辑过。其 access key 可能已通过 CLI 轮换,审计日志无从得知。",
  "{n} day(s) ago":               "{n} 天前",
  "key(s)":                       "个 key",
  "Threshold":                    "阈值",
  "\"Last rotated\" is the most recent identity edit recorded in the audit log; a secret-only rotation done via CLI is invisible here.":
                                  "\"上次轮换\"取自审计日志中最近一次身份编辑;仅通过 CLI 完成的密钥轮换不会被记录。",

  // --- Bucket cost AI plan ---
  "Bucket plan (AI)":             "Bucket 计划 (AI)",
  "Plan bucket lifecycle (AI)":   "规划 Bucket 生命周期 (AI)",
  "Read-only until you click Apply on a proposal.":
                                  "在你对某条建议点击\"应用\"之前,只读。",
  "Operator hint (optional)":     "操作员提示(可选)",
  "e.g. focus on archive buckets, ignore logs-*":
                                  "例如:重点关注归档 bucket,忽略 logs-*",
  "Generate plan":                "生成计划",
  "Planning…":                    "规划中…",
  "AI call failed.":              "AI 调用失败。",
  "No bucket telemetry yet.":     "暂无 bucket 遥测数据。",
  // "Warnings" key already defined earlier (line ~1418)
  "{n} proposal(s) · est. saving {amount} {ccy}/month":
                                  "{n} 条建议 · 预估节省 {amount} {ccy}/月",
  "Cleanup uploads":              "清理 multipart 上传",
  "Review for deletion":          "标记可删除",
  "Investigate tiering":          "调查冷热分层",
  "Apply quota":                  "应用配额",
  "Run cleanup":                  "运行清理",
  "Mark reviewed":                "标记为已审阅",
  // "Discard" key already defined earlier (line ~2568)
  "Confidence":                   "置信度",
  "month":                        "月",
  "Quota":                        "配额",
  "Set quota on {bucket}?":       "为 {bucket} 设置配额?",
  "Set quota to {n} MB. This may reject future writes once the bucket fills.":
                                  "将配额设为 {n} MB。bucket 写满后后续写入会被拒绝。",
  "Recorded":                     "已记录",
  "Bucket plan acceptance (7d)":  "Bucket 计划采纳率(近 7 天)",
  "Approved or edited proposals out of total":
                                  "已批准或编辑的建议数 / 总数",
  "Accept rate":                  "采纳率",
  "Open":                         "查看",
  "Open proposals":               "未处理建议",
  "Saving recorded":              "已记录节省",

  // --- Alert AI triage ---
  "AI alert triage":              "告警 AI 分诊",
  "Read-only summary — no auto-silence.":
                                  "只读摘要——不会自动静默。",
  "Window (hours)":               "时间窗(小时)",
  "Severity floor":               "最低严重程度",
  "Operator focus (optional)":    "操作员关注点(可选)",
  "e.g. focus on filer-3, group identity alerts":
                                  "例如:重点看 filer-3、把身份相关告警归一组",
  "Triage with AI":               "用 AI 分诊",
  "Triaging…":                    "分诊中…",
  "Storms only":                  "仅风暴",
  "Criticals":                    "严重项",
  "Suppressions":                 "被抑制项",
  "Storm candidates":             "风暴候选",
  "Investigate first":            "优先排查",
  "Older events truncated":       "更早的事件已截断",
  "No alert events in this window. Quiet is good.":
                                  "此窗口内没有告警事件。安静是好事。",
  "Show server-side facets":      "查看服务端聚合",
  "Window":                       "时间窗",
  "Events":                       "事件",
  "Kind":                         "类型",
  // "Source" key already defined earlier (line ~1496)
  // "Severity" key already defined earlier (line ~1975)
  "Generic":                      "通用",

  // --- Fleet cost overview ---
  "Fleet":                        "全集群",
  "Fleet cost overview":          "全集群成本概览",
  "Aggregated monthly snapshots across all clusters, with a 3-month linear forecast.":
                                  "跨所有集群按月聚合的成本快照,附 3 个月线性预测。",
  "History window":               "历史窗口",
  "AI explainer":                 "AI 解读",
  "AI commentary":                "AI 评注",
  "Commentary is informational; the forecast numbers above are computed from regression, not AI.":
                                  "评注仅供参考;上方的预测数字来自线性回归,不是 AI。",
  "No cost snapshots yet. Run \"Snapshot now\" on a per-cluster Overview tab to seed the timeline.":
                                  "尚无成本快照。在某个集群的 Overview 标签上点击 \"立即快照\" 启动时间线。",
  "Refreshing…":                  "刷新中…",
  "Rising":                       "上升",
  "Falling":                      "下降",
  "Flat":                         "持平",
  "Insufficient data":            "数据不足",
  "Unknown":                      "未知",
  "Fleet monthly cost":           "全集群月度成本",
  "Forecast":                     "预测",
  // "Observed" key already defined earlier (line ~1976)
  "Counterfactual (all-hot)":     "对比线(全部热存储)",
  "Clusters this month (ranked)": "本月集群排名",
  "Cost":                         "成本",
  "Physical bytes":               "物理字节",
  "MoM Δ":                        "环比 Δ",
  "forecast":                     "预测",
  // "actual" / "counterfactual" already defined earlier (lines ~1858-1859)

  // --- Fleet ops overview (Activity → Fleet) ---
  "Fleet ops overview":           "全集群运维概览",
  "Where tasks are queueing, what's failing, throughput trend.":
                                  "任务在哪里排队、什么在失败、吞吐趋势。",
  "Pending":                      "待处理",
  "Running":                      "运行中",
  "Succeeded":                    "成功",
  "Failed":                       "失败",
  "Daily executions":             "每日执行数",
  "By cluster":                   "按集群",
  "No tasks recorded for any cluster yet.":
                                  "暂无任何集群的任务记录。",
  "Stuck tasks":                  "卡住的任务",
  "running > {r}, pending > {p}":
                                  "运行中 > {r},待处理 > {p}",
  "Age":                          "时长",
  "Action":                       "动作",
  "Volume":                       "卷",
  "Status":                       "状态",
  "Inspect":                      "查看",
  "Action failure rate":          "动作失败率",
  "min 3 runs":                   "至少 3 次",
  "Rate":                         "比率",
  "succeeded":                    "成功",
  // "failed" already defined earlier (line ~711)
  "m":                            "分",
  "w":                            "周",
  // "h" / "d" intentionally left untranslated — they're shorter than 时/天 in the table cells

  // --- Skill wizard AI helper ---
  "Suggest {section} with AI":    "用 AI 建议 {section}",
  // "Generate" / "Generating…" already defined earlier (lines ~2564-2565)
  "Regenerate":                   "重新生成",
  "Validated server-side before preview. You decide whether to apply.":
                                  "服务端已校验后再预览,是否采纳由你决定。",
  "Why":                          "理由",
  "Append":                       "追加",
  "Replace":                      "替换",
  "(empty)":                      "(空)",
  "e.g. include EC rebuild, target collection logs-*":
                                  "例如:包含 EC 重建、目标 collection 为 logs-*",
  "steps":                        "执行步骤",
  // "rollback" / "risk" already defined earlier (lines ~2132 / ~1865) — wizard reuses them
  "postchecks":                   "事后检查",
  "preconditions":                "前置检查",

  // --- EC by-server matrix ---
  "By volume":                    "按卷",
  "By server":                    "按服务器",
  "Placement risks":              "放置风险",
  "server×volume pairs with ≥{n} shards on one server. Losing that server consumes most of the EC safety margin.":
                                  "服务器×卷 对存在 ≥{n} 个分片集中在同一服务器。该服务器宕机会吃掉大部分 EC 容错余量。",
  "volume(s) with every shard on a single rack — EC durability is rack-fault-tolerant only if shards are spread across racks.":
                                  "个卷的全部分片在同一机架——EC 的机架级容错前提是分片跨机架分散。",
  "shards":                       "分片",
  "more":                         "更多",
  "No EC shard locations to pivot. Run ec.encode on some volumes first.":
                                  "没有可透视的 EC 分片位置。先对一些卷运行 ec.encode。",
  "servers, sorted by total shards held":
                                  "台服务器,按持有分片总数排序",
  "Server":                       "服务器",
  "DC / Rack":                    "DC / 机架",
  "Shards":                       "分片",
  "Volumes":                      "卷",
  "Concentration":                "集中度",

  // --- Unified AI learning panel ---
  "All AI streams":               "全部 AI 流",
  "Side-by-side ROI. Low acceptance suggests the prompt or the surface needs work; high acceptance suggests the stream is worth extending.":
                                  "并排 ROI 对比。采纳率低提示 prompt 或入口需要打磨;采纳率高说明这条流值得扩展。",
  "Stream":                       "流",
  "Signal source":                "信号来源",
  "Accepted / correct":           "采纳 / 正确",
  "auto-graded":                  "自动评分",
  "operator-driven":              "操作员驱动",
  "correct":                      "正确",
  "approved+edited":              "已批准+编辑",
  "low n":                        "样本不足",
  "Task verdicts":                "任务判决",
  "NL → IAM policies":            "NL → IAM 策略",
  "Circuit-breaker limits":       "限流阈值",
  "Bucket lifecycle plans":       "Bucket 生命周期计划",
  "Bucket plan proposals":        "Bucket 计划建议",
  "From the bucket lifecycle planner":
                                  "来自 Bucket 生命周期规划器",
  "No bucket plan proposals in this window. Open /costs → Bucket plan (AI) to generate some.":
                                  "此窗口暂无 Bucket 计划建议。打开 /costs → Bucket plan (AI) 生成。",
  "Recorded savings on accepted proposals":
                                  "已记录的采纳建议节省",
  "By action":                    "按动作",
  // "Action" / "Rate" / "Open" already defined earlier

  // --- Audit AI filter ---
  "AI only":                      "仅 AI",
  "AI activity only":             "仅 AI 活动",
  "Show only AI-initiated actions":
                                  "只显示 AI 触发的操作",

  // --- AI Usage panel ---
  "AI Usage":                     "AI 用量",
  "AI token usage":               "AI Token 用量",
  "Per-call accounting captured from provider responses. Zero tokens means the vendor did not report.":
                                  "按调用捕获的 Token 用量。Token 为 0 表示厂商未返回用量数据。",
  "Failed to load AI usage":      "加载 AI 用量失败",
  "No AI activity yet":           "暂无 AI 活动",
  "Token rows are recorded automatically on every Chat / JSONChat call. Use the floating assistant or any AI-backed action to populate this view.":
                                  "每次 Chat / JSONChat 调用都会自动记录 Token 行。使用悬浮助手或任何 AI 功能即可填充此视图。",
  "Calls":                        "调用",
  "models":                       "个模型",
  "Error rate":                   "错误率",
  "Input tokens":                 "输入 Token",
  "Output tokens":                "输出 Token",
  "Daily tokens (input + output)":"每日 Token 量（输入 + 输出）",
  "Input":                        "输入",
  "Output":                       "输出",
  "output":                       "输出",
  "By provider × model":          "按厂商 × 模型",
  "Errors":                       "错误数",
  "Avg latency":                  "平均时延",
  "Top users":                    "活跃用户",
  // "User" / "Provider" / "Model" / "input" / "Loading…" already defined earlier

  // --- AI model pricing (in-panel editor) ---
  "Estimated cost":               "估算费用",
  "unpriced models":              "个未配置定价的模型",
  "all models priced":            "全部模型已配置定价",
  // (dup of line 2719) "Cost":                         "费用",
  "Est. cost":                    "估算费用",
  "No pricing row for this model — add one to see cost.":
                                  "未为该模型配置定价 — 添加后即可显示费用。",
  "cost approximated via fleet-average per-token rate":
                                  "费用按整体平均 Token 单价估算",
  "Pricing":                      "定价",
  "Edit per-model token prices":  "编辑每个模型的 Token 定价",
  "Model pricing":                "模型定价",
  "per 1M tokens":                "每 100 万 Token",
  "Provider and model are required":
                                  "服务商和模型为必填",
  "Prices must be >= 0":          "价格必须 ≥ 0",
  "Delete pricing for":           "删除以下定价",
  // (dup of line 1885) "Currency":                     "币种",
  // (dup of line 926)  "Notes":                        "备注",
  "Add or update this pricing row":
                                  "新增或更新该定价行",

  // --- AI budgets ---
  "Budgets":                      "预算",
  "configured":                   "项已配置",
  "Re-check spend against budgets and fire any pending alerts":
                                  "重新核对预算并触发待发的告警",
  "Re-check now":                 "立即核对",
  "Checking…":                    "核对中…",
  "Budget":                       "预算",
  "No budgets yet. Add one to start tracking AI spend against a monthly cap.":
                                  "尚未配置预算。添加后即可按月跟踪 AI 支出。",
  "budget(s) currently over threshold":
                                  "个预算当前已超阈值",
  "of":                           "/",
  "over cap":                     "超出上限",
  "inactive":                     "未启用",
  "Delete budget":                "删除预算",
  // (dup of line 2216) "global":             "全局",
  "provider":                     "服务商",
  // (dup of line 1662) "user":               "用户",
  "Name":                         "名称",
  // (dup of line 2192) "Scope":              "范围",
  "Provider name":                "服务商名称",
  "User UUID":                    "用户 UUID",
  "Monthly limit":                "月度上限",
  "Warn at %":                    "警告 %",
  "Critical at %":                "严重 %",
  // (dup of line 951) "Saving…":            "保存中…",
  "New budget":                   "新增预算",
  "Name is required":             "名称必填",
  "Scope value is required for provider/user budgets":
                                  "服务商 / 用户预算必须填写范围值",
};

const DICTS: Record<Lang, Dict> = {
  zh: ZH,
  en: {}, // English is the source language — keys pass through unchanged.
};

/**
 * Read-only hook returning the current language and a translator. The
 * translator falls through to the key when a string is missing — pages can
 * adopt translations incrementally without breakage.
 */
export function useT() {
  const [lang, setLangState] = useState<Lang>("zh");

  useEffect(() => {
    const saved = (typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY)) as Lang | null;
    if (saved === "zh" || saved === "en") setLangState(saved);
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, l);
      window.dispatchEvent(new Event("tier:lang"));
    }
  }, []);

  // Listen for changes from other components.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => {
      const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
      if (saved === "zh" || saved === "en") setLangState(saved);
    };
    window.addEventListener("tier:lang", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("tier:lang", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  // `t(key)` returns the translation or the key itself. Templating callers do
  // string interpolation themselves: `t("Step {n} of {total}").replace(...)`.
  const t = useCallback((key: string) => DICTS[lang][key] ?? key, [lang]);
  return { lang, setLang, t };
}
