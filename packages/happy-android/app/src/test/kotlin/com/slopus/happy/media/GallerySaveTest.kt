package com.slopus.happy.media

import android.graphics.Bitmap
import android.graphics.Color
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream

/** Pictures into the phone's photos: which bytes count as one, and what the gallery is told. */
@RunWith(AndroidJUnit4::class)
class GallerySaveTest {
    private fun ascii(text: String) = text.map { it.code.toByte() }.toByteArray()

    @Test
    fun theTypeComesFromTheBytes() {
        val png = ByteArrayOutputStream().also {
            Bitmap.createBitmap(4, 3, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }.compress(Bitmap.CompressFormat.PNG, 100, it)
        }.toByteArray()
        assertEquals("image/png", GallerySave.imageType(png))
        assertEquals("image/jpeg", GallerySave.imageType(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte())))
        assertEquals("image/gif", GallerySave.imageType(ascii("GIF89a....")))
        assertEquals("image/webp", GallerySave.imageType(ascii("RIFF") + byteArrayOf(0, 0, 0, 0) + ascii("WEBPVP8 ")))
        // A name or a container proves nothing.
        assertNull(GallerySave.imageType(ascii("<svg xmlns='http://www.w3.org/2000/svg'/>")))
        assertNull(GallerySave.imageType(ascii("RIFF") + byteArrayOf(0, 0, 0, 0) + ascii("WAVEfmt ")))
        assertNull(GallerySave.imageType(byteArrayOf()))
    }

    @Test
    fun aSavedPictureIsInPicturesHappyAndNoLongerPending() = runBlocking {
        val resolver = ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver
        val bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
        assertTrue(GallerySave.available)

        val uri = GallerySave.save(resolver, bytes, "../chart?.png", "image/png")

        assertArrayEquals(bytes, resolver.openInputStream(uri)!!.use { it.readBytes() })
        val columns = arrayOf(
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.RELATIVE_PATH,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.IS_PENDING,
        )
        resolver.query(uri, columns, null, null, null)!!.use { row ->
            assertTrue(row.moveToFirst())
            assertEquals("chart.png", row.getString(0))
            assertEquals("Pictures/Happy", row.getString(1).trimEnd('/'))
            assertEquals("image/png", row.getString(2))
            assertEquals(0, row.getInt(3))
        }
    }
}
