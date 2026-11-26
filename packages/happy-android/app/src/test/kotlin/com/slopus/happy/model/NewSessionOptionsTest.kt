package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.settings.AgentDefaultOverrides
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * HomeDock.tsx's option derivation and homeDockInteraction.ts: computers
 * online first, a persisted machine kept through an empty catalog, places
 * named relative to home, a catalog-only project offered only where Happy
 * Agent runs, the worktree choices for git and for Happy Agent
 * workspaces, the CLI's permission modes filtered by its version, Happy
 * Agent's own catalog grouped by provider, and the draft reconciled with
 * the computer.
 */
class NewSessionOptionsTest {
    private val studio = machine(
        "m1",
        machineMetadata { put("displayName", "Studio"); cliAvailability(claude = true, codex = true) },
        activeAt = 5,
    )
    private val laptop = machine(
        "m2",
        machineMetadata(host = "air.local") { put("displayName", "Air"); cliAvailability(claude = true) },
        active = false,
        activeAt = 3,
    )
    private val rig = rigMachine(worktrees = true)
    private fun rigMachine(worktrees: Boolean) = machine(
        "r1",
        machineMetadata {
            put("machineKind", "rig")
            put("siblingMachineId", "m1")
            putJsonObject("capabilities") { put("newSession", true); put("worktrees", worktrees) }
            putJsonObject("defaults") { put("providerId", "openai"); put("modelId", "gpt"); put("permissionMode", "auto") }
            putJsonArray("models") {
                addJsonObject {
                    put("code", "gpt"); put("id", "gpt"); put("value", "GPT"); put("providerId", "openai"); put("providerName", "OpenAI")
                    putJsonArray("thinkingLevels") { add("low"); add("high") }
                }
                addJsonObject { put("code", "opus"); put("id", "opus"); put("value", "Opus"); put("providerId", "anthropic"); put("providerName", "Anthropic") }
            }
            putJsonArray("operatingModes") {
                addJsonObject { put("code", "auto"); put("value", "Auto") }
                addJsonObject { put("code", "read_only"); put("value", "Read only") }
            }
        },
    )
    private val overrides = AgentDefaultOverrides()

    private fun resolve(draft: NewSessionDraft, machines: List<Machine> = listOf(laptop, studio), sessions: List<Session> = emptyList(), worktrees: WorktreeListing? = null) =
        resolveNewSessionOptions(draft, machines, sessions, overrides, worktrees, NewSessionLabels(lastSeen = { "seen $it" }))

    @Test fun cursorIsSelectableAndNewChatsReuseOnlyTheirComputersLatestCliCatalog() {
        val cursorMachine = machine("cursor-machine", machineMetadata {
            put("cliAvailability", kotlinx.serialization.json.Json.parseToJsonElement("""{"claude":true,"codex":true,"gemini":false,"openclaw":false,"cursor":true,"detectedAt":1}"""))
        })
        fun catalog(id: String, computer: String, model: String, updated: Long, flavor: String = "cursor") = session(id, metadata {
            put("machineId", computer); put("flavor", flavor)
            put("models", kotlinx.serialization.json.Json.parseToJsonElement("""[{"code":"$model","value":"$model","thinkingLevels":["high","ultra"],"defaultThinkingLevel":"ultra"}]"""))
        }).copy(updatedAt = updated)
        val sessions = listOf(
            catalog("old", "cursor-machine", "old-model", 1),
            catalog("current", "cursor-machine", "cursor-model[effort=high]", 2),
            catalog("other", "other-machine", "other-model", 100),
            catalog("codex", "cursor-machine", "codex-model", 200, "codex"),
        )
        val draft = NewSessionDraft(selectedMachineId = cursorMachine.id, agentType = AgentType.Cursor, pickedAgentType = AgentType.Cursor)
        val options = resolve(draft, listOf(cursorMachine), sessions)
        assertTrue(options.agents.any { it.key == "cursor" })
        assertEquals(AgentType.Cursor, options.resolvedAgent)
        // Cursor keeps its leading default row; only this computer's newest catalog follows it.
        assertEquals(listOf("default", "cursor-model[effort=high]"), options.models.flatMap { it.options }.map { it.key })
        assertEquals("default", options.model?.key)
        // A picked catalog model offers its CLI's effort scale and default.
        val picked = resolve(draft.copy(modelMode = "cursor-model[effort=high]"), listOf(cursorMachine), sessions)
        assertEquals("cursor-model[effort=high]", picked.model?.key)
        assertEquals(listOf("high", "ultra"), picked.efforts.map { it.key })
        assertEquals("ultra", picked.effort?.key)
        // Before any Cursor catalog arrives, a saved CLI model still survives.
        assertEquals("saved-cursor-model", resolve(draft.copy(modelMode = "saved-cursor-model"), listOf(cursorMachine)).model?.key)
    }

    @Test fun codexConfigLeavesEffortToTheCliUnlessPicked() {
        val draft = NewSessionDraft(selectedMachineId = studio.id, agentType = AgentType.Codex, pickedAgentType = AgentType.Codex, modelMode = "default")
        assertEquals("default", resolve(draft).model?.key)
        assertNull(resolve(draft).effort)
        assertEquals("high", resolve(draft.copy(effortLevel = "high")).effort?.key)
    }

    @Test fun computersOnlineFirstAndAStaleMachineBecomesTheFirst() {
        val options = resolve(NewSessionDraft(selectedMachineId = "gone"))
        assertEquals(listOf("m1", "m2"), options.machines.map { it.key })
        assertEquals(listOf("online", "seen 3"), options.machines.map { it.description })
        assertEquals("m1", options.resolvedMachineId)
        // An empty catalog (still syncing) keeps the persisted pick.
        assertEquals("gone", resolve(NewSessionDraft(selectedMachineId = "gone"), machines = emptyList()).resolvedMachineId)
    }

    @Test fun placesAreNamedRelativeToHomeAndProjectsByName() {
        val sessions = listOf(
            session("a", metadata(path = "/Users/dev/code") { put("machineId", "m1") }),
            session("b", rigMetadata(path = "/Users/dev/app", machineId = "r1", projectId = "p1", projectName = "App")),
        )
        val options = resolve(NewSessionDraft(selectedMachineId = "m1"), listOf(studio, rig), sessions)
        val byKey = options.projects.associateBy { it.key }
        assertEquals("~", byKey.getValue("~").name)
        assertEquals("code" to "~/code", byKey.getValue("/Users/dev/code").let { it.name to it.description })
        assertEquals("App", byKey.getValue("/Users/dev/app").name)
        assertEquals("~/app", byKey.getValue("/Users/dev/app").description)
        assertEquals("~", options.project?.key)
    }

    private fun cli(id: String, path: String) = session(id, metadata(path = path) { put("machineId", "m1") })

    @Test fun worktreesHangUnderTheirRepo() {
        val sessions = listOf(
            cli("a", "/Users/dev/code/happy/.dev/worktree/calm"),
            cli("b", "/Users/dev/other"),
            cli("c", "/Users/dev/code/happy"),
            cli("d", "/Users/dev/code/happy/.dev/worktree/bold"),
        )
        val options = resolve(NewSessionDraft(selectedMachineId = "m1"), listOf(studio), sessions)
        // Groups keep the order of their first appearance; the repo leads its worktrees.
        assertEquals(
            listOf("~", "/Users/dev/code/happy", "/Users/dev/code/happy/.dev/worktree/calm", "/Users/dev/code/happy/.dev/worktree/bold", "/Users/dev/other"),
            options.projects.map { it.key },
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
        assertEquals("web" to 0, options.projects.first { it.key == "/Users/dev/web" }.let { it.name to it.depth })
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
        assertEquals("~/code/happy", options.projectTitle)
        // The repo row is ticked, and titled, by its path.
        val onRepo = resolve(draft.selectingProject("/Users/dev/code/happy", listOf(studio), overrides), listOf(studio), sessions)
        assertEquals("/Users/dev/code/happy" to "~/code/happy", onRepo.placeKey to onRepo.placeTitle)
    }

    @Test fun aCheckoutPreparedFromHomeTicksItsWorktreeRow() {
        // prepareCheckout writes the repo relative to home and the worktree in full: still one group.
        val sessions = listOf(cli("c", "/Users/dev/code/happy"), cli("a", "/Users/dev/code/happy/.dev/worktree/calm"))
        val draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "~/code/happy", sessionType = SessionType.Worktree, worktreeKey = "/Users/dev/code/happy/.dev/worktree/calm")
        val options = resolve(draft, listOf(studio), sessions)
        assertEquals(listOf("~/code/happy", "/Users/dev/code/happy/.dev/worktree/calm"), options.projects.map { it.key })
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
        val draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "~/code/happy/.dev/worktree/calm")
        val next = resolve(draft, listOf(studio)).reconcile(draft, listOf(studio), overrides)
        assertEquals(Triple("~/code/happy", SessionType.Worktree, "/Users/dev/code/happy/.dev/worktree/calm"), Triple(next.selectedPath, next.sessionType, next.worktreeKey))
        assertEquals(next, resolve(next, listOf(studio)).reconcile(next, listOf(studio), overrides))
    }

    @Test fun aWorktreeStaysTheFolderWhereNoWorktreeCanBeMade() {
        // This Happy Agent makes no worktrees: a picked checkout starts as a plain folder, not dropped for its repo.
        val machines = listOf(studio, rigMachine(worktrees = false))
        val draft = NewSessionDraft(selectedMachineId = "m1")
            .selectingAgent(AgentType.Rig, picked = true, machines, overrides)
            .selectingProject("/Users/dev/code/happy/.dev/worktree/calm", machines, overrides)
        val next = resolve(draft, machines).reconcile(draft, machines, overrides)
        assertEquals(AgentType.Rig, next.agentType)
        assertEquals(Triple("/Users/dev/code/happy/.dev/worktree/calm", SessionType.Simple, null), Triple(next.selectedPath, next.sessionType, next.worktreeKey))
        assertEquals(next, resolve(next, machines).reconcile(next, machines, overrides))
    }

    @Test fun aTypedWorktreePathIsAWorktreePick() {
        val typed = NewSessionDraft(selectedMachineId = "m1").selectingPath("/Users/dev/code/happy/.dev/worktree/calm")
        assertEquals(Triple("/Users/dev/code/happy", SessionType.Worktree, "/Users/dev/code/happy/.dev/worktree/calm"), Triple(typed.selectedPath, typed.sessionType, typed.worktreeKey))
        assertEquals("cursor-x › packages/cli", WorktreePaths.label("/r/.dev/worktree/cursor-x/packages/cli"))
        assertNull(WorktreePaths.label("/r"))
    }

    @Test fun aCatalogOnlyProjectNeedsHappyAgent() {
        val inWorkspace = listOf(
            session("w", rigMetadata(path = "/Users/dev/app/.dev/worktree/x", machineId = "r1", projectId = "p1", projectName = "App", workspaceId = "ws1", workspaceName = "x")),
        )
        assertTrue(resolve(NewSessionDraft(selectedMachineId = "m1"), listOf(studio, rig), inWorkspace).projects.any { it.key == projectPlaceKey("p1") })
        val cliOnly = listOf(inWorkspace.single().let { it.copy(metadata = it.metadata!!.copy(machineId = "m1")) })
        assertTrue(resolve(NewSessionDraft(selectedMachineId = "m1"), listOf(studio), cliOnly).projects.none { it.key == projectPlaceKey("p1") })
    }

    @Test fun gitWorktreesCountOnlyForTheirTarget() {
        val draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "~/code", sessionType = SessionType.Worktree, worktreeKey = "/Users/dev/code/.dev/worktree/calm")
        val target = WorktreeTarget("m1", "/Users/dev/code")
        val listed = resolve(draft, worktrees = WorktreeListing(target, listOf(GitWorktree("/Users/dev/code/.dev/worktree/calm", "calm"))))
        assertEquals(target, listed.worktreeTarget)
        assertEquals(listOf(WorktreeSelection.NEW, WorktreeSelection.NONE, "/Users/dev/code/.dev/worktree/calm"), listed.worktrees.map { it.key })
        assertEquals(listOf("Create New Worktree", "No worktree", "calm"), listed.worktrees.map { it.name })
        assertEquals("calm", listed.worktree?.name)
        // Another directory's listing is not this one's: the pick keeps a row of its own.
        val stale = resolve(draft, worktrees = WorktreeListing(WorktreeTarget("m1", "/elsewhere"), listOf(GitWorktree("/x", "x"))))
        assertEquals(listOf(WorktreeSelection.NEW, WorktreeSelection.NONE, "/Users/dev/code/.dev/worktree/calm"), stale.worktrees.map { it.key })
        assertEquals("/Users/dev/code/.dev/worktree/calm", stale.worktree?.name)
    }

    @Test fun aHappyAgentProjectPicksWorkspaces() {
        val sessions = listOf(
            session("b", rigMetadata(path = "/Users/dev/app", machineId = "r1", projectId = "p1", projectName = "App")),
            session("w", rigMetadata(path = "/Users/dev/app/.dev/worktree/x", machineId = "r1", projectId = "p1", projectName = "App", workspaceId = "ws1", workspaceName = "feature")),
        )
        val options = resolve(NewSessionDraft(selectedMachineId = "m1", selectedProjectId = "p1", agentType = AgentType.Rig), listOf(studio, rig), sessions)
        assertTrue(options.picksWorkspaces)
        assertNull("no git listing for a workspace project", options.worktreeTarget)
        assertEquals(listOf("Create New Workspace", "Main", "feature"), options.worktrees.map { it.name })
        assertEquals("Main", options.worktree?.name)
    }

    @Test fun theCliParsesOnlyTheModesItKnows() {
        // happyCliVersion 1.0.0 predates `auto`.
        val options = resolve(NewSessionDraft(selectedMachineId = "m1", agentType = AgentType.Claude, permissionMode = "auto"))
        assertTrue(options.permissions.none { it.key == "auto" })
        assertEquals("the code default, not the first row", "default", options.permission?.key)
        assertEquals(listOf("claude", "codex"), options.agents.map { it.key })
        assertEquals("Claude Code", options.agent.name)
    }

    @Test fun happyAgentOffersItsOwnCatalog() {
        val options = resolve(NewSessionDraft(selectedMachineId = "m1", agentType = AgentType.Rig), listOf(studio, rig))
        assertEquals(listOf("OpenAI", "Anthropic"), options.models.map { it.title })
        assertEquals("GPT", options.model?.name)
        assertEquals("Auto", options.permissionLabel)
        assertEquals(listOf("low", "high"), options.efforts.map { it.key })
        assertEquals("low", options.effort?.key)
        assertEquals(listOf("Read"), listOf(permissionModeShortLabel("Read only")))
    }

    @Test fun theDraftFollowsTheComputer() {
        val machines = listOf(laptop, studio)
        // A machine that left, a harness the computer doesn't run, and a worktree where none can be made.
        val draft = NewSessionDraft(selectedMachineId = "gone", agentType = AgentType.OpenClaw, sessionType = SessionType.Worktree)
        fun step(from: NewSessionDraft) = resolve(from, machines).reconcile(from, machines, overrides)
        val first = step(draft)
        assertEquals("m1", first.selectedMachineId)
        assertEquals("no worktree for OpenClaw", SessionType.Simple, first.sessionType)
        // Each pass reads the computer the last one settled on.
        val settled = step(first)
        assertEquals(AgentType.Claude, settled.agentType)
        assertNull("following the computer is not a pick", settled.pickedAgentType)
        assertEquals(settled, step(settled))
    }

    @Test fun picksChangeTheDraft() {
        val machines = listOf(studio, rig)
        val draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "~/code", worktreeKey = "x")
        val project = draft.selectingProject(projectPlaceKey("p1"), machines, overrides)
        assertEquals("p1", project.selectedProjectId)
        assertNull(project.selectedPath)
        assertEquals(AgentType.Rig, project.pickedAgentType)
        assertEquals("Happy Agent's defaults", "auto", project.permissionMode)
        assertEquals("/srv", draft.selectingProject("/srv", machines, overrides).selectedPath)
        assertEquals(SessionType.Worktree to null, draft.selectingWorktree(WorktreeSelection.NEW).let { it.sessionType to it.worktreeKey })
        assertEquals(SessionType.Simple to null, draft.selectingWorktree(WorktreeSelection.NONE).let { it.sessionType to it.worktreeKey })
        assertEquals(SessionType.Worktree to "/wt", draft.selectingWorktree("/wt").let { it.sessionType to it.worktreeKey })
    }

    @Test fun modesTaggedWithACliVersion() {
        val auto = com.slopus.happy.model.settings.ModeOption("auto", "Auto", sinceCliVersion = "1.2.1-beta.2")
        assertTrue(modeSupportedByCli(auto, null))
        assertTrue(modeSupportedByCli(auto, "1.2.1"))
        assertEquals(false, modeSupportedByCli(auto, "1.0.0"))
        assertEquals(false, modeSupportedByCli(auto, "garbage"))
    }

    @Test fun cursorNewSessionOffersRecentSessionModelsAndConfiguredDefault() {
        val cursorMachine = machine(
            "m-cur",
            machineMetadata { put("displayName", "Studio"); cliAvailability(claude = true, cursor = true) },
            activeAt = 5,
        )
        val cursorSession = session(
            "s-cur",
            metadata {
                put("machineId", "m-cur")
                put("flavor", "cursor")
                putJsonArray("models") {
                    addJsonObject { put("code", "composer-2.5"); put("value", "Composer 2.5") }
                    addJsonObject { put("code", "gpt-5.6-sol-high"); put("value", "GPT-5.6 Sol High") }
                }
            },
        ).copy(updatedAt = 10)
        val customOverrides = AgentDefaultOverrides(
            mapOf(com.slopus.happy.model.settings.AgentKey.Cursor to com.slopus.happy.model.settings.AgentDefaultOverride(modelMode = "claude-opus-5-5[context=300k,effort=medium,fast=false]")),
        )
        val withSessions = resolveNewSessionOptions(
            NewSessionDraft(selectedMachineId = "m-cur", agentType = AgentType.Cursor),
            listOf(cursorMachine),
            listOf(cursorSession),
            customOverrides,
        )
        assertEquals(
            listOf("default", "composer-2.5", "gpt-5.6-sol-high", "claude-opus-5-5[context=300k,effort=medium,fast=false]"),
            withSessions.models.single().options.map { it.key },
        )
        assertEquals("claude-opus-5-5[context=300k,effort=medium,fast=false]", withSessions.model?.key)

        val pickedKnown = resolveNewSessionOptions(
            NewSessionDraft(selectedMachineId = "m-cur", agentType = AgentType.Cursor),
            listOf(cursorMachine),
            listOf(cursorSession),
            AgentDefaultOverrides(mapOf(com.slopus.happy.model.settings.AgentKey.Cursor to com.slopus.happy.model.settings.AgentDefaultOverride(modelMode = "composer-2.5"))),
        )
        assertEquals("Composer 2.5", pickedKnown.model?.name)
        assertEquals("Composer 2.5", pickedKnown.modelChip)
    }
}
