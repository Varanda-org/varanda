package app.varanda.pushdevice

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean

class PushDeviceModule : Module() {
  private var pendingIntent: String? = null
  private var observingIntents = false
  private var observingSync = false

  override fun definition() = ModuleDefinition {
    Name("PushDevice")
    Events("onToken", "onIntent", "onSync")

    OnCreate {
      active = WeakReference(this@PushDeviceModule)
      context()?.let {
        val manager = it.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("conversas", "Conversas", NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel("avisos", "Avisos", NotificationManager.IMPORTANCE_DEFAULT))
        initializeFirebase(it)
      }
    }

    OnDestroy {
      if (active?.get() === this@PushDeviceModule) active = null
    }

    OnStartObserving("onIntent") {
      Handler(Looper.getMainLooper()).post {
        observingIntents = true
        takeIntent()?.let { emit("onIntent", mapOf("kind" to it)) }
      }
    }

    OnStopObserving("onIntent") {
      Handler(Looper.getMainLooper()).post { observingIntents = false }
    }

    Function("configured") { configured() }

    OnStartObserving("onSync") {
      Handler(Looper.getMainLooper()).post { observingSync = true }
    }

    OnStopObserving("onSync") {
      Handler(Looper.getMainLooper()).post { observingSync = false }
    }

    AsyncFunction("clearDelivered") { tags: List<String> ->
      context()?.let { clearDelivered(it, tags) }
    }
    Function("transport") { if (configured()) "fcm" else null }

    AsyncFunction("permission") { promise: Promise ->
      readPermission { promise.resolve(it) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("request") { promise: Promise ->
      readPermission { status ->
        if (status != "undetermined" || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
          promise.resolve(status)
        } else {
          try {
            val permissions = appContext.permissions
            if (permissions == null || appContext.currentActivity == null) {
              promise.resolve("undetermined")
            } else {
              permissions.askForPermissions({
                readPermission { result -> promise.resolve(result) }
              }, Manifest.permission.POST_NOTIFICATIONS)
            }
          } catch (e: Exception) {
            promise.resolve("undetermined")
          }
        }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("token") { promise: Promise ->
      getToken(promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("launchIntent") {
      takeIntent()
    }.runOnQueue(Queues.MAIN)

    OnNewIntent { intent ->
      consumeIntent(intent)?.let { receiveIntent(it) }
    }
  }

  private fun takeIntent(): String? {
    val launch = consumeIntent(appContext.currentActivity?.intent)
    val kind = pendingIntent ?: launch
    pendingIntent = null
    return kind
  }

  private fun receiveIntent(kind: String) {
    if (observingIntents) {
      emit("onIntent", mapOf("kind" to kind))
    } else {
      pendingIntent = kind
    }
  }

  private fun context(): Context? = appContext.reactContext?.applicationContext

  private fun readPermission(done: (String) -> Unit) {
    try {
      val context = context()
      if (context == null) {
        done("undetermined")
        return
      }
      val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        done(if (enabled) "granted" else "denied")
        return
      }
      val permissions = appContext.permissions
      if (permissions == null) {
        done("undetermined")
        return
      }
      permissions.getPermissions({ result ->
        val status = result[Manifest.permission.POST_NOTIFICATIONS]?.status
        done(when (status) {
          PermissionsStatus.GRANTED -> if (enabled) "granted" else "denied"
          PermissionsStatus.DENIED -> "denied"
          else -> "undetermined"
        })
      }, Manifest.permission.POST_NOTIFICATIONS)
    } catch (e: Exception) {
      done("undetermined")
    }
  }

  private fun getToken(promise: Promise) {
    if (!configured()) {
      promise.resolve(null)
      return
    }
    val handler = Handler(Looper.getMainLooper())
    val settled = AtomicBoolean(false)
    val timeout = Runnable {
      if (settled.compareAndSet(false, true)) promise.resolve(null)
    }
    fun finish(token: String?) {
      if (settled.compareAndSet(false, true)) {
        handler.removeCallbacks(timeout)
        promise.resolve(token)
      }
    }
    handler.postDelayed(timeout, 20_000L)
    readPermission { status ->
      if (status != "granted" || settled.get()) {
        finish(null)
      } else {
        try {
          val context = context()
          if (context == null || !initializeFirebase(context)) {
            finish(null)
          } else {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
              finish(if (task.isSuccessful) task.result else null)
            }
          }
        } catch (e: Exception) {
          finish(null)
        }
      }
    }
  }

  private fun consumeIntent(intent: Intent?): String? {
    if (intent == null) return null
    return try {
      val kind = intent.getStringExtra("k")
      if (kind in setOf("dm", "dm-page", "group", "group-private", "social", "invite-drop")) kind else null
    } catch (e: Exception) {
      null
    } finally {
      intent.removeExtra("k")
    }
  }

  private fun emit(event: String, payload: Map<String, String>) {
    try {
      sendEvent(event, payload)
    } catch (e: Exception) {
      // A service callback can outlive the JS runtime during a reload.
    }
  }

  companion object {
    @Volatile private var active: WeakReference<PushDeviceModule>? = null

    internal fun validTags(tags: List<String>): Boolean =
      tags.size in 1..64 && tags.all { it.matches(Regex("[A-Za-z0-9_-]{16}")) }

    internal fun clearDelivered(context: Context, tags: List<String>, asOf: Long? = null) {
      if (!validTags(tags)) return
      try {
        val manager = context.getSystemService(NotificationManager::class.java)
        for (notice in manager.activeNotifications) {
          if (notice.tag in tags && (asOf == null || notice.notification.`when` <= asOf)) {
            manager.cancel(notice.tag, notice.id)
          }
        }
      } catch (e: Exception) {
        // Notification access can disappear while the service is running.
      }
    }

    internal fun onSync() {
      Handler(Looper.getMainLooper()).post {
        active?.get()?.let { if (it.observingSync) it.emit("onSync", emptyMap()) }
      }
    }

    private fun configured(): Boolean =
      BuildConfig.FIREBASE_API_KEY.isNotEmpty() &&
        BuildConfig.FIREBASE_APPLICATION_ID.isNotEmpty() &&
        BuildConfig.FIREBASE_PROJECT_ID.isNotEmpty() &&
        BuildConfig.FIREBASE_GCM_SENDER_ID.isNotEmpty()

    @Synchronized
    internal fun initializeFirebase(context: Context): Boolean {
      if (!configured()) return false
      return try {
        if (FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }) {
          FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
            .setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setApplicationId(BuildConfig.FIREBASE_APPLICATION_ID)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
            .setGcmSenderId(BuildConfig.FIREBASE_GCM_SENDER_ID)
            .build())
        }
        true
      } catch (e: Exception) {
        false
      }
    }

    internal fun onToken(token: String) {
      if (configured()) active?.get()?.emit("onToken", mapOf("token" to token))
    }
  }
}
