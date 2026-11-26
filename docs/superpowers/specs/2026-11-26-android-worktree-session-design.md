# Android：直接在某个 worktree 下创建会话

## 为什么

用户在手机上经常想在某个已有的 worktree 里开新会话。现在有两处体验不好：

1. 新建会话页的 Projects 选择器把以前会话用过的目录全部平铺，worktree 路径
   （`…/.dev/worktree/xxx`）和仓库混在一起，标题和副标题是同一个路径，
   worktree 名字还被截断，看不出哪条是哪个 worktree。
2. 首页（外部界面）没有“在这个 worktree 里开会话”的快捷入口：project 视图里
   worktree 行只能折叠，项目卡片的 `+` 只会新建 worktree。

## 目标

- Projects 选择器按仓库分组，worktree 缩进挂在仓库下面，点一下 worktree 行就同时
  选中仓库和这个 worktree（方案 B）。
- 首页可以一步进入“在某个 worktree 新建会话”的输入框。

## 非目标

- 不改 iOS。
- 不改 Happy Agent（Rig）项目的 workspace 逻辑：带 `projectId` 的地点保持原样。
- 不改项目卡片 `+` 的行为（仍是新建 worktree）。

## 方案（已选 B）

- **A. 项目列表只留仓库**：worktree 只能从 Worktree 行选，需要点两次。没选。
- **B. 按仓库分组，worktree 挂在下面**（已选）：一次点完，最贴近“直接在 worktree 下建会话”。

## 设计

### 1. Projects 选择器（`NewSessionOptions`）

- 把没有 `projectId` 的路径地点按 `WorktreePaths.repoPath` 分组：先是仓库行，紧跟着它的
  worktree 行（缩进，带分支图标）。如果某个 worktree 的仓库本身从没被会话用过，也要补一条仓库行。
- 仓库行：标题是文件夹名（`~` 仍显示 `~`），副标题是相对 home 的路径。原来标题和副标题重复的问题顺带改掉。
- worktree 行：标题是 worktree 名（`WorktreePaths.worktreeName`）。如果路径还在 worktree
  里面再往下几层（例如 `cursor-x/packages/happy-cli`），就显示为 `cursor-x › packages/happy-cli`。副标题是路径。
- 选中 worktree 行：草稿变成 `selectedPath = 仓库（相对 home）`、`sessionType = Worktree`、
  `worktreeKey = worktree 的完整路径`，和现有的 `prepareCheckout` 一样。启动时会话在
  worktree 目录里启动（`SessionStarter` 现有逻辑）。
- 勾选标记：草稿指向某个已有 worktree 时，勾在这条 worktree 行上，否则勾在仓库行上。
- 旧草稿迁移：`selectedPath` 本身就是 worktree 路径的草稿，在 reconcile 时改写成“仓库 + worktree”。
- 选了 worktree 再选仓库行，回到仓库主目录（`sessionType = Simple`），不会变成“新建 worktree”。
  手动输入的自定义路径如果是 worktree 路径，也按 worktree 行处理。
- 截图里的界面是 `ComposeChat`（首页 compose 按钮打开的那个），它**没有**单独的 Worktree 行，
  只有 Folder 行加下拉菜单。所以 Folder 行的标题要能显示 worktree：仓库照旧显示相对路径（`~/code/ai/happy`），
  worktree 显示成 `~/code/ai/happy › clever-meadow`（这一行本来就是从开头截断，末尾的 worktree 名能露出来）。
- 旧的新建会话页（`HomeDockFocus` 的 picker 面板）也用同一份分组列表，它那行 Worktree 选择器保持不变。

### 2. 首页快捷入口

两个入口都调用 `prepareCheckout(machineId, path, homeDir)`，再打开新建输入框
（`navigation.onCompose()`），预填好这个 worktree，用户写完第一句后发送。手机和平板都适用。

- **project 视图的 worktree 行**：右侧加一个 `+`（样式同项目卡片的 `+`，放在 git 变更数和折叠箭头前面），
  无障碍描述类似“在 xxx 中新建会话”。
- **会话长按菜单**：新增一项“在此目录新建会话”（`SessionActionId.NewChatHere`），
  平铺视图也能用。bot 和 task 会话、Happy Agent 项目里的会话（带 `projectId`），
  以及没有 machine 或 path 的会话都不显示这一项。worktree 行的 `+` 也按同样的规则决定显不显示。

### 3. 文案

这两条是安卓自己的文案，和 `home_create_workspace_in` 一样放在 `app/src/main/res/values*/strings_home.xml`，
10 种语言都要补，不走 `packages/happy-i18n`。

## 留给实现者决定

- `PickerOption` 怎么表达缩进和图标（加字段，或者加一个行类型）。
- 测试放在现有的 `NewSessionOptionsTest`、`HomeLayoutTest`、`SessionQuickActions` 相关测试旁边。
