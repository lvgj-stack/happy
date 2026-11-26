# Android：在某个 worktree 下直接创建会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建会话的目录菜单按仓库分组、worktree 挂在仓库下一键选中；首页 worktree 行和会话长按菜单可以直接进入“在这个 worktree 新建会话”。

**Architecture:** 分组、选择和草稿迁移都放在纯 Kotlin 的 `model/NewSessionOptions.kt` / `model/NewSession.kt` 里（单元测试覆盖），UI 只读 `NewSessionOptions` 新增的 `placeKey` / `placeTitle` 和 `PickerOption.depth`。首页两个入口共用一个 `NewChatPlace` 模型，加上现有但还没人调用的 `NewSessionServices.prepareCheckout`，再加 `HomeNavigation.onCompose`。

**Tech Stack:** Kotlin, Jetpack Compose, JUnit4 + Robolectric (`./gradlew testDebugUnitTest`)

**Spec:** `docs/superpowers/specs/2026-11-26-android-worktree-session-design.md`

## Global Constraints

- 只改 `packages/happy-android`，iOS 不动。
- 带 `projectId` 的地点（Happy Agent 项目和 workspace）行为不变。
- 项目卡片 `+`（`prepareWorkspace`，新建 worktree）行为不变。
- 新文案放 `app/src/main/res/values*/strings_home.xml`，10 个语言目录都要加：`values`、`values-b+zh+Hans`、`values-b+zh+Hant`、`values-ca`、`values-es`、`values-it`、`values-ja`、`values-pl`、`values-pt`、`values-ru`。
- 所有命令在 `packages/happy-android` 下运行；如本机需要，前缀 `GRADLE_USER_HOME=$PWD/../../.context/gradle-home`。
- 提交直接在当前分支，提交信息末尾带：
  ```
  Generated with [Claude Code](https://claude.ai/code)
  via [Happy](https://happy.engineering)

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Co-Authored-By: Happy <yesreply@happy.engineering>
  ```

## Review Focus

1. 先选 worktree 行，再选仓库行：必须回到主目录（`SessionType.Simple`），不能悄悄变成“新建 worktree”。→ Task 1 `aRepoRowAfterAWorktreeIsTheMainCheckout`
2. 某个 worktree 的仓库本身从没被会话用过：仍要有仓库行，而且 worktree 挂在它下面。→ Task 1 `aWorktreeWhoseRepoWasNeverUsedGetsARepoRow`
3. 路径在 worktree 里面更深一层（`…/.dev/worktree/cursor-x/packages/happy-cli`）：显示成 `cursor-x › packages/happy-cli`，选中后在这个子目录启动。→ Task 1 `aFolderInsideAWorktreeKeepsItsSubpath`
4. 草稿里存的旧数据 `selectedPath` 就是 worktree 路径（升级前存下的，或手动输入的）：reconcile 和 `selectPath` 都要拆成“仓库 + worktree”，`worktreeKey` 用绝对路径。→ Task 1 `aDraftOnAWorktreePathBecomesRepoAndWorktree`、`aTypedWorktreePathIsAWorktreePick`
5. bot、task、Happy Agent 项目里的会话：长按菜单里没有“在此目录新建会话”，worktree 行上也没有 `+`。→ Task 3 `newChatPlaceSkipsBotsTasksAndHappyAgentProjects`

---

### Task 1: 目录菜单分组、worktree 选择、草稿迁移（模型层）

**Files:**
- Modify: `app/src/main/kotlin/com/slopus/happy/model/NewSessionOptions.kt`（`PickerOption`，`selectingProject`，`NewSessionOptions` 字段和 `reconcile`/`sections`，`resolveNewSessionOptions` 里构建 `projectOptions` 的部分，约 16-22、113-117、200-224、247-283 行）
- Modify: `app/src/main/kotlin/com/slopus/happy/model/SessionPresentation.kt`（`WorktreePaths`，约 96-111 行）
- Modify: `app/src/main/kotlin/com/slopus/happy/ui/home/NewSessionServices.kt:226`（`selectPath`）
- Test: `app/src/test/kotlin/com/slopus/happy/model/NewSessionOptionsTest.kt`

**Interfaces:**
- Produces:
  - `PickerOption.depth: Int = 0`：0 表示顶层行，1 表示挂在仓库下的 worktree 行。
  - `WorktreePaths.label(path: String): String?`：`worktreeName` 里的第一个 `/` 换成 ` › `，不是 worktree 路径时返回 null。
  - `NewSessionDraft.selectingPath(path: String): NewSessionDraft`：
    - `path` 是 worktree 路径 → `withPath(repoPath(path)).selectingWorktree(path)`。
    - 否则，如果原草稿的 `worktreeKey != null`（选的是已有 worktree）→ `withPath(path).selectingWorktree(WorktreeSelection.NONE)`。
    - 否则 → `withPath(path)`（`NEW` 保持不变）。
  - `NewSessionOptions.homeDir: String? = null`
  - `NewSessionOptions.placeKey: String?`：在 projects 里，`draft.worktreeKey` 对应的那条 depth-1 行的 key；没有就是 `project?.key`。
  - `NewSessionOptions.placeTitle: String?`：选的是已有 worktree 时，是“仓库行的相对路径 + ` › ` + `WorktreePaths.label(worktreeKey)`”（`label` 为 null 时用 worktree 行的 name）；选的是普通路径行时，是相对路径（就是现在的 `name`）；Happy Agent 项目行时，是 `project?.name`。

- [ ] **Step 1: 写失败的测试**（加到 `NewSessionOptionsTest`，沿用文件里的 `resolve(...)`、`studio`、`session`、`metadata`）

```kotlin
private fun cli(id: String, path: String) = session(id, metadata(path = path) { put("machineId", "m1") })

@Test fun worktreesHangUnderTheirRepo() {
    val sessions = listOf(
        cli("a", "/Users/dev/code/happy/.dev/worktree/calm"),
        cli("b", "/Users/dev/other"),
        cli("c", "/Users/dev/code/happy"),
        cli("d", "/Users/dev/code/happy/.dev/worktree/bold"),
    )
    val options = resolve(NewSessionDraft(selectedMachineId = "m1", selectedPath = "/Users/dev/other"), listOf(studio), sessions)
    // Groups keep the order of their first appearance; the repo leads its worktrees.
    assertEquals(
        listOf("/Users/dev/code/happy", "/Users/dev/code/happy/.dev/worktree/calm", "/Users/dev/code/happy/.dev/worktree/bold", "/Users/dev/other"),
        options.projects.map { it.key }.filter { it != "~" },
    )
    val byKey = options.projects.associateBy { it.key }
    assertEquals("happy" to "~/code/happy", byKey.getValue("/Users/dev/code/happy").let { it.name to it.description })
    assertEquals(0, byKey.getValue("/Users/dev/code/happy").depth)
    assertEquals("calm", byKey.getValue("/Users/dev/code/happy/.dev/worktree/calm").name)
    assertEquals(1, byKey.getValue("/Users/dev/code/happy/.dev/worktree/calm").depth)
    assertEquals("~/code/happy/.dev/worktree/calm", byKey.getValue("/Users/dev/code/happy/.dev/worktree/calm").description)
    // "~" is named "~" and says nothing twice.
    assertNull(byKey.getValue("~").description)
}

@Test fun aWorktreeWhoseRepoWasNeverUsedGetsARepoRow() {
    val options = resolve(NewSessionDraft(selectedMachineId = "m1"), listOf(studio), listOf(cli("a", "/Users/dev/web/.dev/worktree/sharp")))
    val keys = options.projects.map { it.key }
    assertEquals(keys.indexOf("/Users/dev/web") + 1, keys.indexOf("/Users/dev/web/.dev/worktree/sharp"))
    assertEquals("web", options.projects.first { it.key == "/Users/dev/web" }.name)
}

@Test fun aFolderInsideAWorktreeKeepsItsSubpath() {
    val path = "/Users/dev/code/happy/.dev/worktree/cursor-x/packages/happy-cli"
    val options = resolve(NewSessionDraft(selectedMachineId = "m1"), listOf(studio), listOf(cli("a", path)))
    assertEquals("cursor-x › packages/happy-cli", options.projects.first { it.key == path }.name)
    val picked = NewSessionDraft(selectedMachineId = "m1").selectingProject(path, listOf(studio), overrides)
    assertEquals(Triple("/Users/dev/code/happy", SessionType.Worktree, path), Triple(picked.selectedPath, picked.sessionType, picked.worktreeKey))
}

@Test fun aWorktreeRowPicksRepoAndWorktreeAtOnce() {
    val sessions = listOf(cli("c", "/Users/dev/code/happy"), cli("a", "/Users/dev/code/happy/.dev/worktree/calm"))
    val draft = NewSessionDraft(selectedMachineId = "m1").selectingProject("/Users/dev/code/happy/.dev/worktree/calm", listOf(studio), overrides)
    assertEquals(Triple("/Users/dev/code/happy", SessionType.Worktree, "/Users/dev/code/happy/.dev/worktree/calm"), Triple(draft.selectedPath, draft.sessionType, draft.worktreeKey))
    val options = resolve(draft, listOf(studio), sessions)
    assertEquals("/Users/dev/code/happy/.dev/worktree/calm", options.placeKey)
    assertEquals("~/code/happy › calm", options.placeTitle)
}

@Test fun aRepoRowAfterAWorktreeIsTheMainCheckout() {
    val onWorktree = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/Users/dev/code/happy", sessionType = SessionType.Worktree, worktreeKey = "/Users/dev/code/happy/.dev/worktree/calm")
    val back = onWorktree.selectingProject("/Users/dev/code/happy", listOf(studio), overrides)
    assertEquals(SessionType.Simple to null, back.sessionType to back.worktreeKey)
    // A new worktree asked for (the project card's +) stays asked for across a folder change.
    val asked = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/a").selectingWorktree(WorktreeSelection.NEW)
    assertEquals(SessionType.Worktree, asked.selectingProject("/b", listOf(studio), overrides).sessionType)
}

@Test fun aDraftOnAWorktreePathBecomesRepoAndWorktree() {
    val home = machine("m1", machineMetadata { put("displayName", "Studio"); put("homeDir", "/Users/dev"); cliAvailability(claude = true) })
    val draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "~/code/happy/.dev/worktree/calm")
    val next = resolve(draft, listOf(home)).reconcile(draft, listOf(home), overrides)
    assertEquals(Triple("~/code/happy", SessionType.Worktree, "/Users/dev/code/happy/.dev/worktree/calm"), Triple(next.selectedPath, next.sessionType, next.worktreeKey))
}

@Test fun aTypedWorktreePathIsAWorktreePick() {
    val typed = NewSessionDraft(selectedMachineId = "m1").selectingPath("/Users/dev/code/happy/.dev/worktree/calm")
    assertEquals("/Users/dev/code/happy" to "/Users/dev/code/happy/.dev/worktree/calm", typed.selectedPath to typed.worktreeKey)
}
```

如果 `machineMetadata` 写 `homeDir` 的方式和上面不一样，以 `HomeModelFixtures.machineMetadata` 的签名为准，含义不变：这台机器的 home 是 `/Users/dev`。

同时更新已有的 `placesAreNamedRelativeToHomeAndProjectsByName`：`/Users/dev/code` 的 name 改为 `"code"`，description 是 `"~/code"`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `./gradlew testDebugUnitTest --tests 'com.slopus.happy.model.NewSessionOptionsTest'`
Expected: 编译失败（`depth`、`placeKey`、`placeTitle`、`selectingPath` 都还不存在）

- [ ] **Step 3: 实现**

  - `PickerOption` 加 `depth: Int = 0`。
  - `WorktreePaths.label`。
  - `selectingPath`。`selectingProject` 对非 project key 改为调用 `selectingPath(key)`。
  - `resolveNewSessionOptions` 的 `projectOptions`：带 `projectId` 的地点和 `path == null` 的地点照旧原样输出。没有 `projectId` 的路径地点按 `WorktreePaths.repoPath(place.path)` 分组，组的位置取组内第一次出现的位置。每组输出：仓库行（key 是仓库路径，name 是最后一级文件夹名，`~` 仍叫 `~`；description 是相对路径，和 name 相同时设为 null），然后是这组的 worktree 行（`depth = 1`，name 是 `WorktreePaths.label`，description 是相对路径）。worktree 行按出现顺序排。
  - 把 `homeDir` 填进 options；计算 `placeKey` 和 `placeTitle`。
  - `reconcile`：`selectedProjectId == null`，且 `selectedPath` 是 worktree 路径时，改写成 `selectedPath = repoPath(selectedPath)`、`sessionType = Worktree`、`worktreeKey = resolveAbsolutePath(selectedPath, homeDir)`。这一步放在现有的“不支持 worktree 就清掉”那条规则**之前**。
  - `sections(Project)` 返回的选中 key 改为 `placeKey`。
  - `NewSessionServices.selectPath` 改为调用 `selectingPath`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `./gradlew testDebugUnitTest --tests 'com.slopus.happy.model.*' --tests 'com.slopus.happy.ui.home.*'`
Expected: PASS。如果有其他测试断言旧的 `~/code` 这种 name，按新规则更新它们的期望值。

- [ ] **Step 5: 提交**

```bash
git add app/src/main/kotlin/com/slopus/happy/model app/src/main/kotlin/com/slopus/happy/ui/home/NewSessionServices.kt app/src/test/kotlin/com/slopus/happy/model
git commit -m "feat(android): group the new chat's folders by repo, worktrees one tap under it"
```

---

### Task 2: 菜单和 Folder 行显示分组与 worktree

**Files:**
- Modify: `app/src/main/kotlin/com/slopus/happy/ui/chat/ComposeChat.kt`（Folder 行约 475-495 行，`FolderMenu` 约 664-690 行，`MenuOption` 约 761 行）
- Modify: `app/src/main/kotlin/com/slopus/happy/ui/home/HomeDockFocus.kt`（`PickerPanel` 约 410-445 行）
- Test: `app/src/test/kotlin/com/slopus/happy/journeys/ComposeJourneyTest.kt`

**Interfaces:**
- Consumes: Task 1 的 `PickerOption.depth`、`NewSessionOptions.placeKey`、`NewSessionOptions.placeTitle`。

- [ ] **Step 1: 写失败的测试**（新增一个 journey，写法照 `theComputerIsAlwaysAskedWithItsStatusAndTheFoldersFollowIt`）

```kotlin
@Test
fun aWorktreeIsPickedFromUnderItsRepoInOneTap() {
    journey.machine()
    journey.session("s0", updatedAt = 100, path = "/h/repo", title = "Main chat")
    journey.session("s1", updatedAt = 200, path = "/h/repo/.dev/worktree/calm", title = "Worktree chat")
    val graph = journey.graph()
    journey.signIn(graph)
    val newSession = HomeServices.of(graph).newSession(ApplicationProvider.getApplicationContext())
    rule.setContent { HappyApp(graph) }
    rule.waitFor(FlatRowTags.ROW)
    rule.node(HomeTags.COMPOSE).performClick()
    rule.waitFor(NewWorkTags.FOLDER)
    rule.waitUntil(5_000) { newSession.options.value?.machinesSynced == true }
    rule.node(NewWorkTags.FOLDER).performClick()
    rule.waitFor(ComposeChatTags.FOLDER_MENU)
    rule.node(ComposeChatTags.option(NewSessionPage.Project, "/h/repo")).assertExists()
    rule.node(ComposeChatTags.option(NewSessionPage.Project, "/h/repo/.dev/worktree/calm")).assert(hasText("calm")).performClick()
    rule.waitUntil(5_000) { newSession.draft.value.worktreeKey == "/h/repo/.dev/worktree/calm" }
    assertEquals("/h/repo", newSession.draft.value.selectedPath)
    rule.node(NewWorkTags.FOLDER).assertContentDescriptionEquals("Project: ~/repo › calm")
    // The worktree is the one ticked when the menu opens again.
    rule.node(NewWorkTags.FOLDER).performClick()
    rule.node(ComposeChatTags.option(NewSessionPage.Project, "/h/repo/.dev/worktree/calm")).assertIsSelected()
}
```

如果 `HappyMenuItem` 的选中态不暴露 `Selected` 语义，最后一句改为按它现有的选中态语义断言（看 `OptionMenus.kt:117`），断言的含义不变。

- [ ] **Step 2: 运行测试，确认失败**

Run: `./gradlew testDebugUnitTest --tests 'com.slopus.happy.journeys.ComposeJourneyTest'`
Expected: 新测试 FAIL，Folder 行描述仍是 `Project: ~/repo`

- [ ] **Step 3: 实现**

  - ComposeChat 的 Folder 行：标题和 contentDescription 用 `current?.placeTitle ?: "~"`。
  - `FolderMenu` 的选中判断改为 `option.key == options.placeKey`。
  - `MenuOption`：`depth > 0` 时左边缩进 16dp，`leading` 放 16dp 的 `Ionicon.GitBranchOutline`，颜色 `textSecondary`。
  - `PickerPanel`：选中 key 已经从 `sections` 拿到，这里不用改；`depth > 0` 时给 `PickerSheetOption` 传 `labelIcon = Ionicon.GitBranchOutline`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `./gradlew testDebugUnitTest --tests 'com.slopus.happy.journeys.ComposeJourneyTest' --tests 'com.slopus.happy.ui.chat.*' --tests 'com.slopus.happy.ui.home.*'`
Expected: PASS（原有的 `Project: ~/repo` 断言也不受影响）

- [ ] **Step 5: 提交**

```bash
git add app/src/main/kotlin/com/slopus/happy/ui app/src/test/kotlin/com/slopus/happy/journeys/ComposeJourneyTest.kt
git commit -m "feat(android): the compose chat's folder menu and row show the picked worktree"
```

---

### Task 3: 首页 worktree 行的 `+`

**Files:**
- Modify: `app/src/main/kotlin/com/slopus/happy/model/ProjectHomeRows.kt`（在 `WorkspaceOrigin` 旁边，约 156 行）
- Modify: `app/src/main/kotlin/com/slopus/happy/ui/home/HomeListCallbacks.kt`
- Modify: `app/src/main/kotlin/com/slopus/happy/ui/home/ProjectHomeList.kt`（`WorktreeRow` 约 452-500 行）
- Modify: `app/src/main/kotlin/com/slopus/happy/ui/home/HomeListHost.kt`（约 104-145 行）
- Modify: 10 个 `app/src/main/res/values*/strings_home.xml`
- Test: `app/src/test/kotlin/com/slopus/happy/model/ProjectHomeRowsTest.kt`、`app/src/test/kotlin/com/slopus/happy/ui/home/HomeLayoutTest.kt`

**Interfaces:**
- Produces:
  - `data class NewChatPlace(val machineId: String, val path: String)`
  - `fun newChatPlace(machineId: String?, projectId: String?, path: String?, botOrTask: Boolean = false): NewChatPlace?`：`botOrTask`、`projectId != null`、`machineId` 为空、`path` 去空白后为空，这几种情况都返回 null。
  - `fun newChatPlace(session: SessionRowData): NewChatPlace?`：用行数据里的 `machineId`、`projectId`、`path` 调用上面的版本。
  - `fun Session.newChatPlace(): NewChatPlace?`：用 `metadata?.machineId`、`projectIdOrNull()`、`metadata?.path`、`botOrTask = metadata?.bot != null || isTask` 调用上面的版本。
  - `HomeListCallbacks.onNewChatIn: (NewChatPlace) -> Unit = {}`
  - 字符串 `home_new_chat_in`（`%1$s` 是 worktree 名）

- [ ] **Step 1: 写失败的测试**

`ProjectHomeRowsTest`：
```kotlin
@Test fun newChatPlaceSkipsBotsTasksAndHappyAgentProjects() {
    assertEquals(NewChatPlace("m1", "/h/repo/.dev/worktree/calm"), newChatPlace("m1", null, " /h/repo/.dev/worktree/calm "))
    assertNull(newChatPlace("m1", "p1", "/h/repo"))
    assertNull(newChatPlace(null, null, "/h/repo"))
    assertNull(newChatPlace("m1", null, " "))
    assertNull(newChatPlace("m1", null, "/h/repo", botOrTask = true))
}
```
返回值里的 `path` 要去掉首尾空白。

`HomeLayoutTest`：新增 git worktree 的 fixture。两个 CLI 会话，`metadata(path = "/h/happy")` 和 `metadata(path = "/h/happy/.dev/worktree/calm")`，都带 `machineId`，`grouping = SessionListGrouping.Project`：
```kotlin
@Test fun aGitWorktreeRowStartsANewChatInIt() {
    val asked = mutableListOf<NewChatPlace>()
    // show(...) with callbacks whose onNewChatIn = { asked += it }, as the test at line ~630 builds its own callbacks
    rule.onNode(hasContentDescription("New chat in calm") and hasRole(Role.Button)).performClick()
    assertEquals(listOf(NewChatPlace("m1", "/h/happy/.dev/worktree/calm")), asked)
    rule.assertActionsLabelled()
}
```
并在 `projectRowsReadAsButtons`（Happy Agent 的 Gdansk workspace）里补一句：`rule.onAllNodes(hasContentDescription("New chat in", substring = true)).assertCountEquals(0)`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `./gradlew testDebugUnitTest --tests 'com.slopus.happy.model.ProjectHomeRowsTest' --tests 'com.slopus.happy.ui.home.HomeLayoutTest'`
Expected: 编译失败（`NewChatPlace` 不存在）

- [ ] **Step 3: 实现**

  - 上面 Interfaces 里列出的模型函数和回调。
  - `WorktreeRow`：`newChatPlace(worktree.session)` 不为 null 时，在 `ProjectGitChanges` 和 `FoldChevron` 之间放一个 `+`。尺寸、图标和颜色照项目卡片的 `PROJECT_ADD`；新增 tag `ProjectListTags.WORKTREE_ADD = "projectList.worktreeAdd"`；`contentDescription = stringResource(R.string.home_new_chat_in, worktree.workspaceName ?: worktree.projectName)`。
  - `HomeListHost`：`onNewChatIn = { place -> services.newSession(ctx).prepareCheckout(place.machineId, place.path, services.machine(place.machineId)?.metadata?.homeDir); navigation.onCompose() }`，传进 `HomeListCallbacks`。
  - 文案 `home_new_chat_in`：

| 目录 | 文案 |
|---|---|
| values | `New chat in %1$s` |
| values-b+zh+Hans | `在 %1$s 中新建会话` |
| values-b+zh+Hant | `在 %1$s 中新建對話` |
| values-ca | `Nou xat a %1$s` |
| values-es | `Chat nuevo en %1$s` |
| values-it | `Nuova chat in %1$s` |
| values-ja | `%1$s で新規チャット` |
| values-pl | `Nowy czat w %1$s` |
| values-pt | `Novo chat em %1$s` |
| values-ru | `Новый чат в %1$s` |

- [ ] **Step 4: 运行测试，确认通过**

Run: `./gradlew testDebugUnitTest --tests 'com.slopus.happy.model.*' --tests 'com.slopus.happy.ui.home.*' --tests 'com.slopus.happy.ui.tablet.*'`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add app/src/main app/src/test
git commit -m "feat(android): a git worktree's row on home starts a new chat in it"
```

---

### Task 4: 会话长按菜单“在此目录新建会话”

**Files:**
- Modify: `app/src/main/kotlin/com/slopus/happy/ui/home/SessionQuickActions.kt:49-69`
- Modify: `app/src/main/kotlin/com/slopus/happy/ui/home/SessionMenus.kt`（`rememberSessionMenus`、`SessionMenuStrings`、`buildMenu`）
- Modify: `app/src/main/kotlin/com/slopus/happy/ui/home/HomeListHost.kt:90`
- Modify: 10 个 `strings_home.xml`
- Test: `app/src/test/kotlin/com/slopus/happy/ui/home/HomeListTest.kt`（约 330 行）、`TasksHomeTest.kt`

**Interfaces:**
- Consumes: Task 3 的 `Session.newChatPlace()`、`NewChatPlace`，以及 `HomeListHost` 里的 `onNewChatIn` lambda（Task 3 写的那个，这里复用，不要再写一份）。
- Produces: `SessionActionId.NewChatHere`，排在 `Details` 后面；`rememberSessionMenus(..., onNewChatHere: ((NewChatPlace) -> Unit)? = null)`。为 null 时这一项不显示，和 `onDetails` 的做法一样。

- [ ] **Step 1: 写失败的测试**

在 `HomeListTest` 约 330 行，把两处期望列表都改成 `Details` 后面紧跟 `SessionActionId.NewChatHere`（那两个会话都有 machine 和 path）。再加一个：
```kotlin
@Test fun botsAndTasksOfferNoNewChatHere() {
    // a bot session (metadata with bot) and a task session from this file's / TasksHomeTest's fixtures
    assertFalse(SessionActionId.NewChatHere in sessionActionIds(bot, null, continuationExperiments = false, devMode = false))
    assertFalse(SessionActionId.NewChatHere in sessionActionIds(task, null, continuationExperiments = false, devMode = false))
}
```
`TasksHomeTest` 里如果有断言 task 菜单项列表的地方，确认它不包含 `NewChatHere`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `./gradlew testDebugUnitTest --tests 'com.slopus.happy.ui.home.HomeListTest' --tests 'com.slopus.happy.ui.home.TasksHomeTest'`
Expected: 编译失败（`NewChatHere` 不存在）

- [ ] **Step 3: 实现**

  - `sessionActionIds`：在 `Details` 之后，`session.newChatPlace() != null` 时加入 `NewChatHere`。
  - `SessionMenus`：`NewChatHere -> onNewChatHere?.let { cb -> session.newChatPlace()?.let { place -> AlertButton(strings.newChatHere) { cb(place) } } }`。
  - `HomeListHost`：把 Task 3 里的 `onNewChatIn` 提到 `rememberSessionMenus` 调用之前，同时传给 `onNewChatHere` 和 `HomeListCallbacks`。
  - 文案 `session_new_chat_here`：

| 目录 | 文案 |
|---|---|
| values | `New chat here` |
| values-b+zh+Hans | `在此目录新建会话` |
| values-b+zh+Hant | `在此目錄新建對話` |
| values-ca | `Nou xat aquí` |
| values-es | `Chat nuevo aquí` |
| values-it | `Nuova chat qui` |
| values-ja | `ここで新規チャット` |
| values-pl | `Nowy czat tutaj` |
| values-pt | `Novo chat aqui` |
| values-ru | `Новый чат здесь` |

- [ ] **Step 4: 运行全部单测，确认通过**

Run: `./gradlew testDebugUnitTest`
Expected: BUILD SUCCESSFUL

- [ ] **Step 5: 提交**

```bash
git add app/src/main app/src/test
git commit -m "feat(android): New chat here in a session's menu, in the same folder or worktree"
```

---

### Task 5: 装机验证

- [ ] **Step 1:** `./gradlew assembleDebug` 成功。
- [ ] **Step 2:** 如果有可用的设备或模拟器（`adb devices`），按 `.agents/skills` 或 `packages/happy-android/AGENTS.md` 里的装机方式安装，然后检查三处：
  - Folder 菜单是分组的，点 worktree 后 Folder 行显示 `~/… › 名字`，发送后会话的 path 是这个 worktree。
  - project 视图 worktree 行的 `+` 能打开预填好的输入框。
  - 长按会话有“在此目录新建会话”。

  截图发给用户。没有设备就在报告里说明没做装机验证。
