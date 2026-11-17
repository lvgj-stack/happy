package com.slopus.happy.diagnostics

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** CrashLog.install: an uncaught exception is recorded, then goes on to the handler before it. */
@RunWith(AndroidJUnit4::class)
class CrashLogInstallTest {
    private val original = Thread.getDefaultUncaughtExceptionHandler()

    @After
    fun restore() = Thread.setDefaultUncaughtExceptionHandler(original)

    @Test
    fun recordsThenPassesItOn() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        CrashLog.directory(context).deleteRecursively()
        var passed: Throwable? = null
        Thread.setDefaultUncaughtExceptionHandler { _, error -> passed = error }
        CrashLog.install(context, "Happy test")
        val error = IllegalArgumentException("scrolled too far")
        Thread.getDefaultUncaughtExceptionHandler()!!.uncaughtException(Thread.currentThread(), error)
        assertSame(error, passed)
        assertEquals(1, CrashLog.count(context))
        val report = CrashLog.report(context, "Happy test")
        assertTrue(report, report.contains("=== Uncaught exceptions (1) ===\nCrash at "))
        assertTrue(report, report.contains("Happy test\njava.lang.IllegalArgumentException: scrolled too far"))
    }
}
