package com.slopus.happy.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.resolveSessionHarness
import com.slopus.happy.ui.theme.HappyTheme

object SessionHarnessIconTags {
    const val ICON = "session.harnessIcon"
}

object SessionHarnessIconSpec {
    val size = 16.dp
    val titleGap = 6.dp
}

/**
 * A session title's harness: a 16 dp icon followed by 6 dp of space, no
 * visible label. The list setting hides the whole slot. A missing or
 * unfamiliar harness gets a generic chip; accessibility retains its name.
 */
@Composable
fun SessionHarnessIcon(flavor: String? = null, clientId: String? = null, modifier: Modifier = Modifier) {
    if (!LocalAvatarSettings.current.showFlavorIcons) return
    val harness = resolveSessionHarness(flavor, clientId)
    val description = harness?.displayName ?: flavor?.trim()?.takeIf { it.isNotEmpty() } ?: stringResource(R.string.status_unknown)
    val colors = HappyTheme.colors
    val drawable = when (harness) {
        AgentType.Claude -> R.drawable.icon_claude
        AgentType.Codex -> R.drawable.icon_gpt
        AgentType.Cursor -> R.drawable.icon_cursor
        AgentType.Agy -> R.drawable.icon_agy
        AgentType.Gemini -> R.drawable.icon_gemini
        AgentType.OpenClaw -> R.drawable.icon_openclaw
        AgentType.Rig -> R.drawable.happy_logo
        null -> null
    }
    val icon = Modifier.size(SessionHarnessIconSpec.size).testTag(SessionHarnessIconTags.ICON)
    Box(modifier.padding(end = SessionHarnessIconSpec.titleGap)) {
        if (drawable == null) {
            Icon(Ionicon.HardwareChipOutline, SessionHarnessIconSpec.size, colors.textSecondary, icon, description)
        } else {
            Image(
                painter = painterResource(drawable),
                contentDescription = description,
                contentScale = ContentScale.Fit,
                colorFilter = if (harness == AgentType.Codex || harness == AgentType.Cursor || harness == AgentType.Rig) ColorFilter.tint(colors.text) else null,
                modifier = icon,
            )
        }
    }
}
