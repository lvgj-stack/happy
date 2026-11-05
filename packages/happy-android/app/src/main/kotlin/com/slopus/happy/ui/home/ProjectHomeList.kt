package com.slopus.happy.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.FlatRowTopRight
import com.slopus.happy.model.ProjectHomeEntry
import com.slopus.happy.model.ProjectHomeRow
import com.slopus.happy.model.ProjectHomeSection
import com.slopus.happy.model.ProjectWorktree
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.VisibleGitChanges
import com.slopus.happy.model.WorkspaceOrigin
import com.slopus.happy.model.WorktreeToggle
import com.slopus.happy.model.activity
import com.slopus.happy.model.compactCount
import com.slopus.happy.model.projectGitChanges
import com.slopus.happy.model.resolveFlatRowPresentation
import com.slopus.happy.model.workspaceOrigin
import com.slopus.happy.ui.chat.light
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ProjectListTags {
    const val SECTION = "projectList.section"
    const val MACHINE = "projectList.machine"
    const val PROJECT = "projectList.project"
    const val PROJECT_ADD = "projectList.projectAdd"
    const val WORKTREE = "projectList.worktree"
    const val TOGGLE = "projectList.toggle"
    const val CHAT = "projectList.chat"
    const val TREE_STEM = "projectList.treeStem"
    const val TREE_TRUNK = "projectList.treeTrunk"
    const val CHECKOUT_CHAT = "projectList.checkoutChat"
    const val CHEVRON = "projectList.chevron"
    const val WORKTREE_ICON = "projectList.worktreeIcon"
}

/** ProjectHomeList.tsx */
object ProjectListSpec {
    val rowPaddingX = 16.dp
    val avatar = 28.dp
    val avatarGap = 12.dp
    val projectRow = 52.dp
    val projectRowTop = 8.dp
    val worktreeRow = 48.dp
    val botRow = 48.dp
    val trailingGap = 8.dp
    val statusDot = 7.dp
    val chatDot = 10.dp
    val addButtonWidth = 28.dp
    val addButtonHeight = 32.dp
    val chevron = 14.dp
    /** A worktree's branch glyph, where its name would start; its chats' line drops from its middle. */
    val worktreeIcon = 16.dp
    val worktreeIconGap = 6.dp
    val section = happyTextStyle(fontSize = 11, lineHeight = 14, letterSpacing = 0.6f, weight = FontWeight.SemiBold)
    val machine = happyTextStyle(fontSize = 11, lineHeight = 14)
    val projectName = happyTextStyle(fontSize = 17, lineHeight = 22)
    val worktreeName = happyTextStyle(fontSize = 16, lineHeight = 21)
    val toggle = happyTextStyle(fontSize = 15, lineHeight = 20)
    val gitCount = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val gitApproximate = happyTextStyle(fontSize = 11, lineHeight = 18)
    const val ARCHIVED_ALPHA = 0.6f
    /** Where every row's name starts, and so its hairline in a card. */
    val nameX = rowPaddingX + avatar + avatarGap
    /** A computer's heading over its cards: in line with the cards' avatars (iOS's MachineHeaderLayout). */
    val cardMachinePaddingX = HomeCardSpec.inset + rowPaddingX
    val cardMachinePaddingTop = 20.dp
    val cardMachinePaddingBottom = 8.dp

    /** A card row's fixed height, whatever it says: a project 52, the rest 48. */
    fun cardRowHeight(row: ProjectHomeRow): Dp = if (row is ProjectHomeRow.ProjectCard) projectRow else worktreeRow
}

/** StyleSheet.hairlineWidth * 2: the tree lines. */
@Composable
private fun treeLine(): Dp = with(LocalDensity.current) { 2f.toDp() }

/**
 * One row of the project hierarchy: under each computer its bots and
 * projects; a project card (28 avatar, 52 high) with its own chats, then
 * its worktrees, hanging off a tree line (48 high each), each worktree's
 * chats one lane further in (names at 96), then the toggle that shows the
 * worktrees all or fewer; the archive tail drawn the way the flat list
 * draws it. A tap on a project's or a worktree's row folds its chats away
 * or lists them again (Android's own; iOS opens the newest chat).
 *
 * [carded], in home's inset cards (iOS at a71eea391): a section's heading
 * is only the gap between two cards; a computer's heading stands over its
 * cards in line with their avatars, with no rule; a project's row loses the
 * room above it; the card draws the hairlines. [selected]: the row's card
 * ground is the selected one, which a chat's swipe keeps under it.
 */
@Composable
fun ProjectHomeRowContent(row: ProjectHomeRow, callbacks: HomeListCallbacks, carded: Boolean = false, selected: Boolean = false) {
    when (row) {
        is ProjectHomeRow.Section -> if (carded) {
            Spacer(Modifier.fillMaxWidth().height(HomeCardSpec.gap).testTag(ProjectListTags.SECTION))
        } else {
            SectionRow(
                stringResource(
                    when (row.section) {
                        ProjectHomeSection.Bots -> R.string.sidebar_bots
                        ProjectHomeSection.Tasks -> R.string.home_info_tasks
                        ProjectHomeSection.Projects -> R.string.sidebar_projects
                    },
                ),
            )
        }
        is ProjectHomeRow.MachineHeader -> MachineHeaderRow(row.machineId, row.machineName, callbacks, carded)
        is ProjectHomeRow.Bot -> ChatRow(row.session, bot = true, archived = false, callbacks)
        is ProjectHomeRow.Task -> ChatRow(row.session, bot = false, archived = false, callbacks)
        is ProjectHomeRow.ProjectCard -> ProjectCardRow(row.project, row.collapsed, callbacks, carded)
        is ProjectHomeRow.Worktree -> WorktreeRow(row.worktree, row.last, row.collapsed, callbacks)
        is ProjectHomeRow.Chat -> CheckoutChatRow(row, callbacks, carded, selected)
        is ProjectHomeRow.Toggle -> WorktreeToggleRow(row.toggle, callbacks)
        is ProjectHomeRow.ArchiveToggle -> ArchiveToggleRow(row.hidden, banded = false, callbacks)
        is ProjectHomeRow.ArchiveHeader -> SectionRow(dayTitleText(row.title))
        is ProjectHomeRow.Archived -> ChatRow(row.session, bot = false, archived = true, callbacks)
    }
}

@Composable
private fun SectionRow(label: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(ProjectListTags.SECTION)
            .padding(start = ProjectListSpec.rowPaddingX, end = 12.dp, top = 18.dp, bottom = 6.dp),
    ) {
        Text(text = label.uppercase(), style = ProjectListSpec.section, color = HappyTheme.colors.grouped.sectionTitle)
    }
}

/** The computer everything below runs on: desktop glyph (12), its name (11), a line to the edge (none over cards). */
@Composable
private fun MachineHeaderRow(machineId: String?, machineName: String, callbacks: HomeListCallbacks, carded: Boolean) {
    val colors = HappyTheme.colors
    val name = if (machineId == null) "<${stringResource(R.string.status_unknown)}>" else machineName
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(ProjectListTags.MACHINE)
            .then(if (machineId != null) Modifier.clickable(role = Role.Button) { callbacks.onOpenMachine(machineId) } else Modifier)
            .then(
                if (carded) {
                    Modifier
                        .contentMaxWidth(LocalWindowLayout.current)
                        .padding(
                            start = ProjectListSpec.cardMachinePaddingX,
                            end = ProjectListSpec.cardMachinePaddingX,
                            top = ProjectListSpec.cardMachinePaddingTop,
                            bottom = ProjectListSpec.cardMachinePaddingBottom,
                        )
                } else {
                    Modifier.padding(start = ProjectListSpec.rowPaddingX, end = ProjectListSpec.rowPaddingX, top = 14.dp, bottom = 2.dp)
                },
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Ionicon.DesktopOutline, size = 12.dp, color = colors.textSecondary)
        Text(
            text = name,
            style = ProjectListSpec.machine,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = if (carded) Modifier.weight(1f, fill = false) else Modifier.widthIn(max = 220.dp),
        )
        if (!carded) Box(Modifier.weight(1f).height(treeLine()).background(colors.textSecondary))
    }
}

/** The avatar lane every row shares: 28 wide, 12 before the name, full row height. */
@Composable
private fun RowScope.AvatarLane(content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier = Modifier.padding(end = ProjectListSpec.avatarGap).width(ProjectListSpec.avatar).fillMaxHeight(),
        contentAlignment = Alignment.Center,
        content = content,
    )
}

@Composable
private fun RowScope.RowName(text: String, working: Boolean, style: TextStyle) {
    val colors = HappyTheme.colors
    Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
        ShimmerText(
            text = text,
            style = style,
            baseColor = colors.text,
            highlightColor = ShimmerSpec.sheen(colors.text, colors.grouped.background),
            shimmering = working,
        )
    }
}

/** Blocked: a pulsing orange 7 dot; else unread: a blue 7 dot. */
@Composable
private fun AttentionDot(blocked: Boolean, unread: Boolean) {
    when {
        blocked -> StatusDot(color = BlockedDotColor, pulsing = true, size = ProjectListSpec.statusDot)
        unread -> Box(Modifier.size(ProjectListSpec.statusDot).clip(CircleShape).background(UnreadDotColor))
    }
}

@Composable
private fun ProjectGitChanges(session: SessionRowData?) {
    val changes: VisibleGitChanges = session?.let(::projectGitChanges) ?: return
    val colors = HappyTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (changes.approximate) Text("≈", style = ProjectListSpec.gitApproximate, color = colors.textSecondary)
        if (changes.insertions > 0) Text("+${compactCount(changes.insertions)}", style = ProjectListSpec.gitCount, color = gitAddedColor(colors))
        if (changes.deletions > 0) Text("-${compactCount(changes.deletions)}", style = ProjectListSpec.gitCount, color = gitRemovedColor(colors))
    }
}

/**
 * A project's card: it goes by the project's name and heads the project's
 * own checkout, whose chats a tap folds away or lists again (a light tick,
 * then the list changes; a chevron says which). Folded, it speaks for them:
 * the name shimmers while one works, and the dot shows one waiting or
 * unread; open, they speak for themselves. The trailing `+` (and a long
 * press) creates a workspace in it; a stem drops from the avatar to the
 * first row under it.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ProjectCardRow(project: ProjectHomeEntry, collapsed: Boolean, callbacks: HomeListCallbacks, carded: Boolean) {
    LocalHomeRowObserver.current?.let { observe -> SideEffect { observe(project.id) } }
    val colors = HappyTheme.colors
    val checkoutId = project.checkoutId
    val origin: WorkspaceOrigin? = (project.session ?: project.avatarSession)?.let(::workspaceOrigin)
    val stem = treeLine()
    val flip = checkoutFlip(checkoutId, callbacks)
    Row(
        modifier = Modifier
            .padding(top = if (carded) 0.dp else ProjectListSpec.projectRowTop)
            .fillMaxWidth()
            .height(ProjectListSpec.projectRow)
            .testTag(ProjectListTags.PROJECT)
            .combinedClickable(
                enabled = flip != null || origin != null,
                role = Role.Button,
                onClick = { flip?.invoke() },
                onLongClick = origin?.let { { callbacks.onProjectMenu(project.name, it) } },
            )
            .then(if (flip != null) Modifier.foldSemantics(collapsed, flip) else Modifier)
            .padding(horizontal = ProjectListSpec.rowPaddingX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarLane {
            project.avatarSession?.let {
                Avatar(id = it.avatarId, size = ProjectListSpec.avatar, imageUri = it.projectAvatarUri, thumbhash = it.projectAvatarThumbhash)
            }
            if (project.worktreeCount > 0 || (checkoutId != null && !collapsed)) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .testTag(ProjectListTags.TREE_STEM)
                        .width(stem)
                        .height((ProjectListSpec.projectRow - ProjectListSpec.avatar) / 2)
                        .background(colors.textSecondary),
                )
            }
        }
        RowName(project.name, collapsed && project.working, ProjectListSpec.projectName)
        Row(
            modifier = Modifier.padding(start = ProjectListSpec.trailingGap),
            horizontalArrangement = Arrangement.spacedBy(ProjectListSpec.trailingGap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (collapsed) AttentionDot(project.blocked, project.unread)
            ProjectGitChanges(project.session)
            if (origin != null) {
                Box(
                    modifier = Modifier
                        .size(ProjectListSpec.addButtonWidth, ProjectListSpec.addButtonHeight)
                        .testTag(ProjectListTags.PROJECT_ADD)
                        .clickable(role = Role.Button) { callbacks.onCreateWorkspace(origin) },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Ionicon.Add, size = 18.dp, color = colors.textSecondary, contentDescription = stringResource(R.string.home_create_workspace_in, project.name))
                }
            }
            if (checkoutId != null) FoldChevron(collapsed)
        }
    }
}

/** A checkout's fold: a light tick, then its chats go or come back (ProjectHomeList.tsx's toggle). Null without a checkout. */
@Composable
private fun checkoutFlip(checkoutId: String?, callbacks: HomeListCallbacks): (() -> Unit)? {
    val haptics = LocalHapticFeedback.current
    if (checkoutId == null) return null
    return {
        haptics.light()
        callbacks.onToggleCheckout(checkoutId)
    }
}

/** accessibilityState={{ expanded }}: TalkBack's expand or collapse does what a tap does. */
private fun Modifier.foldSemantics(collapsed: Boolean, flip: () -> Unit): Modifier = semantics {
    if (collapsed) expand { flip(); true } else collapse { flip(); true }
}

/** Points down at a checkout's listed chats, or on at folded ones. */
@Composable
private fun FoldChevron(collapsed: Boolean) {
    Icon(
        if (collapsed) Ionicon.ChevronForward else Ionicon.ChevronDown,
        size = ProjectListSpec.chevron,
        color = HappyTheme.colors.textSecondary,
        modifier = Modifier.testTag(ProjectListTags.CHEVRON),
    )
}

/**
 * The tree for a row under a card: the trunk down its lane [center] from
 * the lane's start (stopping at the elbow on the [last]), the elbow from it
 * to the lane's end, 12 before the name.
 */
@Composable
private fun BoxScope.TreeBranch(last: Boolean, center: Dp = ProjectListSpec.avatar / 2) {
    val colors = HappyTheme.colors
    val line = treeLine()
    Box(
        modifier = Modifier
            .align(Alignment.TopStart)
            .offset(x = center - line / 2)
            .testTag(ProjectListTags.TREE_TRUNK)
            .width(line)
            .then(if (last) Modifier.height(ProjectListSpec.worktreeRow / 2) else Modifier.fillMaxHeight())
            .background(colors.textSecondary),
    )
    Box(
        modifier = Modifier
            .align(Alignment.CenterStart)
            .offset(x = center)
            .width(ProjectListSpec.avatar - center)
            .height(line)
            .background(colors.textSecondary),
    )
}

/** A project's line running on through a row that doesn't hang on it, down the middle of the avatar lane. */
@Composable
private fun BoxScope.TreeTrunk() {
    Box(
        modifier = Modifier
            .align(Alignment.TopCenter)
            .testTag(ProjectListTags.TREE_TRUNK)
            .width(treeLine())
            .fillMaxHeight()
            .background(HappyTheme.colors.textSecondary),
    )
}

/**
 * One worktree, hanging off its project's tree line: a branch glyph, then
 * its name. A tap folds its chats away or lists them again, as a project's
 * row does, and folded it speaks for them; open, their line drops from the
 * glyph's middle.
 */
@Composable
private fun WorktreeRow(worktree: ProjectWorktree, last: Boolean, collapsed: Boolean, callbacks: HomeListCallbacks) {
    LocalHomeRowObserver.current?.let { observe -> SideEffect { observe(worktree.id) } }
    val colors = HappyTheme.colors
    val flip = checkoutFlip(worktree.id, callbacks)!!
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(ProjectListSpec.worktreeRow)
            .testTag(ProjectListTags.WORKTREE)
            .clickable(role = Role.Button, onClick = flip)
            .foldSemantics(collapsed, flip)
            .padding(horizontal = ProjectListSpec.rowPaddingX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarLane { TreeBranch(last) }
        Box(
            modifier = Modifier.padding(end = ProjectListSpec.worktreeIconGap).width(ProjectListSpec.worktreeIcon).fillMaxHeight(),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Ionicon.GitBranchOutline, size = ProjectListSpec.worktreeIcon, color = colors.textSecondary, modifier = Modifier.testTag(ProjectListTags.WORKTREE_ICON))
            if (!collapsed) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .testTag(ProjectListTags.TREE_STEM)
                        .width(treeLine())
                        .height((ProjectListSpec.worktreeRow - ProjectListSpec.worktreeIcon) / 2)
                        .background(colors.textSecondary),
                )
            }
        }
        RowName(worktree.workspaceName ?: worktree.projectName, collapsed && worktree.working, ProjectListSpec.worktreeName)
        Row(
            modifier = Modifier.padding(start = ProjectListSpec.trailingGap),
            horizontalArrangement = Arrangement.spacedBy(ProjectListSpec.trailingGap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (collapsed) AttentionDot(worktree.blocked, worktree.unread)
            ProjectGitChanges(worktree.session)
            FoldChevron(collapsed)
        }
    }
}

/**
 * A chat of an open checkout, by its own name ("New chat" without one), on
 * its tree line: under its project at 56, or under its worktree at 96 with
 * the project's line running on beside it. It shimmers while it works and
 * shows the 7 dot while it waits or is unread. A tap opens it, a long press
 * its menu, a swipe archives it, as a flat row's do (the action's glyph
 * without its words, which a 48 row can't hold at large text).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CheckoutChatRow(row: ProjectHomeRow.Chat, callbacks: HomeListCallbacks, carded: Boolean, selected: Boolean) {
    val session = row.session
    LocalHomeRowObserver.current?.let { observe -> SideEffect { observe(session.id) } }
    val colors = HappyTheme.colors
    val now = activity(listOf(session))
    val ground = when {
        selected -> colors.surfaceSelected
        carded -> colors.surfaceHigh
        else -> colors.grouped.background
    }
    // 48 high: the action's glyph alone, so it never cuts its words at large text.
    SwipeToArchive(enabled = true, onArchive = { callbacks.onArchive(session.id) }, labelled = false) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(ProjectListSpec.worktreeRow)
                .testTag(ProjectListTags.CHECKOUT_CHAT)
                .background(ground)
                .sessionPressDown(session.id, callbacks)
                .combinedClickable(
                    role = Role.Button,
                    onClick = { callbacks.onOpen(session.id) },
                    onLongClick = { callbacks.onMenu(session.id) },
                )
                .padding(horizontal = ProjectListSpec.rowPaddingX),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (row.nested) {
                AvatarLane { if (row.throughTrunk) TreeTrunk() }
                AvatarLane { TreeBranch(row.last, center = ProjectListSpec.worktreeIcon / 2) }
            } else {
                AvatarLane { TreeBranch(row.last) }
            }
            RowName(session.name ?: stringResource(R.string.session_new_chat), now.working, ProjectListSpec.worktreeName)
            Box(modifier = Modifier.padding(start = ProjectListSpec.trailingGap)) {
                AttentionDot(now.blocked, now.unread)
            }
        }
    }
}

/** Ends a project's worktrees: "Show all N workspaces" or "Show fewer", speaking for the held-back ones. */
@Composable
private fun WorktreeToggleRow(toggle: WorktreeToggle, callbacks: HomeListCallbacks) {
    val colors = HappyTheme.colors
    val label = if (toggle.expanded) stringResource(R.string.sidebar_show_fewer_workspaces)
    else stringResource(R.string.sidebar_show_all_workspaces, toggle.worktreeCount)
    val haptics = LocalHapticFeedback.current
    // ProjectHomeList.tsx's toggle: a light tick, then the list changes.
    val flip = {
        haptics.light()
        callbacks.onToggleProject(toggle.projectId)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(ProjectListSpec.worktreeRow)
            .testTag(ProjectListTags.TOGGLE)
            .clickable(role = Role.Button, onClick = flip)
            .semantics {
                // accessibilityState={{ expanded }}
                if (toggle.expanded) collapse { flip(); true }
                else expand { flip(); true }
            }
            .padding(horizontal = ProjectListSpec.rowPaddingX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarLane { TreeBranch(last = true) }
        Row(modifier = Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Icon(if (toggle.expanded) Ionicon.ChevronUp else Ionicon.ChevronDown, size = 13.dp, color = colors.textSecondary)
            Text(text = label, style = ProjectListSpec.toggle, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(modifier = Modifier.padding(start = ProjectListSpec.trailingGap)) {
            AttentionDot(toggle.blocked, toggle.unread)
        }
    }
}

/** A bot, or an archived chat: avatar, name, then a 10 dot while it waits or is unread (no time). Archived rows are faded to 0.6. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(session: SessionRowData, bot: Boolean, archived: Boolean, callbacks: HomeListCallbacks) {
    LocalHomeRowObserver.current?.let { observe -> SideEffect { observe(session.id) } }
    val presentation = resolveFlatRowPresentation(session.state, session.hasUnread, archived || session.machineOffline)
    val dot = presentation.topRight as? FlatRowTopRight.Dot
    // A task's swipe leaves it where its machine takes that (happy-ios 36b11c5bf); its long press holds the rest.
    SwipeToArchive(
        enabled = session.task && session.leavesTask,
        onArchive = { callbacks.onArchive(session.id) },
        leave = true,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(ProjectListSpec.botRow)
                .alpha(if (archived) ProjectListSpec.ARCHIVED_ALPHA else 1f)
                .testTag(ProjectListTags.CHAT)
                .sessionPressDown(session.id, callbacks)
                .then(
                    if (session.task) {
                        Modifier.combinedClickable(role = Role.Button, onClick = { callbacks.onOpen(session.id) }, onLongClick = { callbacks.onMenu(session.id) })
                    } else {
                        Modifier.clickable(role = Role.Button) { callbacks.onOpen(session.id) }
                    },
                )
                .padding(horizontal = ProjectListSpec.rowPaddingX),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AvatarLane { Avatar(id = session.avatarId, size = ProjectListSpec.avatar, bot = bot, imageUri = session.avatarUri, thumbhash = session.avatarThumbhash) }
            RowName(session.name ?: stringResource(R.string.session_new_chat), presentation.shimmerTitle, ProjectListSpec.projectName)
            if (dot != null) {
                Box(modifier = Modifier.padding(start = ProjectListSpec.trailingGap)) {
                    StatusDot(color = if (dot.blocked) BlockedDotColor else UnreadDotColor, size = ProjectListSpec.chatDot)
                }
            }
        }
    }
}
