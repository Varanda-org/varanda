package app.varanda.shareintake

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

// Run by WorkManager an hour after a capture (ShareInbox.scheduleSweep), with
// or without the app open: a share nobody took leaves the app's files.
class ShareSweepWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    ShareInbox.sweep(applicationContext, ShareInbox.TTL_MS.toDouble())
    return Result.success()
  }
}
