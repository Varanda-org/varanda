package app.varanda.faceliveness

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import com.amplifyframework.auth.AWSCredentials
import com.amplifyframework.auth.AWSCredentialsProvider
import com.amplifyframework.auth.AuthException
import com.amplifyframework.core.Action
import com.amplifyframework.core.Consumer
import com.amplifyframework.ui.liveness.model.FaceLivenessDetectionException
import com.amplifyframework.ui.liveness.ui.FaceLivenessDetector

// Hosts the official AWS Face Liveness screen. The result carries only one of
// the codes below, never SDK text: the JS side shows its own message.
class FaceLivenessActivity : ComponentActivity() {
  companion object {
    const val EXTRA_CODE = "code"
    const val CANCELLED = "CANCELLED"
    const val CAMERA_DENIED = "CAMERA_DENIED"
    const val SESSION_EXPIRED = "SESSION_EXPIRED"
    const val UNSUPPORTED = "UNSUPPORTED"
    const val FAILED = "FAILED"
    val CODES = setOf(CANCELLED, CAMERA_DENIED, SESSION_EXPIRED, UNSUPPORTED, FAILED)
  }

  private var input: CaptureInput? = null
  private var done = false

  private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    if (granted) showCapture() else finishWith(CAMERA_DENIED)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // After a process death or a recreation the input is gone on purpose.
    val taken = try {
      CaptureInput.take()
    } finally {
      CaptureInput.clear()
    }
    if (taken == null) {
      finishWith(FAILED)
      return
    }
    input = taken
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        finishWith(CANCELLED)
      }
    })
    // A cancel() that came before onCreate runs the listener inline here.
    CaptureInput.onCancel { runOnUiThread { finishWith(CANCELLED) } }
    if (done) return
    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      showCapture()
    } else {
      cameraPermission.launch(Manifest.permission.CAMERA)
    }
  }

  override fun onDestroy() {
    CaptureInput.onCancel(null)
    input = null
    super.onDestroy()
  }

  private fun showCapture() {
    val capture = input ?: return finishWith(FAILED)
    if (done) return
    val credentials = AWSCredentials.createAWSCredentials(
      capture.accessKeyId,
      capture.secretAccessKey,
      capture.sessionToken,
      capture.expiration / 1000
    ) ?: return finishWith(FAILED)
    setContent {
      FaceLivenessDetector(
        sessionId = capture.sessionId,
        region = capture.region,
        credentialsProvider = StaticCredentialsProvider(credentials),
        disableStartView = false,
        // The SDK may call these off the main thread; `done` is main only.
        onComplete = Action { runOnUiThread { finishWith(null) } },
        onError = Consumer { error ->
          val code = codeFor(error)
          runOnUiThread { finishWith(code) }
        }
      )
    }
  }

  private fun codeFor(error: FaceLivenessDetectionException): String = when (error) {
    is FaceLivenessDetectionException.SessionNotFoundException,
    is FaceLivenessDetectionException.SessionTimedOutException -> SESSION_EXPIRED
    is FaceLivenessDetectionException.CameraPermissionDeniedException -> CAMERA_DENIED
    is FaceLivenessDetectionException.UnsupportedChallengeTypeException -> UNSUPPORTED
    is FaceLivenessDetectionException.UserCancelledException -> CANCELLED
    else -> FAILED
  }

  // A null code is success. Main thread only. Idempotent: the SDK callbacks,
  // back and cancel() can race.
  private fun finishWith(code: String?) {
    if (done) return
    done = true
    input = null
    if (code == null) {
      setResult(Activity.RESULT_OK)
    } else {
      setResult(Activity.RESULT_CANCELED, Intent().putExtra(EXTRA_CODE, code))
    }
    finish()
  }
}

// The guest credentials the app got from Cognito itself: no Amplify Auth and
// no Amplify.configure. The SDK only asks this provider for them.
private class StaticCredentialsProvider(
  private val credentials: AWSCredentials
) : AWSCredentialsProvider<AWSCredentials> {
  override fun fetchAWSCredentials(
    onSuccess: Consumer<AWSCredentials>,
    onError: Consumer<AuthException>
  ) {
    onSuccess.accept(credentials)
  }
}
