# Cursor agent backend（`happy cursor`）

Status: **IMPLEMENTED**（2026-11-11）

目标：在 Happy 里像用 Claude Code / Codex 一样用 Cursor CLI——终端 `happy cursor`
启动、手机端新建会话可选 Cursor、手机审批工具调用、切换模型和模式、断线后恢复会话。

非目标（本 spec 不做）：fork / duplicate / rewind、图片附件、Cursor Cloud Agent /
`agent worker`、Mac 端新建会话弹窗。发版不在本 spec 内，走 `.agents/skills/release/SKILL.md`。

## 已验证的事实

以下都在 `cursor-agent 2026.11.10-731fb78` 上用裸 ACP JSON-RPC 实测过，实现时以此为准；
CLI 升级后行为不符时先复测再改代码。

- `cursor-agent acp`（`agent acp` 同义）是一个 ACP server，`--help` 顶层不列出它。
  安装位置 `~/.local/bin/cursor-agent`，daemon 的 PATH 里经常没有这个目录（同 agy）。
- `initialize` 返回：`loadSession: true`、`sessionCapabilities.list`、
  `promptCapabilities.image: true`、`mcpCapabilities.{http,sse}`、
  `authMethods: [cursor_login]`（未登录时提示用户跑 `cursor-agent login`）。
- `session/new` 返回 `modes`（`agent` / `plan` / `ask`）、`models`（账号相关，二十多个，
  id 带参数，如 `claude-opus-5-5[context=300k,effort=medium,fast=false]`）、
  以及 `configOptions`（category `mode` 和 `model`）。没有自动批准类的模式。
- 流式：`agent_thought_chunk`、`agent_message_chunk`、`tool_call`（含 `kind`、`rawInput`）、
  `tool_call_update`（含 `rawOutput`）、`session_info_update`（标题）、
  `available_commands_update`（斜杠命令）。
- 权限：shell 命令和 MCP 工具调用都会发 `session/request_permission`，选项为
  `{optionId:"allow-once",kind:"allow_once"}`、`{"allow-always","allow_always"}`、
  `{"reject-once","reject_once"}`。回一个不存在的 `optionId`（如 `cancel`）时 Cursor 按拒绝处理。
- 自动批准：`cursor-agent acp --force`（或 `--force acp`）后不再发权限请求，命令直接执行。
  **`--yolo` 在 ACP 模式下被接受但不生效**（help 里写它是 `--force` 的别名，实测仍会弹权限请求）。
  `--force` 是进程级的，会话中途关不掉。
- `session/new` 里传 stdio MCP server（Happy 现在的做法）可用，工具能被调用。
- `session/load`（新进程里）可恢复上下文，但会先把整段历史以 `session/update` **重放**一遍：
  `user_message_chunk`、`agent_message_chunk`、`tool_call`（id 形如 `replay-0-0`）等。
  返回值只有 `modes` / `models` / `configOptions`，不含 `sessionId`。
- `session/list` 按 cwd 列出 Cursor 会话（`sessionId`、`title`、`updatedAt`）。
- 观察到一次：回复末尾多出一段 `agent_message_chunk` 文本
  `"\n\nError: RetriableError: WritableIterable is closed"`，`stopReason` 仍是 `end_turn`。
  未确认能否复现，见「风险」。

现状基线：不改代码时 `happy acp -- cursor-agent acp` 已经能跑，走
`packages/happy-cli/src/agent/acp/runAcp.ts`，但 flavor 是 `acp`、手机无法新建、无法恢复。

## 契约

所有阶段共享的约定，这里是唯一出处；CLI 和两个客户端都按这一节实现，因此 P1、P4、P5 可以并行。

| 项 | 值 |
|---|---|
| session `metadata.flavor` | `"cursor"` |
| 新建会话 RPC `spawn-happy-session` 的 `agent` | `"cursor"` |
| 机器 `metadata.cliAvailability.cursor` | `boolean`，可选（老 CLI 不上报） |
| session `metadata.operatingModes` / `currentOperatingModeCode` | Cursor 的 `agent`、`plan`、`ask`，外加 Happy 合成的 `yolo`（P2） |
| session `metadata.models` / `currentModelCode` | Cursor 返回的模型 id 原样透传 |
| 用户消息 meta `permissionMode` | 上面 operating mode 的 code |
| 用户消息 meta `model` | Cursor 模型 id；`default` 或未知值 → CLI 忽略，保持当前模型 |
| session `metadata.cursorSessionId` | Cursor 的 ACP sessionId（P3），恢复会话用 |
| 图片附件 | 不支持（通用 ACP runner 只发文本 prompt） |

## P1 — CLI 基础接入

改动全部在 `packages/happy-cli/src`。先例：agy 接入提交 `c42892282`（逐处照抄 `agy` 出现的位置）。

1. **二进制解析**：新建 `cursor/constants.ts`，`findCursorBin()` 仿照 `agy/constants.ts` 的
   `findAgyBin()`：`HAPPY_CURSOR_PATH` → PATH 上的 `cursor-agent` → `~/.local/bin/cursor-agent`。
   只认 `cursor-agent`；`agent` 这个别名太泛，不用。
2. **ACP 配置**：`agent/acp/acpAgentConfig.ts` 的 `KNOWN_ACP_AGENTS` 加 `cursor`，
   command 在调用时用 `findCursorBin()` 解析，args `['acp']`。补 `acpAgentConfig.test.ts`。
3. **子命令**：`index.ts` 加 `happy cursor`，结构同 `agy` 分支。解析 `--started-by`、`--verbose`，
   接受并忽略 `--happy-starting-mode`（daemon 会传）；接受 `--model <id>`、`--permission-mode <code>`，
   会话启动后作为初始选择应用（复用 `runAcp.ts` 的 `switchModelIfRequested` /
   `switchPermissionModeIfRequested`，需要给 `runAcp` 加对应参数）。
   找不到二进制时报错并提示安装；ACP 启动失败且看起来是未登录时，提示 `cursor-agent login`。
   更新 help 文本。
4. **flavor**：`runAcp.ts` 的 `resolveSessionFlavor` 对 `cursor` 返回 `'cursor'`；
   `utils/createSessionMetadata.ts` 的 `BackendFlavor`、`agent/core/AgentBackend.ts` 的 `AgentId` 加 `'cursor'`。
5. **可用性检测**：`utils/detectCLI.ts` 的 `CLIAvailability` 加 `cursor`（POSIX 和 Windows 两条路径都用
   `findCursorBin() !== undefined`）；`api/types.ts` 的 `cliAvailability` schema 加
   `cursor: z.boolean().optional()`；`api/apiMachine.ts` 心跳里的 `cliAvailabilityChanged` 比较加
   `prev.cursor !== newAvailability.cursor`（该处注释说明了漏比较的后果）。
6. **daemon 新建**：`daemon/controlServer.ts` 的 `z.enum`、`modules/common/registerCommonHandlers.ts`
   的 `agent` 类型、`daemon/run.ts` 里 tmux 分支的 agent 解析和普通进程分支的 `switch`，都加 `cursor`。
   `daemon/spawnModeArgs.ts` 不改：非 claude/codex 不转发模式参数，手机的选择随第一条消息的 meta 到达。

完成标准：
- 终端 `happy cursor` 能对话、手机看到 flavor 为 `cursor` 的会话、工具调用在手机上弹审批。
- 机器 metadata 里出现 `cliAvailability.cursor: true`；卸载或改名二进制后一个心跳内变成 `false`。
- 通过 daemon `/spawn-session`（`agent: "cursor"`）和 `spawn-happy-session` RPC 都能拉起会话，
  daemon 用非登录 shell 启动时也行（验证 `~/.local/bin` 回退）。
- `pnpm --filter happy typecheck` 和 `pnpm --filter happy test` 全绿。

## P2 — CLI 权限对齐

1. **按 `kind` 选权限选项**：`agent/acp/AcpBackend.ts` 中处理 `session/request_permission`
   的那段（`permissionHandler.handleToolCall` 之后，把 decision 映射成 `optionId`）现在只按
   `optionId`（`proceed_once` / `cancel`）和名字关键词匹配。改为先按 ACP 规范的 `kind` 匹配：
   `approved` → `allow_once`；`approved_for_session` → `allow_always`（没有则 `allow_once`）；
   `denied` → `reject_once`（没有则 `reject_always`）；`abort` → 回 `{ outcome: { outcome: 'cancelled' } }`。
   `kind` 匹配不到时保留现有关键词逻辑，保证 Gemini / OpenCode 不回归。补单测覆盖 Cursor 和 Gemini 两种选项形状。
2. **自动批准模式 `yolo`**：Cursor 没有自动批准的 ACP 模式，Happy 侧合成一个，只对 flavor `cursor` 生效。
   不用 `cursor-agent --force`：它是进程级的，手机上切回 `agent` 时没法关掉，只能重启进程。
   - 发布：写 `metadata.operatingModes` 时（`agent/acp/sessionConfigMetadata.ts`，每次
     `config_options_update` / `modes_update` 都会重写），在 Cursor 的模式后面追加
     `{ code: 'yolo', value: 'Agent (auto-approve)', description: 'Runs tools without asking' }`。
   - 切换：`runAcp.ts` 的 `switchPermissionModeIfRequested` 收到 `yolo` 时把 Cursor 模式设为 `agent`，
     并让 `GenericAcpPermissionHandler` 对后续请求直接回 `approved`；切到其他模式时关闭。
     yolo 生效期间 `currentOperatingModeCode` 报 `yolo`。
   - `happy cursor --permission-mode yolo` 同样生效。
3. **`change_title` 自动批准**：Cursor 的 MCP 工具调用也会请求权限，标题形如 `happy-change_title: change_title`。
   验证 `AcpBackend.ts` 里 `hasChangeTitleInstruction` / `recentPromptHadChangeTitle` 那套自动批准
   对这种标题生效；不生效就扩展匹配。

完成标准：手机上点「拒绝」时 Cursor 收到 `reject-once`（看 verbose 日志）；点「本会话总是允许」时收到
`allow-always`；切到 `yolo` 后连续两次 shell 调用都不弹审批，切回 `agent` 后又弹；新会话首条消息
不会因 `change_title` 卡在审批上。

## P3 — 恢复会话

实现「进程退出后从手机点恢复，同一个 Happy 会话继续，Cursor 记得之前的上下文」。
先例：Codex 的 resume-in-place（`codex/runCodex.ts` 读 `HAPPY_RECONNECT_*` 的那段及其后的取消归档逻辑）。

1. **AcpBackend**：构造参数加 `resumeSessionId?: string`。`startSession` 在 `initialize` 之后，若有
   `resumeSessionId` 且 `agentCapabilities.loadSession`，调 `connection.loadSession({ sessionId, cwd, mcpServers })`
   代替 `newSession`，并把 `this.acpSessionId` 设为它。**`loadSession` 等待期间收到的
   `session/update` 全部丢弃，不发给 listener**（历史已在 Happy 会话里，转发会让手机上整段历史重复一遍）。
   `modes` / `models` / `configOptions` 从 `loadSession` 的返回值照常处理。
   `loadSession` 失败或不支持时，退回 `newSession`，并向会话发一条可见消息说明 Cursor 上下文没恢复。
2. **runAcp**：加 `resumeAgentSessionId` 参数传给 backend；按 runCodex 的方式支持 `HAPPY_RECONNECT_*`
   环境变量重连到已有 Happy 会话。会话启动后，flavor 为 `cursor` 时写 `metadata.cursorSessionId`。
3. **元数据与解析**：`api/types.ts` 的 Metadata 加 `cursorSessionId?: string`；
   `resume/resolveHappySession.ts` 的 `ResumableMetadataSchema` 加该字段；
   `resume/localResumeStore.ts` 的 `needsFreshMetadata` 对 `cursor` 检查它。
4. **启动参数**：`resume/handleResumeCommand.ts` 的 `resolveFlavor` / `buildResumeLaunch` 加 `cursor` →
   `['cursor', '--resume', cursorSessionId, '--started-by', …]`；`index.ts` 的 `cursor` 分支解析 `--resume`。
5. **daemon 恢复**：`daemon/run.ts` 的 `resumeSessionAttempt` 里，fallback 元数据合并和 `needsFetch`
   都加上 `cursor` / `cursorSessionId`。该处会给 launch 追加 `--model`，P1 的 `--model` 解析正好接住。
6. **客户端放开恢复按钮**：iOS `HappyCore/Home/SessionQuickActions.swift` 的 backendId 判断和 Android
   `ui/home/SessionQuickActions.kt` 的 `resumeAvailability` 都加 `cursorSessionId`；Android 的 metadata
   模型补解析这个字段。文案 `sessionInfo.resumeSessionMissingBackendId`（"Claude or Codex"）可顺手泛化。

完成标准：起一个 cursor 会话让它记住一个词 → `happy daemon stop-session <id>`（或用 `happy daemon list`
找到 pid 后 `kill`）结束会话进程 → 手机点恢复 →
同一个 Happy 会话变回在线，问那个词能答对，手机上历史不重复。终端 `happy resume <id>` 同样可用。

## P4 — iOS（`packages/happy-ios`）

关键陷阱：`AgentDefaults.Agent(flavor:)` 和多处 `?? .claude` 会把未知 flavor 当成 Claude，读 Claude 的默认值
和用户覆盖项。所以 `cursor` 必须成为枚举里的正式成员，不能靠兜底。

- **枚举**：`HappyCore/Home/NewSessionDraft.swift` 的 `Agent`、`HappyCore/Settings/AgentDefaults.swift` 的 `Agent`
  加 `cursor`（显示名 "Cursor"），并补齐该文件里每个 switch：
  - `codeDefaults`：permission `agent`、model `default`、effort 无；
  - `permissionModes`：`agent` / `plan` / `ask` / `yolo`（code 与契约一致，只在新建会话前使用）；
  - `hardcodedModels`：只有 `default`（模型 chip 在 ≤1 个选项时自动隐藏）；
  - `effortLevels`：空；不加入 saved-model 规则。
- **在会话中走 metadata**：`HappyCore/Composer/ModelModeOptions.swift` 的 `availablePermissionModes` 里写死的
  flavor 列表（claude/codex/openclaw/agy）**不加** cursor，这样运行中的会话用 `metadata.operatingModes`；
  模型本来就优先用 `metadata.models`。`hardcodedAgent`、`provider()` 补 `cursor` 分支。
- **可用性**：`HappyCore/NewSession/MachineChoice+NewSession.swift` 的 `agentOrder` 在 `agy` 后加 `cursor`；
  `agentAvailable` 对 cursor 按 agy 的方式**显式开启**（`cliAvailability.cursor == true` 才显示）。
- **新建会话界面**：`NewSessionScreenModel.swift` 的 `agentLabels` 加 `"cursor": "cursor"`
  （缺了会显示成 "claude"）；`HappyUI/Screens/NewSessionViews.swift` 的 `logo()` 加 `icon-cursor`。
- **附件**：`SessionComposerRules.swift` 的 `canUseAttachments(starting:)` 给 cursor 返回 `false`。
- **消息编码**：`Chat/Sending/UserMessageEncoder.swift` 不把 cursor 当 "concrete"（不用代码默认值补全 meta）。
- **头像**：`Home/SessionList.swift` 的 `SessionAvatar.Harness`、`HappyUI/Components/AvatarView.swift` 的
  `AvatarImages.harness`（以及 logo 是单色时的着色规则）、`HappyLayout/AvatarBadge.swift` 的比例。
  图片放 `HappyUI/Resources/Images/icon-cursor.png`、`@2x`、`@3x`（128/256/384 px），无生成步骤。
- **其他**：`SessionDetails/SessionDetails.swift` 的 `aiProvider` 加 "Cursor"；
  `HappyAnalytics/CoreHappenings.swift` 的 switch 把 `.cursor` 归为 `.other`；
  `MachineOpsTypes.swift` 的注释更新。
- **测试**：仿照 agy 的用例补 cursor：`SettingsLogicTests`、`SettingsPagesTests`（Agents 页会多一个 Cursor 组）、
  `ComposerModesTests`（含一个靠 metadata 动态目录的用例）、`SessionComposerRulesTests`、`OpsNewSessionTests`、
  `SecondarySessionDetailsTests`、`SessionListLayoutTests`；`Fixtures/sending.json` 手写一条 cursor 向量
  （生成器已退役）。

完成标准：上报 `cursor: true` 的机器在新建会话里显示 Cursor（带图标），未上报的不显示；新建界面不出现
Claude 的模型；进入会话后模式 chip 显示 Agent / Plan / Ask / Agent (auto-approve)，模型 chip 显示 Cursor 的模型列表；
附件按钮不可用；全部测试通过。

## P5 — Android（`packages/happy-android/app/src`）

同样的陷阱：`AgentKey.normalize` 把未知 flavor 当 Claude。另外 `codeAgentDefaults` 用 `getValue` 读取，
加了 `AgentKey.Cursor` 却不加条目会在运行时崩。

- **枚举**：`model/MachineChoices.kt` 的 `AgentType` 加 `Cursor("cursor", "Cursor")`，`Order` 里放在 Agy 后面；
  `CliAvailability.has()` 和 `isHarnessAvailable` 按 agy 的显式开启规则。
  `model/settings/AgentDefaults.kt` 加 `AgentKey.Cursor`，`codeAgentDefaults` 加条目（`agent` / `default` / null）。
- **机器 metadata**：`model/MachineMetadata.kt` 的 `CliAvailability` 加 `cursor: Boolean?`，用 optional 解析
  （必填会让整个 `cliAvailability` 解析失败）。
- **模式与模型**：`model/settings/ModeOptions.kt` 的 `permissionModes` / `modelModes` 加 `"cursor"`
  （同 iOS：`agent`/`plan`/`ask`/`yolo`，模型只有 `default`，新建会话前使用）；`availablePermissionModes` 的
  写死列表**不加** cursor；不加入 `includeConfiguredModel`、`effortLevelsForModel`。
  `sync/MessageMeta.kt` 不把 cursor 当 concrete。
- **附件**：`ui/attachments/ComposerAttachments.kt` 的 `canUseAttachments(starting)` 给 Cursor 返回 false
  （`attachments/AttachmentSupport.kt` 已经会拒绝）。
- **头像与展示**：`model/SessionPresentation.kt` 的 `AvatarHarness` 和 `resolveAvatarHarness`、
  `ui/components/Avatar.kt` 的 `harnessBadgeSizes`、drawable 映射、着色规则；在各 density 目录放
  `icon_cursor.png`（与 `icon_agy.png` 同一套目录）。`model/SessionInfo.kt` 的 `aiProviderName` 加 "Cursor"；
  `ui/machine/MachineScreen.kt` 的 CLI 可用性行加 Cursor（agy 也缺，可一起补）。
- **文案**：`res/values*/strings.xml` 是 `tools/translations/generate.mjs` 从
  `packages/happy-i18n/translations/en.json` 生成的，不要手改。需要新文案（如模式描述）时在 10 个语言的 JSON
  里都加 key，然后重新生成并提交生成物（包括 `test/resources/translation-vectors.json`）。
  若 iOS 也引用新 key，跑 `packages/happy-ios/scripts/generate-translations.mjs`。
- **测试**：`HomeModelFixtures.kt` 的 `cliAvailability` 构造器加参数；仿照 agy 补 `MachineChoicesTest`、
  `ModeOptionsTest`、`AgentDefaultsTest`、`SessionListTest`、`HomeComponentsLayoutTest`、`AttachSelectionTest`、
  `AgentsLayoutTest`（多一个 CURSOR 组）；`ComposerModesTest` 里仿照 opencode 加一个动态目录用例。

完成标准：与 P4 相同的五条行为在 Android 上成立，单测全绿。

## 顺序与依赖

- P1、P4、P5 只依赖「契约」，可并行。P4/P5 合并前不会误显示：客户端只在 `cliAvailability.cursor == true` 时显示 Cursor。
- P2、P3 依赖 P1。P3 的客户端部分（恢复按钮）随 P4/P5 一起做，或在 P3 里补。
- 需要人提供：Cursor logo 的 PNG（1x/2x/3x 及 Android 各 density）。拿到前可先用占位图，图标不阻塞其他工作。

## 端到端验收

在一台装好并登录了 `cursor-agent` 的机器上，用新 CLI 起 daemon：

1. 手机新建会话 → 选 Cursor → 发「列出当前目录文件」→ 弹审批 → 允许 → 看到工具调用与结果。
2. 切换模型（比如换成任意 Claude 模型）→ 让它说自己是什么模型；切到 Plan → 让它改文件，它应拒绝修改。
3. 切到 Agent (auto-approve) → 让它跑两条 shell 命令，不弹审批。
4. `happy daemon stop-session <id>` 结束会话进程 → 手机点恢复 → 上下文还在，历史不重复。
5. 终端 `happy cursor` 同样能完成 1。

## 风险与待确认

- **`WritableIterable is closed` 尾巴（已修复）**：在 `cursor-agent 2026.11.10-731fb78` 上确认根因——服务端发完
  `turnEnded` 关闭流后，`streamSplitter.finally` 立即关闭客户端 `WritableIterable`，若 `ClientExecController`
  尚有异步写入且未收到终态 checkpoint（`ineligible_terminal_turn`），会抛出 `WritableIterable is closed`；ACP
  模式未开 `enableAgentRetries`，`agent-session` 捕获后将其作为 `"\n\nError: RetriableError: WritableIterable is closed"`
  的普通 `agent_message_chunk` 发出并返回 `stopReason: "end_turn"`。已在 `runAcp.ts` 消息转发层过滤该噪音块
  （`isCursorSpuriousStreamCloseChunk`），保留真实鉴权/断流错误。
- **Cursor ACP 是未公开的子命令**，行为可能随版本变。「已验证的事实」一节是对照基准；集成测试在没有
  `cursor-agent` 或未登录时跳过（同 `codex.integration.test.ts` 的做法）。
- **模型 id 带参数**（方括号），手机端原样存储、原样回传即可，不要做规范化或截断。
- 通用 ACP runner 只发文本 prompt；以后要支持图片，需要在 `AcpBackend.sendPrompt` 里发 image content block
  （Cursor 声明支持），并同时放开两端的附件开关。

## 参考

- `docs/plans/generic-acp-runner.md` — 通用 ACP runner 的设计
- `docs/plans/metadata-driven-model-mode-selection.md` — 客户端如何用 metadata 渲染模型/模式
- 提交 `c42892282` — agy 接入，涉及位置最全的先例
