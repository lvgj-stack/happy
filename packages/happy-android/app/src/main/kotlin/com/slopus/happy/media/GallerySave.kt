package com.slopus.happy.media

import android.content.ContentResolver
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore as AndroidMediaStore
import com.slopus.happy.conversation.MediaFiles
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * A picture put in the phone's own photos: Pictures/Happy, where the
 * gallery and Google Photos find it. Android 10 and later take it without
 * any permission (scoped storage); before that writing there needs
 * WRITE_EXTERNAL_STORAGE, which the app does not ask for, so [available]
 * is false and the viewer offers Share alone.
 */
object GallerySave {
    const val ALBUM = "Happy"

    val available: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    /** The picture type [bytes] begin with, as the gallery files it; null for anything else. */
    fun imageType(bytes: ByteArray): String? {
        fun at(offset: Int, vararg expected: Int) =
            bytes.size >= offset + expected.size && expected.indices.all { bytes[offset + it].toInt() and 0xff == expected[it] }
        return when {
            at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) -> "image/png"
            at(0, 0xff, 0xd8, 0xff) -> "image/jpeg"
            at(0, 0x47, 0x49, 0x46, 0x38) -> "image/gif"
            at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50) -> "image/webp"
            else -> null
        }
    }

    /**
     * Writes [bytes] as [name] of [mimeType] and returns where it went. The
     * entry stays pending, hidden from the gallery, until every byte is in;
     * one that fails half-way is removed rather than left broken.
     */
    suspend fun save(resolver: ContentResolver, bytes: ByteArray, name: String, mimeType: String): Uri {
        check(available) { "Saving to photos needs Android 10" }
        return withContext(Dispatchers.IO) {
            val values = ContentValues().apply {
                put(AndroidMediaStore.MediaColumns.DISPLAY_NAME, MediaFiles.safeName(name, mimeType))
                put(AndroidMediaStore.MediaColumns.MIME_TYPE, mimeType)
                put(AndroidMediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$ALBUM")
                put(AndroidMediaStore.MediaColumns.IS_PENDING, 1)
            }
            val collection = AndroidMediaStore.Images.Media.getContentUri(AndroidMediaStore.VOLUME_EXTERNAL_PRIMARY)
            val uri = resolver.insert(collection, values) ?: error("The gallery refused the picture")
            try {
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("The gallery gave nowhere to write")
                resolver.update(uri, ContentValues().apply { put(AndroidMediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                uri
            } catch (e: Exception) {
                resolver.delete(uri, null, null)
                throw e
            }
        }
    }
}
