package com.slopus.happy.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.Role
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.model.FlatSessionRowData
import com.slopus.happy.model.ProjectHomeRow
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.SessionState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.AvatarSettings
import com.slopus.happy.ui.components.AvatarTags
import com.slopus.happy.ui.components.LocalAvatarSettings
import com.slopus.happy.ui.connection.AgentHomeCardRow
import com.slopus.happy.ui.connection.AgentHomeItem
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Real session rows: metadata chooses the icon, while layout and actions stay intact. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionHarnessListTest {
    @get:Rule val rule = createComposeRule()

    private val opened = mutableListOf<String>()
    private val callbacks = HomeListCallbacks(
        onOpen = { opened += it }, onMenu = {}, onArchive = {}, onSetArchiveHidden = {},
        onToggleProject = {}, onOpenMachine = {}, onCreateWorkspace = {}, onProjectMenu = { _, _ -> },
    )
    private fun session(id: String, flavor: String?, client: String? = null) =
        SessionRowData(id, name = id, flavor = flavor, clientId = client)

    @Test
    fun flatRowShowsCodexBesideItsTitleWithoutAnAvatarBadge() {
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth().height(81.dp)) {
                FlatSessionRow(FlatSessionRowData(session("Fix login", "codex"), "happy", null), false, false, callbacks, carded = true)
            }
        }
        val icon = rule.onNodeWithContentDescription("Codex", useUnmergedTree = true)
        icon.assertIsDisplayed()
        assertDp("icon width", 16, icon.bounds.right - icon.bounds.left)
        assertDp("icon height", 16, icon.bounds.bottom - icon.bounds.top)
        assertDp("title gap", icon.bounds.right + 6.dp, rule.node(FlatRowTags.TITLE).bounds.left)
        assertDp("stable row height", 81, rule.node(FlatRowTags.ROW).bounds.bottom - rule.node(FlatRowTags.ROW).bounds.top)
        rule.onAllNodesWithTag(AvatarTags.BADGE, useUnmergedTree = true).assertCountEquals(0)
        rule.node(FlatRowTags.ROW).performClick()
        assertEquals(listOf("Fix login"), opened)
    }

    @Test
    fun projectAndWorktreeChatsShowTheirOwnHarnessAndKeepTheirTreeLanes() {
        rule.setHappyContent {
            Column {
                ProjectHomeRowContent(ProjectHomeRow.Chat(session("Root chat", "claude"), false, true), callbacks)
                ProjectHomeRowContent(ProjectHomeRow.Chat(session("Worktree chat", "cursor"), true, true), callbacks)
                ProjectHomeRowContent(ProjectHomeRow.Chat(session("Another worktree chat", "codex"), true, true), callbacks)
            }
        }
        val claude = rule.onNodeWithContentDescription("Claude Code", useUnmergedTree = true)
        val cursor = rule.onNodeWithContentDescription("Cursor", useUnmergedTree = true)
        val codex = rule.onNodeWithContentDescription("Codex", useUnmergedTree = true)
        claude.assertIsDisplayed()
        cursor.assertIsDisplayed()
        codex.assertIsDisplayed()
        assertDp("root tree lane", 56, claude.bounds.left)
        assertDp("worktree tree lane", 96, cursor.bounds.left)
        assertDp("another harness in the same worktree lane", 96, codex.bounds.left)
        assertDp("root title gap", claude.bounds.right + 6.dp, rule.onNodeWithText("Root chat", useUnmergedTree = true).bounds.left)
        assertDp("worktree title gap", cursor.bounds.right + 6.dp, rule.onNodeWithText("Worktree chat", useUnmergedTree = true).bounds.left)
        rule.onAllNodesWithTag(ProjectListTags.CHECKOUT_CHAT, useUnmergedTree = true).assertCountEquals(3)
        rule.onAllNodesWithTag(ProjectListTags.CHECKOUT_CHAT, useUnmergedTree = true)[1].performClick()
        assertEquals(listOf("Worktree chat"), opened)
    }

    @Test
    fun archivedBotAndTaskRowsAlsoIdentifyTheirHarness() {
        rule.setHappyContent {
            Column {
                ProjectHomeRowContent(ProjectHomeRow.Archived(session("Archived", "agy")), callbacks)
                ProjectHomeRowContent(ProjectHomeRow.Bot(session("Bot", "gemini")), callbacks)
                ProjectHomeRowContent(ProjectHomeRow.Task(session("Task", "codex", "rig").copy(task = true)), callbacks)
            }
        }
        for (description in listOf("Antigravity", "Gemini", "Happy")) {
            rule.onNodeWithContentDescription(description, useUnmergedTree = true).assertIsDisplayed()
        }
        rule.onAllNodesWithTag(AvatarTags.BADGE, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun missingMetadataShowsUnknownRatherThanAClaudeIcon() {
        rule.setHappyContent { ProjectHomeRowContent(ProjectHomeRow.Chat(session("Old chat", null), false, true), callbacks) }
        rule.onNodeWithContentDescription("unknown", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun explicitUnknownHarnessKeepsItsNameForAccessibility() {
        rule.setHappyContent { ProjectHomeRowContent(ProjectHomeRow.Chat(session("Future chat", "future-harness"), false, true), callbacks) }
        rule.onNodeWithContentDescription("future-harness", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun changingTheListSettingHidesIconsOnBothAccountTypes() {
        val enabled = mutableStateOf(true)
        val conversation = AgentFeedRow.Conversation("agent", "Happy chat", ConversationKind.Project, 0)
        rule.setHappyContent {
            CompositionLocalProvider(LocalAvatarSettings provides AvatarSettings(showFlavorIcons = enabled.value)) {
                Column {
                    ProjectHomeRowContent(ProjectHomeRow.Chat(session("CLI chat", "cursor"), false, true), callbacks)
                    AgentHomeCardRow(
                        AgentHomeItem.Row(conversation, true, true), Modifier.fillMaxWidth(), false, "agent-row",
                        { opened += it }, {}, {},
                    )
                }
            }
        }
        rule.onNodeWithContentDescription("Cursor", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithContentDescription("Happy", useUnmergedTree = true).assertIsDisplayed()
        rule.node("agent-row").performClick()
        assertEquals(listOf("agent"), opened)
        rule.runOnIdle { enabled.value = false }
        rule.onAllNodesWithTag("session.harnessIcon", useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithText("CLI chat", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Happy chat", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun longTitlesLeaveRoomForHarnessAndUnreadIndicators() {
        rule.setHappyContent {
            ProjectHomeRowContent(
                ProjectHomeRow.Chat(session("Long title ".repeat(30), "cursor").copy(hasUnread = true, state = SessionState.Thinking), false, true),
                callbacks,
            )
        }
        val row = rule.node(ProjectListTags.CHECKOUT_CHAT).bounds
        val icon = rule.onNodeWithContentDescription("Cursor", useUnmergedTree = true).bounds
        val title = rule.onNodeWithText("Long title ".repeat(30), useUnmergedTree = true).bounds
        assertDp("row stays 48 high", 48, row.bottom - row.top)
        assertTrue(icon.right < title.left)
        assertTrue("title leaves room at the row's end", title.right < row.right - 16.dp)
    }

    @Test
    fun flatSessionDescriptionKeepsItsTitleAndProjectAlongsideTheHarness() {
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth().height(81.dp)) {
                FlatSessionRow(FlatSessionRowData(session("Fix login", "codex"), "happy", "feature"), false, false, callbacks, carded = true)
            }
        }
        val node = rule.onNodeWithTag(FlatRowTags.ROW, useUnmergedTree = false).fetchSemanticsNode()
        val description = node.config[SemanticsProperties.ContentDescription].joinToString(", ")
        assertTrue("session title missing from spoken description: $description", description.contains("Fix login"))
        assertTrue(description.contains("happy"))
        assertTrue(description.contains("feature"))
        assertTrue(description.contains("Codex"))
        assertEquals(Role.Button, node.config[SemanticsProperties.Role])
    }

    @Test
    fun projectSessionDescriptionKeepsItsTitleAlongsideTheHarness() {
        rule.setHappyContent {
            ProjectHomeRowContent(ProjectHomeRow.Chat(session("Worktree chat", "cursor"), true, true), callbacks)
        }
        val node = rule.onNodeWithTag(ProjectListTags.CHECKOUT_CHAT, useUnmergedTree = false).fetchSemanticsNode()
        val description = node.config[SemanticsProperties.ContentDescription].joinToString(", ")
        assertTrue("session title missing from spoken description: $description", description.contains("Worktree chat"))
        assertTrue(description.contains("Cursor"))
    }

    @Test
    fun agentSessionDescriptionKeepsItsTitleAlongsideTheHarness() {
        val conversation = AgentFeedRow.Conversation("agent", "Review the PR", ConversationKind.Task, 0)
        rule.setHappyContent {
            AgentHomeCardRow(AgentHomeItem.Row(conversation, true, true), Modifier.fillMaxWidth(), false, "agent-row", {}, {}, {})
        }
        val node = rule.onNode(hasClickAction() and hasAnyAncestor(hasTestTag("agent-row")), useUnmergedTree = false).fetchSemanticsNode()
        val description = node.config[SemanticsProperties.ContentDescription].joinToString(", ")
        assertTrue("session title missing from spoken description: $description", description.contains("Review the PR"))
        assertTrue(description.contains("Happy"))
    }

    @Test
    fun archivedSessionDescriptionKeepsItsNameAlongsideTheHarness() {
        rule.setHappyContent { ProjectHomeRowContent(ProjectHomeRow.Archived(session("Release notes", "agy")), callbacks) }
        val node = rule.onNodeWithTag(ProjectListTags.CHAT, useUnmergedTree = false).fetchSemanticsNode()
        val description = node.config[SemanticsProperties.ContentDescription].joinToString(", ")
        assertTrue("session title missing from spoken description: $description", description.contains("Release notes"))
        assertTrue(description.contains("Antigravity"))
    }

    @Test
    fun openClawHasItsOwnRedArtworkInsteadOfTheGenericChip() {
        rule.setHappyContent { ProjectHomeRowContent(ProjectHomeRow.Chat(session("Old chat", "openclaw"), false, true), callbacks) }
        val icon = rule.onNodeWithContentDescription("OpenClaw", useUnmergedTree = true)
        icon.assertIsDisplayed()
        val pixels = icon.captureToImage().toPixelMap()
        assertTrue("OpenClaw's red artwork is missing", (0 until pixels.width).any { x ->
            (0 until pixels.height).any { y -> pixels[x, y].let { it.red > 0.7f && it.green < 0.6f && it.blue < 0.6f } }
        })
    }
}
