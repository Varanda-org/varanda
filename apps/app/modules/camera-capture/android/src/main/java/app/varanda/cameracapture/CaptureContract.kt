package app.varanda.cameracapture

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import java.io.Serializable

internal const val GRANT_FLAGS = Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION

data class CaptureInput(
  val kind: String,
  val path: String,
  val uri: String,
  val maxSec: Int?
) : Serializable

data class CaptureOutput(
  val resultCode: Int,
  val data: Uri?
)

internal fun actionFor(kind: String): String =
  if (kind == "video") MediaStore.ACTION_VIDEO_CAPTURE else MediaStore.ACTION_IMAGE_CAPTURE

// The camera app gets a write grant on one empty file of ours through the
// FileProvider (ClipData carries the grant to whichever app handles the
// intent), never a path or a public MediaStore entry.
class CaptureContract : AppContextActivityResultContract<CaptureInput, CaptureOutput> {
  override fun createIntent(context: Context, input: CaptureInput): Intent {
    val uri = Uri.parse(input.uri)
    val intent = Intent(actionFor(input.kind))
    intent.putExtra(MediaStore.EXTRA_OUTPUT, uri)
    intent.clipData = ClipData.newRawUri("", uri)
    intent.addFlags(GRANT_FLAGS)
    if (input.kind == "video") {
      input.maxSec?.let { intent.putExtra(MediaStore.EXTRA_DURATION_LIMIT, it) }
      intent.putExtra(MediaStore.EXTRA_VIDEO_QUALITY, 1)
    }
    return intent
  }

  override fun parseResult(input: CaptureInput, resultCode: Int, intent: Intent?): CaptureOutput =
    CaptureOutput(resultCode, intent?.data)
}
