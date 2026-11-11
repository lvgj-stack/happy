package com.slopus.happy.model

import com.slopus.happy.net.HappyJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionHarnessTest {
    @Test
    fun eachSessionUsesItsReportedHarnessIncludingCodexAliases() {
        val cases = listOf(
            "claude" to AgentType.Claude,
            "codex" to AgentType.Codex,
            "openai" to AgentType.Codex,
            "gpt" to AgentType.Codex,
            "cursor" to AgentType.Cursor,
            "agy" to AgentType.Agy,
            "gemini" to AgentType.Gemini,
            "openclaw" to AgentType.OpenClaw,
            "rig" to AgentType.Rig,
        )
        for ((flavor, expected) in cases) assertEquals(flavor, expected, resolveSessionHarness(flavor, null))
    }

    @Test
    fun happyClientTakesPrecedenceOverItsModelProvider() {
        assertEquals(AgentType.Rig, resolveSessionHarness("codex", "rig"))
        assertEquals(AgentType.Rig, resolveSessionHarness(null, "rig"))
        assertEquals(AgentType.Cursor, resolveSessionHarness("cursor", "happy-cli"))
    }

    @Test
    fun missingOrUnknownHarnessIsNotGuessedToBeClaude() {
        for (flavor in listOf(null, "", "   ", "future-harness")) assertNull(resolveSessionHarness(flavor, null))
    }

    @Test
    fun listIconsAreEnabledForNewSettingsAndMissingStoredFields() {
        assertTrue(Settings.Defaults.showFlavorIcons)
        assertTrue(Settings.parse(HappyJson.parseToJsonElement("{}")).showFlavorIcons)
    }

    @Test
    fun anExplicitlyDisabledListSettingSurvivesParsingAndSaving() {
        val settings = Settings.parse(HappyJson.parseToJsonElement("""{"showFlavorIcons":false}"""))
        assertFalse(settings.showFlavorIcons)
        assertFalse(Settings.parse(settings.toJson()).showFlavorIcons)
        assertEquals(false, settings.toJson()["showFlavorIcons"]?.toString()?.toBoolean())
    }
}
