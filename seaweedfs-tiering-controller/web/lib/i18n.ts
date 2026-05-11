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
  Audit:        "审计日志",
  Overview:     "概览",
  Resources:    "资源",
  Policy:       "策略",
  Execution:    "执行",
  Operations:   "运维",
  "Ops Console": "运维台",
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
  "Single-command console":       "单命令控制台",
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
  Automation:                       "自动化",
  Activity:                         "动态",
  Monitoring:                       "监控",
  Buckets:                          "S3 桶",
  Collections:                      "Collections",
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
  Chunks:                           "块数",
  AI:           "AI",
  System:       "系统",

  // ---- Common buttons / verbs --------------------------------------
  Save:                  "保存",
  Cancel:                "取消",
  Edit:                  "编辑",
  Delete:                "删除",
  Remove:                "移除",
  Discard:               "丢弃",
  Apply:                 "应用",
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
  "Run scoring":              "运行评分",
  "Scan selected cluster":    "扫描所选集群",
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
  "Cluster pressure":       "集群压力",
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
  failed:                     "失败",
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
  vols:                    "卷",
  steps:                   "步骤",
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
