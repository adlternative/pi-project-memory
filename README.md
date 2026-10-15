# pi-project-memory 0.2

原生 Pi 扩展。采用 CC 风格的 **`MEMORY.md` 导航 + 一条记忆一个主题 Markdown**；agent 可以直接用普通 `read/edit/write` 做局部修改，不必重写整份 JSON。保留中文/英文 BM25、可选模型语义选择和可选增量提炼。

**默认不安装到全局 Pi。** 隔离试用只写本项目的 `.sandbox/`；开发验收未修改运行中的 Pi 配置或 Codex 仓库。调研依据见 [RESEARCH.md](./RESEARCH.md)。原始实验数据、会话、凭据和分析产物不提交到仓库。

## 文件布局

```text
<agent-dir>/project-memory/<项目哈希>/
├── MEMORY.md                  # 导航索引；生成区之外可以写自己的索引说明
├── feedback_tools.md          # 一条笔记：文件名即稳定 id
├── project_decisions.md
├── .state.json                # revision、来源短引、时间、哈希、遗忘标记；没有正文字段
├── .legacy-memories.json       # 仅旧版本迁移后出现，保留原始 JSON 备份
└── .pending.json               # 仅事务进行中/中断待恢复时出现
```

`<agent-dir>` 遵循 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`；`--memory-dir /absolute/base` 覆盖基础目录但仍按项目分开。Git common-dir 的规范路径决定项目身份：同仓库子目录/worktree/会话共享，不同仓库隔离；非 Git 目录按规范 cwd 隔离。不聚合跨项目的个人资料。

主题文件使用简单的 YAML frontmatter 和普通 Markdown 正文：

```markdown
---
name: "包管理器偏好"
description: "此项目的依赖安装方式"
type: feedback
modified: "2026-10-15T00:00:00.000Z"
---

默认使用 pnpm，不使用 npm。
```

- 文件名使用小写字母、数字、`-`、`_`，最多 64 字符；`memory` 保留给索引。
- `name`、`type` 必填；`description`、`modified` 可选。`type` 为 `user/feedback/project/reference`。
- 支持平铺的普通字符串、JSON 双引号字符串、YAML 单引号字符串；不支持折叠多行值、嵌套 YAML 或 alias。需要复杂元数据时再升级 YAML 解析器，不新增运行依赖。
- **只想改一条事实时，用 `edit` 改对应正文即可**，无需修改内部 JSON。下次读取会检测文件变化、更新来源/时间/revision，并同步索引；成功的普通文件写入也会立即触发校验和同步。
- 手工编辑的来源标为 `file`，不继续冒用修改前的会话引用。普通 `edit` 不自动改写 `modified` 那一行，以免干扰宿主读写缓存或扩大 diff；真实变更时间以文件及内部记录为准，可用 `pmem_read` 查看。

## MEMORY.md 怎么维护

插件只重建这两个标记之间的链接，避免漏索引；标记以外的自定义文字会保留：

```markdown
# Project memory

这里可以写自己的导航说明。

<!-- pi-memory:index:start -->
- [包管理器偏好](feedback_tools.md) — feedback
<!-- pi-memory:index:end -->

这里也可以补充索引说明。
```

索引不是第二份正文真相源；改笔记内容请编辑主题文件。不要往生成区手工放唯一信息，也不要修改隐藏状态、锁、迁移备份或事务日志。普通文件写坏 frontmatter 后，写入不会偷偷回滚：工具会报告摄入失败，agent 可以继续用 `edit` 修复，期间自动召回会明确提示不可用，而不是把损坏存储当成空库。

## 隔离试用

```bash
cd pi-project-memory
npm ci --ignore-scripts
./run-sandbox.sh
# 开启可选自动提炼：
./run-sandbox.sh --memory-auto
# 有初始提示时，用 -- 分隔，避免 Pi 的扩展布尔参数吞掉提示：
./run-sandbox.sh --memory-auto -- "以后这个项目用 pnpm，不要用 npm。"
```

脚本只在 `.sandbox/manual/` 创建配置、会话、项目和记忆。禁用发现式扩展、skills、上下文文件和 MCP，只加载本插件与实验用 `sandbox-guard.ts`。

实验窗口提供四个记忆工具及普通 `read/edit/write`，**文件工具被限制为当前项目的 `MEMORY.md` 和主题 `.md`**，不能读写全局 Pi、其他项目、隐藏状态或任意代码文件；没有 shell 工具。缺少实验根目录配置时，guard 会拒绝文件工具，而不是失效放行。正常安装的插件不会加载这个实验 guard，也不会把用户的整个 Pi 限制为记忆编辑器。

不执行 `pi install` 或 `/reload`，不继承全局 settings/auth 文件。已有 provider 环境变量仍可用于手动试用；若需 `/login`，凭据只写实验 agent-dir。这里是配置/数据/工具范围隔离，不是 OS 沙箱。

## 工具和命令

| 工具 | 用途 |
|---|---|
| `pmem_list({offset?})` | 每页 10 条预览，返回相对 `.md` 路径和 `nextOffset` |
| `pmem_read({id})` | 完整笔记、相对文件路径和来源 |
| `pmem_search({query, mode?})` | 默认本地 `keyword` BM25；可选 `semantic` 模型选择，最多 5 条命中 |
| `pmem_save({id,type,title,description?,content})` | 创建/更新一条主题 Markdown；保留同 id，供没有普通文件工具的会话使用 |

结构化结果是 `{directory,indexPath,notes,truncated,nextOffset}`；`note.path` 相对 `directory`。普通文件工具不是强制的，四个记忆工具仍能独立工作。save/普通文件编辑的提示要求用户明确请求，这不是对自然语言授权的硬性语义验证。

```text
/pmem                        路径、数量、revision、自动提炼状态
/pmem list [offset]           分页索引
/pmem show <id>               正文和来源
/pmem forget <id>             删除主题文件、移除索引链接、保存遗忘标记
/pmem auto on|off             本会话开启/关闭提炼；不改全局设置
/pmem extract                 手动提炼当前分支未处理的新证据
```

物理删除主题文件也会在下一次读取时变成遗忘，自动提炼不能原样恢复；明确重新创建该 Markdown 或显式 save 则视为人工恢复。forget 不擦除原始会话、迁移备份或其他笔记的历史来源短引，也不能识别任意改写后的同义内容。它不是隐私级安全擦除。

## 旧版本迁移

首次访问旧 `memories.json` 时自动迁移：校验原数据 → 生成主题 Markdown/索引/内部状态 → 保留逐字节一致的 `.legacy-memories.json` 备份 → 移除旧活动 JSON。原 id、正文、description、来源、时间和遗忘标记保留，revision 单调增加。

- 遇到已经存在的 Markdown、保留 id 或损坏旧 JSON，停止并保留现场，不擅自覆盖或合并。
- 不要让 0.1 和 0.2 同时写同一目录。迁移后若旧 writer 又创建 `memories.json`，新版会报冲突，而不是无声忽略旧写入。
- 丢失 `.state.json` 时不会从迁移备份复活已删除记忆，请恢复状态或人工处理。
- 备份仍含旧内容，需要彻底遗忘时要另外审查会话和该备份。

## 注入、检索、提炼与硬上限

- 运行时只追加固定 `project_memory` 使用规则，不覆盖原 system prompt，不改 `SYSTEM.md`。历史正文仍是不可信资料，不是系统指令。
- `context` 钩子注入真实 `MEMORY.md` 的前最多 200 行/3,000 UTF-8 字节，加 BM25 最多 3 条正文片段（各 600 字节），**整体不超过 6,000 字节**；不会永久追加这条召回消息或重写旧消息。工具结果仍正常记录。
- BM25 本地计算，标题权重 3，描述+正文权重 1；英文词、中文字符/双字组合。语义模式用当前模型选择至多 48 条候选预览，不是向量索引，也可能漏掉旧笔记或详情。
- 自动提炼默认关闭。开启后，每个持久会话用户 run 最多一次无工具模型调用：可取消的 `turn_end` 先提候选，最终成功再提交。直接写过记忆的 run 不重复提炼；失败、中断、旧 revision 不提交。
- 提炼只用当前有效分支最近最多 12 条新 user/最终 assistant 文本，每条 1,000 字节；不取 system、thinking、tool 输出或废弃分支。临时 `--no-session` 会话不做自动/手动提炼。

| 项目 | 上限 |
|---|---:|
| 每项目主题 | 128 条 |
| 标题 / 描述 / 正文 | 160 / 320 / 2,000 UTF-8 字节 |
| 单个主题 Markdown（含头部） | 4,096 字节 |
| MEMORY.md 文件 | 25,000 字节；超限报错，不覆盖自定义文字 |
| 内部状态 / 旧 JSON | 各 1MiB |
| 遗忘标记 | 1,024 个；不自动淘汰 |
| 内部事务日志 | 4MiB |
| 单次工具输出 | 12,000 字节 |
| 嵌套模型输入 | 硬限 32,000 字节，预裁剪到 30,000 |
| 嵌套模型输出 / 超时 | 2,000 tokens、16,000 字节 / 15 秒 |

语义工具的用量通过结果计入 Pi；自动/手动提炼另记在 `pi-project-memory.extraction`，不自动计入 footer 总费用。无完整 dreaming：没有定时全库重整、自动淘汰或技能生成。

## 一致性与安全边界

- 插件读取/写入使用同进程队列及跨进程锁；每个文件原子替换，多文件更新先写有上限的 `.pending.json`，最后提交 `.state.json`，中断后可以继续完成。
- 恢复遇到不同于事务前/后版本的外部编辑会停止并保留现场，不覆盖新文字。已经完成 state-last 提交的事务不会重放覆盖后来的手工编辑。
- 不合作的外部编辑器不受插件锁控制，不能把普通文件读写称为全局多文件原子事务。冲突时关闭相关会话，保留 `.pending.json` 和手工编辑副本后再处理。
- crash 留下 `.lock` 时故意停止访问；先关闭使用该目录的 Pi，再检查 PID/时间并移除锁。不要删除 `.pending.json`、`.state.json` 来“修复”。锁清除后，未冲突的日志会自动恢复。
- 拒绝路径穿越、symlink、数据文件 hardlink、坏 UTF-8 和未知/损坏状态；新文件 `0600`、目录 `0700`（Windows 使用平台权限语义）。
- 已知凭据在提炼前脱敏，明显凭据禁止入库；不是 DLP，不保证识别所有秘密。历史笔记不是 prompt-injection 安全边界，敏感会话不开自动提炼。

## 测试与限制

Pi 1.2.0，Node 22.22.3 / 24.18.1 各通过 **49 项测试**。源码和打包版均通过三进程串联验证：自动提炼 → 普通 read/edit 局部修改 → 新会话读回。

测试覆盖 Markdown 局部编辑/修复、索引自定义区、旧 JSON 迁移和迁移中断恢复、来源、遗忘、防原样复活、外部编辑使旧提炼失效、事务冲突/恢复、损坏/越界和原有检索/会话行为。全部使用合成 provider 和实验目录，不复制真实历史/凭据。日志为 `evidence/test-node{22,24}-markdown.log`、`cli-markdown-edit-smoke.json`、`packed-markdown-edit-smoke.json`；全局 Pi 配置/扩展入口 13 项指纹未变，全局默认 project-memory 目录未创建。

```bash
npm run check
npm test
python3 tests/cli-smoke.py
PI_MEMORY_TEST_FILE_TOOLS=1 python3 tests/cli-smoke.py
python3 tests/check-isolation.py # 本机实验前后的全局 Pi 指纹，不是跨机器通用测试
```

`PI_MEMORY_TEST_NODE` 可指定 Node。开发依赖锁定 Pi/测试用 pi-ai 1.2.0 和 typebox 1.3.27，`npm ci --ignore-scripts` 只安装到当前项目，不安装或更新全局 Pi。发布包仍只声明宿主 peers，不包含这些开发依赖。已针对 Pi 1.2.0 测试，不保证旧 fork 的接口兼容。

`tests/check-isolation.py` 依赖开发机本地 `evidence/global-pi-before.json`，该快照不会提交；它不是全新克隆后的必跑测试。`evidence/` 和 `.sandbox/` 下的历史路径仅在原开发机可用，重跑测试会产生自己的实验路径。

已补充真实模型微型项目 E2E：`openai-codex/gpt-6.1-sol`，15 个独立进程阶段、10 个真实模型会话、17 个验收点通过。模型在冷会话里修复了新增运费测试（7/7），并完成改口、语义检索、隔离、遗忘和自动提炼后召回。入口见 `e2e/live/README.md`，报告为 `evidence/live-micro-project.json`；这是一个模型、一个小项目的样本，不是广泛稳定性基准。

额外检查确认：其他笔记的历史来源短引可能保留已删主题的旧值，本轮模型没有把它当成当前事实，但不能据此保证严格遗忘。未在 Linux/Windows 实机测试，也未验证断电级持久性。测试日志、live E2E 开发脚本和实验数据不进入插件包；CC 派生源码、REA、缓存、凭据和 node_modules 同样不会打包。没有全局安装。
