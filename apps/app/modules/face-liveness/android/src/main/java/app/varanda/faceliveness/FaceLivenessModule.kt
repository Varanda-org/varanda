package app.varanda.faceliveness

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.Serializable
import kotlinx.coroutines.launch

// Expo persists the launch input in the saved state so it can answer after a
// recreation: it must carry nothing, the real input goes through CaptureInput.
class CaptureLaunch : Serializable

class CaptureContract : AppContextActivityResultContract<CaptureLaunch, String?> {
  override fun createIntent(context: Context, input: CaptureLaunch): Intent =
    Intent(context, FaceLivenessActivity::class.java)

  // null is success; anything unexpected is FAILED.
  override fun parseResult(input: CaptureLaunch, resultCode: Int, intent: Intent?): String? {
    if (resultCode == Activity.RESULT_OK) return null
    val code = intent?.getStringExtra(FaceLivenessActivity.EXTRA_CODE)
    return if (code != null && code in FaceLivenessActivity.CODES) code else FaceLivenessActivity.FAILED
  }
}

// The AWS Face Liveness capture (com.amplifyframework.ui:liveness). The guest
// credentials arrive from JS in memory and go to the Activity in memory only.
// Errors reaching JS carry the bare code and a fixed message, never SDK or
// credential text.
class FaceLivenessModule : Module() {
  private lateinit var launcher: AppContextActivityResultLauncher<CaptureLaunch, String?>

  // Main thread only (start runs on the main queue, results arrive there).
  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("FaceLiveness")

    Function("isAvailable") {
      hasFrontCamera()
    }

    // Closes a running capture; start() then rejects with CANCELLED. Called
    // from the JS thread, but start() is only posted to the main queue, so
    // a cancel run here at once would miss a start() still waiting there
    // and the capture would open over a screen the person left. Posting to
    // the same scope (Dispatchers.Main, one Handler on the main looper)
    // keeps the JS call order: a start() called before runs before, and a
    // start() called after runs after, so it is never cancelled by this.
    Function("cancel") {
      try {
        appContext.mainQueue.launch {
          try {
            CaptureInput.requestCancel()
          } catch (e: Exception) {
            // Never throws.
          }
        }
      } catch (e: Exception) {
        // Never throws to JS.
      }
    }

    AsyncFunction("start") { payload: Map<String, Any?>, promise: Promise ->
      val input = parse(payload)
      if (input == null) {
        promise.reject(fail("INVALID"))
        return@AsyncFunction
      }
      if (pending != null) {
        promise.reject(fail("BUSY"))
        return@AsyncFunction
      }
      if (input.expiration <= System.currentTimeMillis()) {
        promise.reject(fail(FaceLivenessActivity.SESSION_EXPIRED))
        return@AsyncFunction
      }
      if (appContext.currentActivity == null || !hasFrontCamera()) {
        promise.reject(fail(FaceLivenessActivity.UNSUPPORTED))
        return@AsyncFunction
      }
      pending = promise
      CaptureInput.put(input)
      try {
        launcher.launch(CaptureLaunch()) { code -> deliver(code) }
      } catch (e: Exception) {
        pending = null
        CaptureInput.finished()
        promise.reject(fail(FaceLivenessActivity.UNSUPPORTED))
      }
    }.runOnQueue(Queues.MAIN)

    RegisterActivityContracts {
      // Only reached after a process death restored Expo's saved registry:
      // `pending` is null then, so this just clears the capture state.
      launcher = registerForActivityResult(CaptureContract()) { _, code ->
        deliver(code)
      }
    }

    // When the app's activity dies behind the capture (memory pressure, "Don't
    // keep activities", a config change it does not handle), Expo unregisters
    // the launch callback and registers the contract again under a new key
    // once a new activity resumes, so the result of this capture never
    // reaches `pending`. Settle it now and close the screen, so a later
    // start() is not BUSY forever. Runs on the main thread, like deliver().
    OnActivityDestroys {
      val promise = pending ?: return@OnActivityDestroys
      pending = null
      try {
        CaptureInput.requestCancel()
      } catch (e: Exception) {
        // The screen closes on its own or was already gone.
      }
      CaptureInput.finished()
      try {
        promise.reject(fail(FaceLivenessActivity.FAILED))
      } catch (e: Exception) {
        // The JS runtime that asked may be gone.
      }
    }

    OnDestroy {
      pending = null
      CaptureInput.finished()
    }
  }

  private fun deliver(code: String?) {
    CaptureInput.finished()
    val promise = pending ?: return
    pending = null
    try {
      if (code == null) promise.resolve(mapOf("ok" to true)) else promise.reject(fail(code))
    } catch (e: Exception) {
      // The JS runtime that asked may be gone after a recreation.
    }
  }

  private fun fail(code: String) = CodedException(code, "face liveness: " + code.lowercase(), null)

  private fun hasFrontCamera(): Boolean {
    return try {
      val context: Context = appContext.reactContext ?: return false
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FRONT)
    } catch (e: Exception) {
      false
    }
  }

  private fun parse(payload: Map<String, Any?>): CaptureInput? {
    val sessionId = payload["sessionId"] as? String
    val region = payload["region"] as? String
    val credentials = payload["credentials"] as? Map<*, *>
    val accessKeyId = credentials?.get("accessKeyId") as? String
    val secretAccessKey = credentials?.get("secretAccessKey") as? String
    val sessionToken = credentials?.get("sessionToken") as? String
    val expiration = (credentials?.get("expiration") as? Number)?.toDouble()
    if (sessionId.isNullOrEmpty() || region.isNullOrEmpty() || accessKeyId.isNullOrEmpty() ||
      secretAccessKey.isNullOrEmpty() || sessionToken.isNullOrEmpty() ||
      expiration == null || !expiration.isFinite() || expiration <= 0
    ) {
      return null
    }
    if (!REGION.matches(region) || sessionId.length > 128) return null
    return CaptureInput(sessionId, region, accessKeyId, secretAccessKey, sessionToken, expiration.toLong())
  }

  private companion object {
    val REGION = Regex("^[a-z]{2}(-[a-z]+)+-[0-9]$")
  }
}
