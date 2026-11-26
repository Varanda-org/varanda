package app.varanda.cameracapture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.net.Uri
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.SecureRandom
import kotlin.math.ceil
import kotlinx.coroutines.launch

// A photo or a short video from the phone's own camera app. The app does not
// declare the camera permission (it is removed from the merged manifest), and
// an app without it may start IMAGE_CAPTURE / VIDEO_CAPTURE with none. The
// result lands in <cache>/CameraCapture under a random name; nothing goes to
// MediaStore or the gallery. Native error text never reaches JS, and paths are
// never logged.
class CameraCaptureModule : Module() {
  companion object {
    private const val DIR = "CameraCapture"
    private const val AUTHORITY_SUFFIX = ".cameracapture"
    private const val MAX_COPY = 512L * 1024 * 1024
    private const val STALE_MS = 24L * 60 * 60 * 1000
    private const val MAX_SEC = 86400.0
  }

  private class Failed : Exception()

  private lateinit var launcher: AppContextActivityResultLauncher<CaptureInput, CaptureOutput>

  private val lock = Any()
  private var pending: Promise? = null
  // Set when the host activity is destroyed while a capture is out: Expo may
  // not redeliver that result, so the next capture replaces it instead of
  // answering BUSY until the process dies.
  private var hostLost = false
  // The file the pending promise waits for: a late result from an orphaned
  // capture must not answer the next one.
  private var pendingPath: String? = null
  private val random = SecureRandom()

  override fun definition() = ModuleDefinition {
    Name("CameraCapture")

    AsyncFunction("isAvailable") { kind: String ->
      if (kind != "photo" && kind != "video") return@AsyncFunction false
      val context = appContext.reactContext ?: return@AsyncFunction false
      resolvable(context, actionFor(kind))
    }

    AsyncFunction("capture") { kind: String, maxMs: Double?, promise: Promise ->
      if (kind != "photo" && kind != "video") {
        promise.reject("FAILED", "failed", null)
        return@AsyncFunction
      }
      var orphan: Promise? = null
      synchronized(lock) {
        if (pending != null && !hostLost) {
          promise.reject("BUSY", "busy", null)
          return@AsyncFunction
        }
        orphan = pending
        pending = promise
        pendingPath = null
        hostLost = false
      }
      orphan?.let { reject(it) }
      var file: File? = null
      try {
        val context = appContext.reactContext ?: throw Failed()
        if (!resolvable(context, actionFor(kind))) {
          release(promise)
          promise.reject("UNAVAILABLE", "unavailable", null)
          return@AsyncFunction
        }
        val dir = File(context.cacheDir, DIR)
        if (!dir.isDirectory && !dir.mkdirs()) throw Failed()
        // After the BUSY check, so a capture still in the camera app keeps
        // its file however long it stays open.
        sweep(dir)
        val out = File(dir, randomName() + if (kind == "video") ".mp4" else ".jpg")
        if (!out.createNewFile()) throw Failed()
        file = out
        val uri = FileProvider.getUriForFile(context, context.packageName + AUTHORITY_SUFFIX, out)
        val input = CaptureInput(kind, out.absolutePath, uri.toString(), seconds(maxMs))
        synchronized(lock) { if (pending === promise) pendingPath = out.absolutePath }
        appContext.mainQueue.launch {
          try {
            launcher.launch(input) { output -> deliver(input, output) }
          } catch (e: Exception) {
            revoke(input)
            out.delete()
            if (release(promise)) reject(promise)
          }
        }
      } catch (e: Exception) {
        file?.delete()
        if (release(promise)) reject(promise)
      }
      Unit
    }

    RegisterActivityContracts {
      // The fallback fires when the activity was recreated while the camera
      // app was open; the module and its pending promise usually survive.
      launcher = registerForActivityResult(CaptureContract()) { input, output ->
        deliver(input, output)
      }
    }

    OnActivityDestroys {
      synchronized(lock) { if (pending != null) hostLost = true }
    }

    OnDestroy {
      synchronized(lock) {
        pending = null
        pendingPath = null
      }
    }
  }

  private fun release(promise: Promise): Boolean = synchronized(lock) {
    if (pending === promise) {
      pending = null
      pendingPath = null
      true
    } else {
      false
    }
  }

  private fun take(path: String): Promise? = synchronized(lock) {
    if (pendingPath != path) return@synchronized null
    val promise = pending
    pending = null
    pendingPath = null
    promise
  }

  private fun reject(promise: Promise) {
    try {
      promise.reject("FAILED", "failed", null)
    } catch (e: Exception) {
      // The JS runtime that asked may be gone.
    }
  }

  private fun deliver(input: CaptureInput, output: CaptureOutput) {
    val promise = take(input.path)
    revoke(input)
    val file = File(input.path)
    // Off the main thread: a copy from the camera app's own Uri can be large.
    appContext.backgroundCoroutineScope.launch {
      val result = try {
        finish(input, output, file)
      } catch (e: Exception) {
        file.delete()
        if (promise != null) reject(promise)
        return@launch
      }
      if (promise == null) {
        file.delete()
        return@launch
      }
      try {
        promise.resolve(result)
      } catch (e: Exception) {
        file.delete()
      }
    }
  }

  private fun finish(input: CaptureInput, output: CaptureOutput, file: File): Map<String, Any>? {
    if (output.resultCode == Activity.RESULT_CANCELED) {
      file.delete()
      return null
    }
    if (output.resultCode != Activity.RESULT_OK) throw Failed()
    if (file.length() == 0L) output.data?.let { copyFrom(it, file) }
    if (!file.isFile || file.length() == 0L) throw Failed()
    val uri = Uri.fromFile(file).toString()
    if (input.kind == "video") {
      return mapOf("uri" to uri, "kind" to "video", "mimeType" to "video/mp4")
    }
    val (width, height) = photoSize(file)
    return mapOf("uri" to uri, "kind" to "photo", "mimeType" to "image/jpeg", "width" to width, "height" to height)
  }

  // Some camera apps ignore EXTRA_OUTPUT and answer with a Uri of their own.
  // Only a content Uri of another app is read: a file:// could point anywhere,
  // and one of this app's own providers would let the camera app make us
  // copy our private files into a post.
  private fun copyFrom(data: Uri, file: File) {
    val context = appContext.reactContext ?: throw Failed()
    val authority = data.authority
    if (data.scheme != "content" || authority.isNullOrEmpty() || ownAuthority(context, authority)) throw Failed()
    val stream = context.contentResolver.openInputStream(data) ?: throw Failed()
    stream.use { input ->
      file.outputStream().use { out ->
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          val n = input.read(buffer)
          if (n < 0) break
          total += n
          if (total > MAX_COPY) throw Failed()
          out.write(buffer, 0, n)
        }
      }
    }
  }

  // A "user@" prefix is stripped by Android before dispatch, so an authority
  // carrying one could still reach this app's own provider: refuse it, and
  // refuse whatever provider would actually serve the Uri if it is ours.
  private fun ownAuthority(context: Context, authority: String): Boolean {
    if (authority.contains('@')) return true
    return try {
      @Suppress("DEPRECATION")
      val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PROVIDERS)
      if (info.providers?.any { p -> p.authority?.split(';')?.contains(authority) == true } == true) return true
      val serving = context.packageManager.resolveContentProvider(authority, 0)
      serving == null || serving.packageName == context.packageName
    } catch (e: Exception) {
      true
    }
  }

  private fun photoSize(file: File): Pair<Int, Int> {
    val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, opts)
    if (opts.outWidth <= 0 || opts.outHeight <= 0 || opts.outMimeType != "image/jpeg") throw Failed()
    val orientation = try {
      ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (e: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }
    val quarterTurn = orientation == ExifInterface.ORIENTATION_ROTATE_90 ||
      orientation == ExifInterface.ORIENTATION_ROTATE_270 ||
      orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
      orientation == ExifInterface.ORIENTATION_TRANSVERSE
    return if (quarterTurn) Pair(opts.outHeight, opts.outWidth) else Pair(opts.outWidth, opts.outHeight)
  }

  private fun revoke(input: CaptureInput) {
    try {
      appContext.reactContext?.revokeUriPermission(Uri.parse(input.uri), GRANT_FLAGS)
    } catch (e: Exception) {
      // Nothing was granted when the launch itself failed.
    }
  }

  private fun resolvable(context: Context, action: String): Boolean {
    return try {
      context.packageManager.resolveActivity(Intent(action), PackageManager.MATCH_DEFAULT_ONLY) != null
    } catch (e: Exception) {
      false
    }
  }

  private fun sweep(dir: File) {
    val cutoff = System.currentTimeMillis() - STALE_MS
    dir.listFiles()?.forEach { f ->
      if (f.isFile && f.lastModified() < cutoff) f.delete()
    }
  }

  private fun randomName(): String {
    val bytes = ByteArray(16)
    random.nextBytes(bytes)
    return bytes.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
  }

  private fun seconds(maxMs: Double?): Int? {
    if (maxMs == null || !maxMs.isFinite() || maxMs <= 0) return null
    return ceil(maxMs / 1000.0).coerceAtMost(MAX_SEC).toInt()
  }
}
