package com.slopus.happy.diagnostics

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import java.io.File
import java.io.InputStream
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * What the app knows of how it last went down, for Settings > About >
 * Crash reports to copy. There is no crash service: a crash is only seen
 * here, on the phone it happened on.
 *
 * Two sources. An uncaught exception is written to `files/crashes/` by
 * [install]'s handler before the process dies, with its stack and the
 * process's last logcat lines. What no handler sees (a native crash, "not
 * responding", a kill for memory) the system keeps itself, Android 11 and
 * later: [report] adds its last process exits, with the ANR's thread dump
 * and the readable words of a native crash's tombstone.
 */
object CrashLog {
    /** Crashes kept on disk; older ones are deleted as new ones come. */
    const val MAX_CRASHES = 5

    /** System process exits listed. */
    const val MAX_EXITS = 8

    /** Logcat lines kept with a crash: what the app did just before. */
    const val CRASH_LOG_LINES = 300

    /** A trace's share of the report: an ANR dumps every thread, the main one first. */
    const val MAX_TRACE_CHARS = 48_000

    /** The whole report, kept well under what the clipboard's binder call carries. */
    const val MAX_REPORT_CHARS = 200_000

    private const val DIR = "crashes"

    fun directory(context: Context): File = File(context.filesDir, DIR)

    /**
     * Records uncaught exceptions from here on, then hands each to the
     * handler that was there before (the system's, which shows the crash
     * dialog and kills the process). [build] heads every record.
     */
    fun install(context: Context, build: String) {
        val dir = directory(context)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                write(dir, System.currentTimeMillis(), build, thread.name, error, logs = { ClientLogs.read().takeLast(CRASH_LOG_LINES) })
            } catch (_: Throwable) {
                // Recording must never stand in the crash's way.
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /** Writes one crash as `crash-<epoch ms>.txt` and keeps the newest [MAX_CRASHES]. */
    internal fun write(dir: File, at: Long, build: String, thread: String, error: Throwable, logs: () -> List<String> = { emptyList() }) {
        dir.mkdirs()
        val file = File(dir, "crash-$at.txt")
        val stack = "Crash at ${time(at)} on thread \"$thread\"\n$build\n${error.stackTraceToString()}"
        // The stack first: the logs come from a second process, which may not finish.
        file.writeText(stack)
        crashFiles(dir).drop(MAX_CRASHES).forEach { it.delete() }
        val lines = try {
            logs()
        } catch (_: Throwable) {
            emptyList()
        }
        if (lines.isNotEmpty()) file.appendText("\n--- logcat, last ${lines.size} lines ---\n" + lines.joinToString("\n") + "\n")
    }

    /** The recorded crashes, newest first. */
    internal fun crashFiles(dir: File): List<File> =
        (dir.listFiles { file -> file.name.startsWith("crash-") && file.name.endsWith(".txt") } ?: emptyArray())
            .sortedByDescending { it.name.removePrefix("crash-").removeSuffix(".txt").toLongOrNull() ?: 0L }

    /** How many crashes are recorded: Crash reports' detail. Blocking. */
    fun count(context: Context): Int = crashFiles(directory(context)).size

    /** The text Crash reports copies. Blocking: run it off the main thread. */
    fun report(context: Context, build: String, now: Long = System.currentTimeMillis()): String {
        val exits = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) systemExits(context) else null
        return report(build, device(), now, crashFiles(directory(context)).map { it.readText() }, exits)
    }

    /** [crashes] newest first; [exits] null where the system keeps none (before Android 11). */
    internal fun report(build: String, device: String, now: Long, crashes: List<String>, exits: List<String>?): String {
        val text = buildString {
            append("=== Happy crash report ===\n")
            append(build).append('\n')
            append(device).append('\n')
            append("Generated ").append(time(now)).append('\n')
            append("\n=== Uncaught exceptions (").append(crashes.size).append(") ===\n")
            if (crashes.isEmpty()) append("None recorded.\n")
            crashes.forEachIndexed { index, crash ->
                if (index > 0) append('\n')
                append(crash.trimEnd()).append('\n')
            }
            append("\n=== Process exits (system record) ===\n")
            when {
                exits == null -> append("Not kept before Android 11.\n")
                exits.isEmpty() -> append("None recorded.\n")
                else -> exits.forEachIndexed { index, exit ->
                    if (index > 0) append('\n')
                    append(exit.trimEnd()).append('\n')
                }
            }
        }
        return if (text.length <= MAX_REPORT_CHARS) text else text.take(MAX_REPORT_CHARS) + "\n… cut at $MAX_REPORT_CHARS characters\n"
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun systemExits(context: Context): List<String> {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
        val infos = try {
            manager.getHistoricalProcessExitReasons(context.packageName, 0, MAX_EXITS)
        } catch (_: RuntimeException) {
            return emptyList()
        }
        return infos.map { info ->
            val trace = try {
                info.traceInputStream?.use { stream -> trace(info.reason, stream) }
            } catch (_: Exception) {
                null
            }
            exit(
                at = info.timestamp,
                reason = reasonName(info.reason),
                status = info.status,
                importance = info.importance,
                description = info.description,
                pssKb = info.pss,
                rssKb = info.rss,
                trace = trace,
            )
        }
    }

    /** One system exit; [trace] is the ANR's dump or the tombstone's words. */
    internal fun exit(at: Long, reason: String, status: Int, importance: Int, description: String?, pssKb: Long, rssKb: Long, trace: String?): String = buildString {
        append(time(at)).append("  ").append(reason)
        append("  status=").append(status)
        append("  importance=").append(importance)
        append("  pss=").append(pssKb / 1024).append("MB rss=").append(rssKb / 1024).append("MB\n")
        if (!description.isNullOrBlank()) append("  ").append(description.trim()).append('\n')
        if (!trace.isNullOrBlank()) append("--- trace ---\n").append(trace.trimEnd()).append('\n')
    }

    /**
     * An ANR's trace is text. A native crash's is a tombstone, a protobuf
     * (Android 12 and later): its frames' function and library names are
     * strings inside it, so the readable runs are kept, one per line.
     */
    internal fun trace(reason: Int, stream: InputStream): String {
        val bytes = readUpTo(stream, if (reason == REASON_CRASH_NATIVE) MAX_TRACE_CHARS * 8 else MAX_TRACE_CHARS * 4)
        val text = if (reason == REASON_CRASH_NATIVE) readableRuns(bytes) else String(bytes, Charsets.UTF_8)
        return if (text.length <= MAX_TRACE_CHARS) text else text.take(MAX_TRACE_CHARS) + "\n… cut"
    }

    /** InputStream.readNBytes, which Android has only from API 33. */
    private fun readUpTo(stream: InputStream, limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (out.size() < limit) {
            val read = stream.read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (read < 0) break
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    /** Runs of at least [min] printable ASCII characters, as `strings` prints them. */
    internal fun readableRuns(bytes: ByteArray, min: Int = 6): String {
        val out = StringBuilder()
        val run = StringBuilder()
        fun flush() {
            if (run.length >= min) out.append(run).append('\n')
            run.setLength(0)
        }
        for (byte in bytes) {
            val c = byte.toInt() and 0xff
            if (c in 0x20..0x7e) run.append(c.toChar()) else flush()
        }
        flush()
        return out.toString()
    }

    private const val REASON_CRASH_NATIVE = 5

    internal fun reasonName(reason: Int): String = when (reason) {
        0 -> "UNKNOWN"
        1 -> "EXIT_SELF"
        2 -> "SIGNALED"
        3 -> "LOW_MEMORY"
        4 -> "CRASH"
        REASON_CRASH_NATIVE -> "CRASH_NATIVE"
        6 -> "ANR"
        7 -> "INITIALIZATION_FAILURE"
        8 -> "PERMISSION_CHANGE"
        9 -> "EXCESSIVE_RESOURCE_USAGE"
        10 -> "USER_REQUESTED"
        11 -> "USER_STOPPED"
        12 -> "DEPENDENCY_DIED"
        13 -> "OTHER"
        14 -> "FREEZER"
        15 -> "PACKAGE_STATE_CHANGE"
        16 -> "PACKAGE_UPDATED"
        else -> "REASON_$reason"
    }

    private fun device(): String =
        "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}), ${Build.SUPPORTED_ABIS.firstOrNull().orEmpty()}"

    private val format = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS xxx")

    internal fun time(at: Long): String = format.format(Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()))
}
