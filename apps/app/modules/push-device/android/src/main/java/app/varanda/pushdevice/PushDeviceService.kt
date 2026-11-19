package app.varanda.pushdevice

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class PushDeviceService : FirebaseMessagingService() {
  override fun onCreate() {
    super.onCreate()
    // A background delivery may start the process before the Expo module exists.
    PushDeviceModule.initializeFirebase(applicationContext)
  }

  override fun onNewToken(token: String) {
    PushDeviceModule.onToken(token)
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    if (data["k"] != "seen-sync") return
    val tags = data["c"]?.split(',') ?: return
    if (!PushDeviceModule.validTags(tags)) return
    val raw = data["a"] ?: return
    if (!raw.matches(Regex("[0-9]{1,16}"))) return
    val asOf = raw.toLongOrNull() ?: return
    if (asOf !in 0..9_007_199_254_740_991L) return
    PushDeviceModule.clearDelivered(applicationContext, tags, asOf)
    PushDeviceModule.onSync()
  }
}
