package com.oops.app.store

import com.oops.app.core.Wav
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** Long-term memory = only what the user confirmed: `<id>.json` metadata + `<id>.wav` original audio. */
class SavedClipStore(private val dir: File) {
    init {
        dir.mkdirs()
    }

    fun save(id: String, meta: JSONObject, pcm: ByteArray?): File {
        if (pcm != null) {
            Wav.write(File(dir, "$id.wav"), pcm)
            meta.put("audio", "$id.wav")
        }
        return File(dir, "$id.json").apply { writeText(meta.toString(2)) }
    }

    fun count(): Int = metaFiles().size

    fun list(): List<JSONObject> = metaFiles()
        .sortedByDescending { it.lastModified() }
        .mapNotNull { runCatching { JSONObject(it.readText()) }.getOrNull() }

    @Synchronized fun listStrict(): List<JSONObject> {
        if (!dir.isDirectory) throw IOException("已保存片段目录不可读")
        return (dir.listFiles { f -> f.extension == "json" } ?: throw IOException("已保存片段不可读"))
            .sortedByDescending { it.lastModified() }.map { JSONObject(it.readText()) }
    }

    private fun metaFiles(): List<File> = dir.listFiles { f -> f.extension == "json" }?.toList().orEmpty()
}
