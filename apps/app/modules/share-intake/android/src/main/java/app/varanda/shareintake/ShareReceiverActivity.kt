package app.varanda.shareintake

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast

// The share sheet target. It copies what was shared into ShareInbox and then
// opens Varanda through its plain launcher intent: MainActivity never gets the
// sender's intent, its Uris or its text, and its App Links stay untouched.
class ShareReceiverActivity : Activity() {
  private val guard = ShareInbox.Guard()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val shared = intent
    val action = shared?.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) {
      finish()
      return
    }
    val app = applicationContext
    val main = Handler(Looper.getMainLooper())
    // A daemon thread: a sender that never answers must not keep the process
    // alive, and onDestroy stops the copy through the guard, not by waiting.
    val worker = Thread({
      val id = try {
        ShareInbox.capture(app, shared, guard)
      } catch (e: Throwable) {
        null
      }
      main.post { done(id) }
    }, "varanda-share-capture")
    worker.isDaemon = true
    worker.start()
  }

  private fun done(id: String?) {
    val app = applicationContext
    // The person left. A cancelled capture stored nothing; a share stored in
    // full stays for the app's next peek (on mount and on resume), and the
    // hour-long sweep clears it if no one takes it. Nothing opens and no Toast
    // shows over whatever the person went to.
    if (guard.cancelled || isDestroyed || isFinishing) return
    if (id == null) {
      Toast.makeText(app, "Não deu para receber esse conteúdo.", Toast.LENGTH_SHORT).show()
      finish()
      return
    }
    try {
      ShareInbox.listener?.invoke()
    } catch (e: Exception) {
      // The composer still finds the share on its next peek.
    }
    try {
      val launch = packageManager.getLaunchIntentForPackage(packageName)
      if (launch != null) {
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(launch)
      }
    } catch (e: Exception) {
      // Opening Varanda by hand still finds the share.
    }
    finish()
  }

  // Closes the descriptor being read, so a copy blocked on the sender stops
  // now instead of at its next read.
  override fun onDestroy() {
    guard.cancel()
    super.onDestroy()
  }
}
