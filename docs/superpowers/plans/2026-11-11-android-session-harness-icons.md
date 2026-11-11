# Android Session Harness Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the harness icon beside every Android session title.

**Architecture:** Resolve harness identity from existing session metadata and draw a shared Compose icon. Flat, project and Happy Agent rows share the icon and the existing `showFlavorIcons` setting, without duplicate avatar badges.

**Tech Stack:** Kotlin, Jetpack Compose, JUnit, Robolectric, existing Android drawable resources.

**Spec:** `docs/superpowers/specs/2026-11-11-android-session-harness-icons-design.md`

## Global Constraints

- Icon size 16 dp; title gap 6 dp; preserve row heights and tree indentation.
- Cover flat, project root, worktree, archived, bot, task and Happy Agent conversation rows.
- Existing setting defaults to true; explicit false remains false.
- Happy identity wins over provider; unknown metadata gets a generic icon.
- Reuse assets and localized unknown copy; no new dependencies or server fields.
- Android builds/tests run on the configured Mac Mini; obtain its address or an explicitly authorized alternative if unavailable.

## Review Focus

- Missing and unfamiliar flavors must not become Claude.
- A Happy session backed by Codex must still show Happy.
- Explicit false must hide icons on both account types.
- Mixed harnesses in one worktree must retain per-session identity.
- Long titles and git/status indicators must fit without changing row height.

### Task 1: Resolve and display session harness identity

**Files:**
- Modify: `packages/happy-android/app/src/main/kotlin/com/slopus/happy/model/SessionPresentation.kt`, `model/Settings.kt`.
- Create: `packages/happy-android/app/src/main/kotlin/com/slopus/happy/ui/components/SessionHarnessIcon.kt`.
- Modify: `ui/components/Avatar.kt`, `ui/home/FlatSessionRow.kt`, `ui/home/ProjectHomeList.kt`, `ui/connection/AgentHomeList.kt` (all under the same Kotlin root).
- Tests: `packages/happy-android/app/src/test/kotlin/com/slopus/happy/model/SessionHarnessTest.kt`, `model/SettingsTest.kt`, `ui/home/SessionHarnessListTest.kt`, `ui/components/HomeComponentsLayoutTest.kt`.
- Documentation: Android AGENTS.md describes default-enabled inline list icons and tasks retaining their unbadged avatars.

**Interfaces:**
- Consumes: `SessionRowData.flavor`, `SessionRowData.clientId`, `LocalAvatarSettings.current.showFlavorIcons`.
- Produces: `resolveSessionHarness(flavor: String?, clientId: String?): AgentType?` and `@Composable SessionHarnessIcon(flavor: String? = null, clientId: String? = null, modifier: Modifier = Modifier)`.
- Exposes test tag `SessionHarnessIconTags.ICON`; content description is the harness name or existing localized unknown text (unrecognized explicit keys remain readable).

- [ ] Write model tests with literal mappings for Claude, Codex, openai/gpt, Cursor, Antigravity, Gemini, OpenClaw, Happy/rig, rig client precedence and null/blank/unknown metadata; assert defaults true and saved false preservation.
- [ ] Write Compose tests against real flat/project/agent rows for distinct harness descriptions, 16 dp icon bounds, 6 dp title gap, absent duplicate badges, archived/task coverage, unknown icon, setting changes, long titles, preserved row heights and click callbacks.
- [ ] Run the focused tests before production changes. Expected: missing resolver or icon behavior causes failure; an unavailable build environment is reported separately.
- [ ] Implement the resolver, shared icon, settings defaults and list integrations; use existing drawables and generic help/chip icon for unrecognized harnesses. Draw Happy on agent connection conversation rows.
- [ ] Update existing tests where the deliberate default change or title start position affects expectations; keep disabled-setting tests explicitly disabled.
- [ ] Run focused tests, then the Android project unit/layout suite in the authorized environment. Expected: all relevant tests pass; report pre-existing or environment failures by name.
- [ ] Review the full change against the design with a fresh reviewer, address important findings and verify changes.
- [ ] Commit the implementation and tests; leave remote pushes and main integration for the user's instruction.

## Execution

User approved implementation of the design. Execute inline in the existing `quick-meadow` worktree without another design approval. Progress and any rulings are recorded in this plan's ignored execution workspace.
