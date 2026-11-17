package com.slopus.happy.diagnostics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** CrashLog: what a crash leaves on disk and what Crash reports copies. */
class CrashLogTest {
    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun aCrashIsItsStackThenTheLastLogLines() {
        val dir = folder.newFolder("crashes")
        CrashLog.write(dir, 1_000, "Happy 1 (1)", "main", IllegalStateException("boom"), logs = { listOf("a", "b") })
        val text = CrashLog.crashFiles(dir).single().readText()
        assertTrue(text, text.startsWith("Crash at "))
        assertTrue(text, text.contains("on thread \"main\"\nHappy 1 (1)\njava.lang.IllegalStateException: boom\n\tat "))
        assertTrue(text, text.endsWith("--- logcat, last 2 lines ---\na\nb\n"))
    }

    @Test
    fun theStackStaysWhenTheLogsFail() {
        val dir = folder.newFolder("crashes")
        CrashLog.write(dir, 1_000, "b", "main", RuntimeException("x"), logs = { throw OutOfMemoryError() })
        val text = CrashLog.crashFiles(dir).single().readText()
        assertTrue(text, text.contains("java.lang.RuntimeException: x"))
        assertFalse(text, text.contains("logcat"))
    }

    @Test
    fun theNewestFiveAreKeptNewestFirst() {
        val dir = folder.newFolder("crashes")
        // 999 sorts after 1000 as text: the order is the number's.
        for (at in listOf(999L, 1_000, 1_001, 1_002, 1_003, 1_004, 1_005)) CrashLog.write(dir, at, "b", "main", RuntimeException("$at"))
        assertEquals(
            listOf("crash-1005.txt", "crash-1004.txt", "crash-1003.txt", "crash-1002.txt", "crash-1001.txt"),
            CrashLog.crashFiles(dir).map { it.name },
        )
    }

    @Test
    fun theReportListsBothSources() {
        val report = CrashLog.report("Happy 1 (1)", "Pixel", 0, listOf("crash two\n", "crash one"), listOf("exit"))
        assertTrue(report, report.startsWith("=== Happy crash report ===\nHappy 1 (1)\nPixel\nGenerated "))
        assertTrue(report, report.contains("=== Uncaught exceptions (2) ===\ncrash two\n\ncrash one\n"))
        assertTrue(report, report.endsWith("=== Process exits (system record) ===\nexit\n"))
        val empty = CrashLog.report("b", "d", 0, emptyList(), null)
        assertTrue(empty, empty.contains("=== Uncaught exceptions (0) ===\nNone recorded.\n"))
        assertTrue(empty, empty.endsWith("Not kept before Android 11.\n"))
    }

    @Test
    fun theReportIsCut() {
        val report = CrashLog.report("b", "d", 0, listOf("x".repeat(CrashLog.MAX_REPORT_CHARS)), emptyList())
        assertTrue(report.length < CrashLog.MAX_REPORT_CHARS + 100)
        assertTrue(report.endsWith("cut at ${CrashLog.MAX_REPORT_CHARS} characters\n"))
    }

    @Test
    fun anExitWithItsTrace() {
        val text = CrashLog.exit(0, "ANR", 0, 100, " Input dispatching timed out ", 300 * 1024, 400 * 1024, "\"main\" prio=5\n")
        assertTrue(text, text.endsWith("  ANR  status=0  importance=100  pss=300MB rss=400MB\n  Input dispatching timed out\n--- trace ---\n\"main\" prio=5\n"))
    }

    @Test
    fun aTombstoneKeepsItsReadableWords() {
        val bytes = byteArrayOf(0x0a, 0x12) + "libhwui.so".toByteArray() + byteArrayOf(0, 1, 2) + "abc".toByteArray() + byteArrayOf(-1) +
            "SkCanvas::drawText".toByteArray()
        assertEquals("libhwui.so\nSkCanvas::drawText\n", CrashLog.trace(5, bytes.inputStream()))
        assertEquals("\"main\"\n", CrashLog.trace(6, "\"main\"\n".byteInputStream()))
        assertEquals("CRASH_NATIVE", CrashLog.reasonName(5))
        assertEquals("ANR", CrashLog.reasonName(6))
    }
}
