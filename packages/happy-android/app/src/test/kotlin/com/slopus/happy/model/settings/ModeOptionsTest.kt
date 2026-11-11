package com.slopus.happy.model.settings

import com.slopus.happy.R
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * happy-app components/modelModeOptions.ts: the hardcoded catalogs, in
 * order, with Happy's one-word mode names and agentInput.* descriptions;
 * includeConfiguredModel appending a saved model the list lacks; per-model
 * effort levels.
 */
class ModeOptionsTest {
    private val translate: (Int) -> String = { id -> "string:$id" }

    @Test
    fun permissionModesPerHarness() {
        val claude = ModeOptions.permissionModes("claude", translate)
        assertEquals(listOf("auto", "acceptEdits", "plan", "bypassPermissions", "default"), claude.map { it.key })
        assertEquals(listOf("Auto", "Edits", "Plan", "Yolo", "Default"), claude.map { it.name })
        assertEquals("string:${R.string.agent_input_permission_mode_plan}", claude[2].description)
        assertEquals(AgentDefaults.CLI_VERSION_WITH_AUTO, claude[0].sinceCliVersion)
        assertNull(claude[1].sinceCliVersion)

        val codex = ModeOptions.permissionModes("codex", translate)
        assertEquals(listOf("auto", "safe-yolo", "read-only", "yolo", "default"), codex.map { it.key })
        assertEquals(listOf("Auto", "Workspace", "Read", "Yolo", "Default"), codex.map { it.name })
        assertEquals("string:${R.string.agent_input_codex_permission_mode_safe_yolo_description}", codex[1].description)

        assertEquals(listOf("yolo", "default"), ModeOptions.permissionModes("gemini", translate).map { it.key })
        assertEquals(listOf("bypassPermissions", "default"), ModeOptions.permissionModes("openclaw", translate).map { it.key })
        // agy's sandboxed default leads.
        val agy = ModeOptions.permissionModes("agy", translate)
        assertEquals(listOf("default", "bypassPermissions"), agy.map { it.key })
        assertEquals("string:${R.string.agent_input_permission_mode_agy_default}", agy[0].description)
        val cursor = ModeOptions.permissionModes("cursor", translate)
        assertEquals(listOf("agent", "plan", "ask", "yolo"), cursor.map { it.key })
        assertEquals(listOf("Agent", "Plan", "Ask", "Agent (auto-approve)"), cursor.map { it.name })
        // An unknown flavor gets Claude's.
        assertEquals(claude, ModeOptions.permissionModes(null, translate))
    }

    @Test
    fun modelModesPerHarness() {
        assertEquals(
            listOf("claude-fable-5-2", "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5"),
            ModeOptions.modelModes("claude").map { it.key },
        )
        assertEquals("1M context", ModeOptions.modelModes("claude")[0].description)
        assertEquals(
            listOf("default", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"),
            ModeOptions.modelModes("codex").map { it.key },
        )
        // `default` sends no model, so Codex runs the one in its own config.toml.
        assertEquals(ModeOption("default", "Codex config", "model and effort from ~/.codex/config.toml"), ModeOptions.modelModes("codex")[0])
        assertEquals("most capable", ModeOptions.modelModes("codex")[1].description)
        assertEquals(6, ModeOptions.modelModes("gemini").size)
        assertEquals(listOf("default"), ModeOptions.modelModes("openclaw").map { it.key })
        assertEquals(listOf("default"), ModeOptions.modelModes("cursor").map { it.key })
        assertEquals("Gemini 3.8 Flash", ModeOptions.modelModes("agy")[0].name)
    }

    @Test
    fun includeConfiguredModelAppendsSavedModels() {
        val codex = ModeOptions.modelModes("codex")
        assertEquals(ModeOption("my-model", "my-model", "custom model"), ModeOptions.includeConfiguredModel("codex", codex, "my-model").last())
        assertEquals(codex, ModeOptions.includeConfiguredModel("codex", codex, "gpt-6-sol"))
        assertEquals(codex, ModeOptions.includeConfiguredModel("codex", codex, "default"))
        assertEquals(codex, ModeOptions.includeConfiguredModel("codex", codex, null))

        val claude = ModeOptions.modelModes("claude")
        assertEquals(ModeOption("claude-sonnet-5", "Sonnet 5", "saved model"), ModeOptions.includeConfiguredModel("claude", claude, "claude-sonnet-5").last())
        // A saved [1m] key is its 1M-native row.
        assertEquals(claude, ModeOptions.includeConfiguredModel("claude", claude, "claude-opus-5-5[1m]"))

        val agy = ModeOptions.modelModes("agy")
        assertEquals(ModeOption("Other", "Other", "saved model"), ModeOptions.includeConfiguredModel("agy", agy, "Other").last())

        val gemini = ModeOptions.modelModes("gemini")
        assertEquals(gemini, ModeOptions.includeConfiguredModel("gemini", gemini, "gemini-1"))

        val cursor = ModeOptions.modelModes("cursor")
        assertEquals(
            listOf("default", "composer-2.5"),
            ModeOptions.includeConfiguredModel("cursor", cursor, "composer-2.5").map { it.key },
        )
        assertEquals(
            ModeOption("claude-opus-5-5[context=300k,effort=medium,fast=false]", "claude-opus-5-5[context=300k,effort=medium,fast=false]", "custom model"),
            ModeOptions.includeConfiguredModel("cursor", cursor, "claude-opus-5-5[context=300k,effort=medium,fast=false]").last(),
        )
        assertEquals(cursor, ModeOptions.includeConfiguredModel("cursor", cursor, "default"))
    }

    @Test
    fun cursorCatalogModelsCollectRecentCursorSessionsInOrder() {
        val older = session(
            "s-old",
            metadata {
                put("flavor", "cursor")
                putJsonArray("models") {
                    addJsonObject { put("code", "composer-2.5"); put("value", "Composer 2.5 Old") }
                    addJsonObject { put("code", "gpt-5.6-sol-high"); put("value", "GPT-5.6 Sol High") }
                }
            },
            activeAt = 10,
        ).copy(updatedAt = 10)
        val newer = session(
            "s-new",
            metadata {
                put("flavor", "cursor")
                putJsonArray("models") {
                    addJsonObject { put("code", "auto"); put("value", "Auto") }
                    addJsonObject { put("code", "composer-2.5"); put("value", "Composer 2.5"); put("description", "Fast") }
                }
            },
            activeAt = 20,
        ).copy(updatedAt = 20)
        val otherFlavor = session(
            "s-opencode",
            metadata {
                put("flavor", "opencode")
                putJsonArray("models") {
                    addJsonObject { put("code", "ignored"); put("value", "Ignored") }
                }
            },
            activeAt = 30,
        ).copy(updatedAt = 30)
        val catalog = ModeOptions.cursorCatalogModels(listOf(older, newer, otherFlavor))
        assertEquals(
            listOf(
                ModeOption("default", "Default model"),
                ModeOption("auto", "Auto"),
                ModeOption("composer-2.5", "Composer 2.5", "Fast"),
                ModeOption("gpt-5.6-sol-high", "GPT-5.6 Sol High"),
            ),
            catalog,
        )
        assertEquals(listOf(ModeOption("default", "Default model")), ModeOptions.cursorCatalogModels(emptyList()))
    }

    @Test
    fun effortLevelsPerModel() {
        assertEquals("xHigh", ModeOptions.effortDisplayName("xhigh"))
        assertEquals("Ultra", ModeOptions.effortDisplayName("ultra"))

        assertEquals(listOf("Low", "Medium", "High", "xHigh", "Max"), ModeOptions.effortLevelsForModel("claude", "claude-haiku-5-5").map { it.name })
        assertEquals(listOf("low", "medium", "high", "xhigh", "max", "ultra"), ModeOptions.effortLevelsForModel("codex", "gpt-6.1-sol").map { it.key })
        assertEquals(listOf("low", "medium", "high", "xhigh", "max", "ultra"), ModeOptions.effortLevelsForModel("codex", "gpt-6.1-terra").map { it.key })
        assertEquals(listOf("low", "medium", "high", "xhigh", "max"), ModeOptions.effortLevelsForModel("codex", "gpt-6-luna").map { it.key })
        assertEquals(listOf("low", "medium", "high", "xhigh"), ModeOptions.effortLevelsForModel("codex", "my-model").map { it.key })
        assertEquals(listOf("low", "medium", "high"), ModeOptions.effortLevelsForModel("agy", "Gemini 3.8 Flash").map { it.key })
        assertEquals(emptyList<ModeOption>(), ModeOptions.effortLevelsForModel("agy", "GPT-OSS 120B (Medium)"))
        assertEquals(emptyList<ModeOption>(), ModeOptions.effortLevelsForModel("gemini", "gemini-2.5-pro"))
        assertEquals(emptyList<ModeOption>(), ModeOptions.effortLevelsForModel("cursor", "default"))
    }
}
