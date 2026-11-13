package app.varanda.shareintake

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// Everything another app shares with Varanda lands here as plain files in the
// app's cache, so the JS side never touches a foreign Uri or its grant. One
// directory per share; its manifest.json is written last (temporary file and
// rename), so a directory without one is a capture still in progress.
object ShareInbox {
  const val MAX_FILES = 10
  const val MAX_BYTES = 50L * 1024 * 1024
  const val MAX_TEXT = 4000
  // A file that delivers no byte for this long, counted from its open, is
  // skipped: its open is cancelled, its descriptor closed and its thread left.
  const val STALL_MS = 30_000L

  private const val DIR = "varanda-share"
  private const val MANIFEST = "manifest.json"
  private const val MANIFEST_TMP = "manifest.json.tmp"
  private const val PART = ".part"
  // A released share is renamed to this before it is deleted. The suffix can
  // never match ID, so newest() cannot offer it again if the delete fails.
  private const val GONE = ".gone"
  private const val WATCH_MS = 1_000L
  // File threads alive across every share in this process. One stuck in a
  // provider call is never joined and may never end, so a sender that keeps
  // sharing cannot pile up more than this: past it, the file is skipped.
  private const val MAX_LIVE = 16
  private val live = AtomicInteger(0)
  private const val MAX_ZERO_READS = 8
  private const val ZERO_READ_PAUSE_MS = 50L
  private val ID = Regex("^[0-9]{13}-[0-9a-f]{32}$")
  // A tampered or stale manifest must not point outside its own directory.
  private val FILE_NAME = Regex("^[0-9]{1,2}\\.(jpg|png|gif|webp|heic|img)$")
  private val random = SecureRandom()

  // Set by the module while a JS runtime is alive, so a share that arrives
  // with the app open reaches the composer without a relaunch.
  @Volatile
  var listener: (() -> Unit)? = null

  class SharedFile(val file: File, val mime: String, val width: Int, val height: Int)

  class Share(
    val id: String,
    val at: Long,
    val title: String,
    val text: String,
    val url: String,
    val total: Int,
    val files: List<SharedFile>
  )

  private class Cancelled : Exception()
  private class Stalled : Exception()

  // One file's open and copy into its own part file. Its fields are read and
  // written only under the Guard's lock.
  internal class Attempt(val part: File) {
    val signal = CancellationSignal()
    var pfd: ParcelFileDescriptor? = null
    var last = SystemClock.elapsedRealtime()
    var abandoned = false
    var finished = false
    var kept = false
  }

  // Stops a capture from another thread. Each file is opened and copied on its
  // own thread: a provider may block in openFile and ignore the signal, and
  // then there is no descriptor to close, so only leaving that thread behind
  // lets the rest of the share go on. One lock decides whether a file thread
  // still owns its attempt, so an abandoned one never creates or hands over a
  // file in the share.
  class Guard {
    private val lock = ReentrantLock()
    private val changed = lock.newCondition()
    @Volatile
    private var stopped = false
    private var current: Attempt? = null

    val cancelled: Boolean get() = stopped

    // Main thread, from onDestroy: it must not wait for any copy.
    fun cancel() {
      lock.withLock {
        stopped = true
        current?.let { abandon(it) }
        changed.signalAll()
      }
    }

    // Capture thread. True when the part holds the whole file, synced, and now
    // belongs to the caller; false when it was refused, failed or stalled.
    internal fun copy(part: File, work: (Attempt) -> Boolean): Boolean {
      val attempt = Attempt(part)
      lock.withLock {
        if (stopped) throw Cancelled()
        current = attempt
      }
      try {
        if (live.incrementAndGet() > MAX_LIVE) {
          live.decrementAndGet()
          return false
        }
        val thread = Thread({
          try {
            settle(attempt, work)
          } finally {
            live.decrementAndGet()
          }
        }, "varanda-share-file")
        thread.isDaemon = true
        try {
          thread.start()
        } catch (e: Throwable) {
          live.decrementAndGet()
          throw e
        }
        return lock.withLock {
          while (!stopped && !attempt.finished && SystemClock.elapsedRealtime() - attempt.last <= STALL_MS) {
            changed.await(WATCH_MS, TimeUnit.MILLISECONDS)
          }
          if (stopped) throw Cancelled()
          attempt.finished && attempt.kept
        }
      } finally {
        lock.withLock {
          // Not joined: a thread stuck in the provider may never return.
          if (!attempt.finished) abandon(attempt)
          current = null
        }
      }
    }

    // A late open on an abandoned attempt gets its descriptor closed here, and
    // its part file is only created while the attempt is still owned.
    internal fun attach(attempt: Attempt, pfd: ParcelFileDescriptor): FileOutputStream {
      return lock.withLock {
        try {
          if (attempt.abandoned) throw Stalled()
          val sink = FileOutputStream(attempt.part)
          attempt.pfd = pfd
          sink
        } catch (e: Exception) {
          quietly { pfd.close() }
          throw e
        }
      }
    }

    internal fun progress(attempt: Attempt) {
      lock.withLock {
        if (attempt.abandoned) throw Stalled()
        attempt.last = SystemClock.elapsedRealtime()
      }
    }

    // File thread. Handing over and abandoning both happen under the lock, so
    // exactly one of them wins; the loser only cleans up its own part.
    private fun settle(attempt: Attempt, work: (Attempt) -> Boolean) {
      val kept = try {
        work(attempt)
      } catch (e: Throwable) {
        // An uncaught throw on this thread would end the whole process.
        false
      }
      if (!kept) attempt.part.delete()
      val handed = lock.withLock {
        if (attempt.abandoned) {
          false
        } else {
          attempt.kept = kept
          attempt.finished = true
          changed.signalAll()
          true
        }
      }
      if (!handed) attempt.part.delete()
    }

    // Called with the lock held.
    private fun abandon(attempt: Attempt) {
      attempt.abandoned = true
      val pfd = attempt.pfd
      attempt.pfd = null
      quietly { attempt.signal.cancel() }
      if (pfd != null) quietly { pfd.close() }
    }

    private inline fun quietly(block: () -> Unit) {
      try {
        block()
      } catch (e: Exception) {
        // Already closed or the provider is gone: nothing left to stop.
      }
    }
  }

  fun isId(id: String): Boolean = ID.matches(id)

  private fun root(context: Context): File = File(context.cacheDir, DIR)

  // Off the main thread: it copies up to MAX_FILES streams of MAX_BYTES each.
  // A stalled file is skipped and the rest are still copied: each Uri has its
  // own descriptor, so closing one cannot corrupt another, and one slow cloud
  // photo should not cost the whole share. The person leaving stops it all.
  fun capture(context: Context, intent: Intent, guard: Guard): String? {
    val at = System.currentTimeMillis()
    val id = at.toString().padStart(13, '0') + "-" + hex(16)
    if (!isId(id)) return null
    val dir = File(root(context), id)
    try {
      if (!dir.mkdirs()) return null
      val title = cut(textExtra(intent, Intent.EXTRA_SUBJECT))
      val text = cut(textExtra(intent, Intent.EXTRA_TEXT))
      val offered = if (intent.type?.startsWith("image/", ignoreCase = true) == true) streams(intent) else emptyList()
      val kept = ArrayList<SharedFile>()
      for ((i, uri) in offered.take(MAX_FILES).withIndex()) {
        if (guard.cancelled) throw Cancelled()
        try {
          val file = copyImage(context, uri, dir, i, kept.size, guard)
          if (file != null) kept.add(file)
        } catch (e: Cancelled) {
          throw e
        } catch (e: Exception) {
          // One unreadable or stalled Uri must not cost the rest of the share.
        }
      }
      if (guard.cancelled || (title.isBlank() && text.isBlank() && kept.isEmpty())) {
        dir.deleteRecursively()
        return null
      }
      writeManifest(dir, id, at, title, text, offered.size, kept)
      return id
    } catch (e: Exception) {
      dir.deleteRecursively()
      return null
    }
  }

  // The newest complete share. Only one share is ever pending, so the older
  // complete ones go; a directory without a manifest is still being written.
  fun newest(context: Context): Share? {
    val children = root(context).listFiles() ?: return null
    val complete = children
      .filter { it.isDirectory && isId(it.name) && File(it, MANIFEST).isFile }
      .sortedByDescending { it.name }
    var found: Share? = null
    for (dir in complete) {
      if (found == null) {
        found = read(dir)
        if (found != null) continue
      }
      drop(dir)
    }
    return found
  }

  fun release(context: Context, id: String) {
    if (!isId(id)) return
    drop(File(root(context), id))
  }

  // deleteRecursively can stop halfway and leave the manifest, so the share is
  // first moved out of newest()'s reach. If even the rename fails, the
  // manifest goes first for the same reason.
  private fun drop(dir: File) {
    if (!dir.exists()) return
    val tomb = File(dir.parentFile, dir.name + GONE)
    if (tomb.exists()) tomb.deleteRecursively()
    if (dir.renameTo(tomb)) {
      tomb.deleteRecursively()
    } else {
      File(dir, MANIFEST).delete()
      dir.deleteRecursively()
    }
  }

  fun sweep(context: Context, maxAgeMs: Double) {
    // NaN or a negative age from JS would otherwise wipe captures in progress.
    if (maxAgeMs.isNaN() || maxAgeMs < 0) return
    val children = root(context).listFiles() ?: return
    val oldest = System.currentTimeMillis() - maxAgeMs.toLong()
    for (child in children) {
      val name = child.name
      // Tombstones (<id>.gone) and any other stray name go whatever their age.
      if (name.endsWith(GONE) || !isId(name) || name.substring(0, 13).toLong() < oldest) child.deleteRecursively()
    }
  }

  private fun hex(bytes: Int): String {
    val buf = ByteArray(bytes)
    random.nextBytes(buf)
    val out = StringBuilder(bytes * 2)
    for (b in buf) {
      val v = b.toInt() and 0xff
      out.append(Character.forDigit(v shr 4, 16))
      out.append(Character.forDigit(v and 0xf, 16))
    }
    return out.toString()
  }

  // Senders may put a String or a styled CharSequence; a malformed extra
  // counts as no text rather than failing the whole share.
  private fun textExtra(intent: Intent, key: String): String {
    return try {
      intent.getCharSequenceExtra(key)?.toString() ?: ""
    } catch (e: Exception) {
      ""
    }
  }

  private fun cut(value: String): String {
    if (value.length <= MAX_TEXT) return value
    val end = if (Character.isHighSurrogate(value[MAX_TEXT - 1])) MAX_TEXT - 1 else MAX_TEXT
    return value.substring(0, end)
  }

  private fun streams(intent: Intent): List<Uri> {
    val found = LinkedHashSet<Uri>()
    try {
      @Suppress("DEPRECATION")
      val extra = intent.extras?.get(Intent.EXTRA_STREAM)
      if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        if (extra is List<*>) {
          // The system checks that the sender can read the streams only when
          // the whole list reads as Uris, so a list with anything else is
          // refused whole rather than read without that check.
          if (extra.any { it !is Uri }) return emptyList()
          for (item in extra) found.add(item as Uri)
        }
      } else if (extra is Uri) {
        found.add(extra)
      }
    } catch (e: Exception) {
      // A malformed extra falls through to the clip data below.
    }
    if (found.isEmpty()) {
      try {
        val clip = intent.clipData
        if (clip != null) {
          for (i in 0 until clip.itemCount) clip.getItemAt(i)?.uri?.let { found.add(it) }
        }
      } catch (e: Exception) {
        // No readable clip data: nothing to copy.
      }
    }
    return found.toList()
  }

  // Another app could share a content Uri of one of Varanda's own providers
  // (its private files), which Varanda can always read, and so make it attach
  // them. A null answer is not a refusal: package visibility hides foreign
  // providers. The user id prefix (10@authority) is dropped like
  // ContentProvider.getAuthorityWithoutUserId does, or it would hide our own.
  private fun isOwnProvider(context: Context, uri: Uri): Boolean {
    val authority = uri.authority ?: return true
    val bare = authority.substring(authority.lastIndexOf('@') + 1)
    if (bare.isEmpty()) return true
    val info = context.packageManager.resolveContentProvider(bare, 0) ?: return false
    return info.packageName == context.packageName
  }

  private fun copyImage(context: Context, uri: Uri, dir: File, i: Int, n: Int, guard: Guard): SharedFile? {
    if (uri.scheme != "content") return null
    if (isOwnProvider(context, uri)) return null
    // Named by its place in the offer, not in the kept list: an abandoned
    // thread may still hold its part, so no later file may reuse the name.
    val part = File(dir, i.toString() + PART)
    try {
      if (!guard.copy(part) { attempt -> fetch(context, uri, attempt, guard) }) {
        part.delete()
        return null
      }
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(part.path, bounds)
      val mime = bounds.outMimeType
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || mime == null || !mime.startsWith("image/")) {
        part.delete()
        return null
      }
      val target = File(dir, n.toString() + "." + extension(mime))
      if (!part.renameTo(target)) {
        part.delete()
        return null
      }
      // encode.native.js resizes with both sides given, so unrotated sizes
      // would squash a portrait photo; an unreadable orientation is refused.
      return when (quarterTurn(target, mime)) {
        true -> SharedFile(target, mime, bounds.outHeight, bounds.outWidth)
        false -> SharedFile(target, mime, bounds.outWidth, bounds.outHeight)
        null -> {
          target.delete()
          null
        }
      }
    } catch (e: Exception) {
      part.delete()
      throw e
    }
  }

  // On the attempt's own thread. True when the part holds the whole file.
  private fun fetch(context: Context, uri: Uri, attempt: Attempt, guard: Guard): Boolean {
    // openFileDescriptor refuses a provider that serves the image from inside a
    // larger file; the asset descriptor's stream reads just that slice.
    val afd = context.contentResolver.openAssetFileDescriptor(uri, "r", attempt.signal) ?: return false
    val output = guard.attach(attempt, afd.parcelFileDescriptor)
    var size = 0L
    var zeros = 0
    afd.createInputStream().use { source ->
      output.use { sink ->
        val buf = ByteArray(64 * 1024)
        while (true) {
          if (guard.cancelled) throw Cancelled()
          val read = source.read(buf)
          if (read < 0) break
          // A sender that keeps answering with nothing is a stall too, and
          // must not spin the thread until the capture gives up on it.
          if (read == 0) {
            if (++zeros >= MAX_ZERO_READS) throw Stalled()
            Thread.sleep(ZERO_READ_PAUSE_MS)
            continue
          }
          zeros = 0
          guard.progress(attempt)
          size += read
          if (size > MAX_BYTES) return false
          sink.write(buf, 0, read)
        }
        // The manifest is synced before it names this file, so the bytes
        // it points to must be on disk first.
        sink.fd.sync()
      }
    }
    return true
  }

  private fun extension(mime: String): String = when (mime.lowercase()) {
    "image/jpeg" -> "jpg"
    "image/png" -> "png"
    "image/gif" -> "gif"
    "image/webp" -> "webp"
    "image/heic", "image/heif" -> "heic"
    else -> "img"
  }

  // null when a format that carries EXIF cannot be read: guessing "upright"
  // would store a rotated photo with swapped sizes. A file with no EXIF block
  // reads fine and counts as upright.
  private fun quarterTurn(file: File, mime: String): Boolean? {
    return try {
      when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90,
        ExifInterface.ORIENTATION_ROTATE_270,
        ExifInterface.ORIENTATION_TRANSPOSE,
        ExifInterface.ORIENTATION_TRANSVERSE -> true
        else -> false
      }
    } catch (e: Exception) {
      if (carriesExif(mime)) null else false
    }
  }

  private fun carriesExif(mime: String): Boolean = when (mime.lowercase()) {
    "image/jpeg", "image/heic", "image/heif", "image/webp" -> true
    else -> false
  }

  private fun writeManifest(
    dir: File,
    id: String,
    at: Long,
    title: String,
    text: String,
    total: Int,
    files: List<SharedFile>
  ) {
    val list = JSONArray()
    for (f in files) {
      list.put(
        JSONObject()
          .put("name", f.file.name)
          .put("mime", f.mime)
          .put("width", f.width)
          .put("height", f.height)
      )
    }
    val json = JSONObject()
      .put("v", 1)
      .put("id", id)
      .put("at", at)
      .put("title", title)
      .put("text", text)
      .put("url", "")
      .put("total", total)
      .put("files", list)
    val tmp = File(dir, MANIFEST_TMP)
    FileOutputStream(tmp).use { out ->
      out.write(json.toString().toByteArray(Charsets.UTF_8))
      out.fd.sync()
    }
    if (!tmp.renameTo(File(dir, MANIFEST))) {
      throw IllegalStateException("manifest")
    }
  }

  private fun read(dir: File): Share? {
    return try {
      val json = JSONObject(File(dir, MANIFEST).readText(Charsets.UTF_8))
      if (json.getInt("v") != 1 || json.getString("id") != dir.name) return null
      val list = json.getJSONArray("files")
      if (list.length() > MAX_FILES) return null
      val files = ArrayList<SharedFile>()
      for (i in 0 until list.length()) {
        val item = list.getJSONObject(i)
        val name = item.getString("name")
        val mime = item.getString("mime")
        val width = item.getInt("width")
        val height = item.getInt("height")
        val file = File(dir, name)
        if (!FILE_NAME.matches(name) || !mime.startsWith("image/") || width <= 0 || height <= 0 || !file.isFile) {
          return null
        }
        files.add(SharedFile(file, mime, width, height))
      }
      Share(
        id = dir.name,
        at = json.getLong("at"),
        title = json.getString("title"),
        text = json.getString("text"),
        url = json.getString("url"),
        total = json.getInt("total"),
        files = files
      )
    } catch (e: Exception) {
      null
    }
  }
}
