package app.varanda.authsession

import android.app.Activity
import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import expo.modules.kotlin.Promise
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The Google step of the account link in an Auth Tab (androidx.browser 1.9.0):
// the browser hands the https redirect back to this app only, after checking
// the host against /.well-known/assetlinks.json. Without a trusted browser
// that supports Auth Tab (authTabBrowser) the module reports itself
// unavailable. Native error text never reaches JS, and URLs are never logged
// (they carry the OAuth state and the redeem code).
class AuthSessionModule : Module() {
  companion object {
    private const val CHROME = "com.android.chrome"
  }

  private lateinit var launcher: AppContextActivityResultLauncher<AuthTabInput, AuthTabOutput>

  // Main thread only (open runs on the main queue, results arrive there).
  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("AuthSession")

    Function("isAvailable") {
      authTabBrowser() != null
    }

    AsyncFunction("open") { url: String, host: String, path: String, promise: Promise ->
      if (!validArgs(url, host, path)) {
        promise.reject("INVALID", "invalid", null)
        return@AsyncFunction
      }
      if (pending != null) {
        promise.reject("BUSY", "busy", null)
        return@AsyncFunction
      }
      val activity = appContext.currentActivity
      val browser = authTabBrowser()
      if (activity == null || browser == null) {
        promise.reject("UNSUPPORTED", "unsupported", null)
        return@AsyncFunction
      }
      pending = promise
      try {
        launcher.launch(AuthTabInput(url, host, path, browser)) { output ->
          deliver(host, path, output)
        }
      } catch (e: Exception) {
        pending = null
        promise.reject("UNSUPPORTED", "unsupported", null)
      }
    }.runOnQueue(Queues.MAIN)

    RegisterActivityContracts {
      // The fallback fires when the activity was recreated while the tab was
      // open. The JS runtime usually survives that, so the waiting promise is
      // still answered; either way `pending` is cleared here, so BUSY never
      // sticks after a recreation.
      launcher = registerForActivityResult(AuthTabContract()) { input, output ->
        deliver(input.host, input.path, output)
      }
    }

    OnDestroy {
      pending = null
    }
  }

  private fun deliver(host: String, path: String, output: AuthTabOutput) {
    val promise = pending ?: return
    pending = null
    try {
      promise.resolve(answer(host, path, output))
    } catch (e: Exception) {
      // The JS runtime that asked may be gone after a recreation.
    }
  }

  private fun answer(host: String, path: String, output: AuthTabOutput): Map<String, Any?> =
    when (output.resultCode) {
      Activity.RESULT_OK -> {
        val uri = output.uri
        // Defense in depth: the browser already matched host and path.
        if (uri != null && uri.scheme == "https" && uri.host.equals(host, ignoreCase = true) &&
          uri.port == -1 && uri.path == path && uri.userInfo == null
        ) {
          mapOf("type" to "ok", "url" to uri.toString())
        } else {
          failed("unknown")
        }
      }
      AuthTabIntent.RESULT_CANCELED -> mapOf("type" to "cancel")
      AuthTabIntent.RESULT_VERIFICATION_FAILED -> failed("verification")
      AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT -> failed("timeout")
      else -> failed("unknown")
    }

  private fun failed(reason: String): Map<String, Any?> = mapOf("type" to "failed", "reason" to reason)

  // The browser gets the authorize URL and returns the redeem code, so only
  // the default browser (the person's choice) or the preinstalled Chrome may
  // play it: Auth Tab support is only a declared intent-filter category, and
  // any other app could declare it, finish the Google step with its own
  // account and hand that code back. A system app cannot be sideloaded under
  // Chrome's package name. Chrome's sign-in can differ from the default
  // browser's, so the person may need to sign in to Google there.
  private fun authTabBrowser(): String? {
    return try {
      val context: Context = appContext.reactContext ?: return null
      val default = CustomTabsClient.getPackageName(context, null)
      if (default != null && isAuthTab(context, default)) return default
      if (isSystemApp(context, CHROME) && isAuthTab(context, CHROME)) CHROME else null
    } catch (e: Exception) {
      null
    }
  }

  private fun isSystemApp(context: Context, pkg: String): Boolean {
    return try {
      (context.packageManager.getApplicationInfo(pkg, 0).flags and ApplicationInfo.FLAG_SYSTEM) != 0
    } catch (e: Exception) {
      false
    }
  }

  private fun isAuthTab(context: Context, pkg: String): Boolean {
    return try {
      CustomTabsClient.isAuthTabSupported(context, pkg)
    } catch (e: Exception) {
      false
    }
  }

  private fun validArgs(url: String, host: String, path: String): Boolean {
    return url.startsWith("https://") && url.length > 8 &&
      host.isNotEmpty() && host.none { it == '/' || it == ':' || it.isWhitespace() } &&
      path.startsWith("/") && path.none { it == '?' || it == '#' || it.isWhitespace() }
  }
}
