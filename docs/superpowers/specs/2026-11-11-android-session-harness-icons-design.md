# 安卓 session 列表的 harness 图标

## 目标

用户希望在安卓列表页辨认每个 session 使用的 harness，并选择只显示图标，不显示文字标签。

## 当前行为

- 平铺 session 行支持头像角标，但受 `showFlavorIcons` 控制，该设置默认关闭。
- 按项目分组的 session 行未展示 harness 图标。同一项目或 worktree 下的 session 可以使用不同 harness，因此必须按 session 展示。
- `SessionRowData` 已携带 `flavor` 和 `clientId`。Happy Agent 连接的 conversation 使用 Happy harness。
- 已有 Claude、Codex、Cursor、Antigravity、Gemini 和 Happy 图片资源，可直接复用。

## 方案比较

- 文字标签：容易辨认，但更占空间。用户已选择仅显示图标。
- 头像角标：平铺列表已有支持，但项目分组中的 session 行没有头像，无法统一覆盖。
- 标题前的小图标：能覆盖有头像和没有头像的 session 行。建议采用此位置，尺寸 16 dp，标题间隔 6 dp。

## 建议设计

- 在每个可见 session 的标题前展示一个 harness 图标，覆盖平铺、项目根目录、worktree、归档、bot、task 和 Happy Agent conversation 行。
- 项目、worktree 和机器的分组标题不代表单个 session，不额外添加 harness 图标。
- 复用现有图片和主题配色；图标为独立标识，不再在同一行叠加重复的头像 harness 角标。
- Happy Agent 标识优先于底层模型供应商；Codex 的 `openai` / `gpt` 别名使用 Codex 图标。
- 对未知或缺失的 harness 显示通用图标，不将其误标为 Claude。屏幕阅读器能读出已知 harness 名称或未知状态。
- 复用“在会话列表显示 harness 图标”设置，将安卓默认值设为开启。明确保存的关闭值仍然有效；实施报告会说明如何开启已有账号的设置。
- 保留行高、树形缩进、点击及长按、归档、选中、工作状态、未读提示和 git 统计行为；长标题让出图标空间并省略。
- 沿用 Kotlin / Jetpack Compose，不增加图片生成、依赖或服务端字段。

## 验证

- 测试 harness 解析：Claude、Codex、Cursor、Antigravity、Gemini、Happy、别名以及未知值。
- Compose 测试验证平铺和项目/worktree 的不同 session 展示各自图标，并覆盖归档、Happy Agent、设置关闭和长标题布局。
- 按安卓仓库要求在指定构建环境运行相关单元及布局测试；环境不可用时明确报告。

## 状态

用户已选择仅显示图标；上述具体位置、默认值和覆盖范围为待确认的建议。
