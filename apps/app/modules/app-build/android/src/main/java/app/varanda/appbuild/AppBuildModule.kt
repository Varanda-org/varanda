package app.varanda.appbuild

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Read once per process: neither value changes until the app is replaced,
// and replacing it restarts the process.
class AppBuildModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppBuild")

    Constant("versionCode") { versionCode() }

    Constant("fromPlay") { fromPlay() }
  }

  private fun context(): Context? = appContext.reactContext?.applicationContext

  private fun versionCode(): Long? {
    return try {
      val context = context() ?: return null
      context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
    } catch (e: Exception) {
      null
    }
  }

  // Only the installer Android recorded counts: a sideloaded debug or preview
  // APK reports another package, or none.
  private fun fromPlay(): Boolean {
    return try {
      val context = context() ?: return false
      context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName == PLAY_STORE
    } catch (e: Exception) {
      false
    }
  }

  companion object {
    private const val PLAY_STORE = "com.android.vending"
  }
}
