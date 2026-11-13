package app.varanda.shareintake

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The JS side of ShareInbox: peek hands over the newest stored share as local
// file Uris, release drops it once the composer took it, sweep clears old
// leftovers. Native errors never reach JS (null or a no-op), and Uris, paths
// and shared text are never logged.
class ShareIntakeModule : Module() {
  // Only this instance's listener is cleared on destroy: after a reload the
  // new runtime's module may already have set its own.
  private var registered: (() -> Unit)? = null

  override fun definition() = ModuleDefinition {
    Name("ShareIntake")

    Events("onPending")

    OnCreate {
      val listener: () -> Unit = {
        try {
          sendEvent("onPending")
        } catch (e: Exception) {
          // The runtime may be going away; the next peek still finds the share.
        }
      }
      registered = listener
      ShareInbox.listener = listener
    }

    OnDestroy {
      if (ShareInbox.listener === registered) ShareInbox.listener = null
      registered = null
    }

    AsyncFunction("peek") {
      peek()
    }

    AsyncFunction("release") { id: String ->
      try {
        val context = context() ?: return@AsyncFunction
        ShareInbox.release(context, id)
      } catch (e: Exception) {
        // Left for the next sweep.
      }
    }

    AsyncFunction("sweep") { maxAgeMs: Double ->
      try {
        val context = context() ?: return@AsyncFunction
        ShareInbox.sweep(context, maxAgeMs)
      } catch (e: Exception) {
        // Left for the next sweep.
      }
    }
  }

  private fun context(): Context? = appContext.reactContext?.applicationContext

  private fun peek(): Map<String, Any?>? {
    return try {
      val context = context() ?: return null
      val share = ShareInbox.newest(context) ?: return null
      mapOf(
        "id" to share.id,
        "at" to share.at.toDouble(),
        "title" to share.title,
        "text" to share.text,
        "url" to share.url,
        "total" to share.total,
        "files" to share.files.map { f ->
          mapOf(
            "uri" to "file://" + f.file.absolutePath,
            "mimeType" to f.mime,
            "width" to f.width,
            "height" to f.height
          )
        }
      )
    } catch (e: Exception) {
      null
    }
  }
}
