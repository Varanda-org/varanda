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
    // In-app dots already cover foreground messages; only the system shows notices.
  }
}
