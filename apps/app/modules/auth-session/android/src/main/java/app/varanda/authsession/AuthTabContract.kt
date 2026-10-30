package app.varanda.authsession

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.auth.AuthTabIntent
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import java.io.Serializable

data class AuthTabInput(
  val url: String,
  val host: String,
  val path: String,
  val browser: String
) : Serializable

data class AuthTabOutput(
  val resultCode: Int,
  val uri: Uri?
)

// AuthTabIntent.launch needs an androidx ActivityResultLauncher, which an Expo
// module does not have, so this builds the very intent launch() would send
// (AuthTabIntent.Builder().build().intent plus the url and the https redirect
// extras) and parses the result like AuthenticateUserResultContract does.
class AuthTabContract : AppContextActivityResultContract<AuthTabInput, AuthTabOutput> {
  override fun createIntent(context: Context, input: AuthTabInput): Intent {
    val intent = AuthTabIntent.Builder().build().intent
    intent.setData(Uri.parse(input.url))
    intent.putExtra(AuthTabIntent.EXTRA_HTTPS_REDIRECT_HOST, input.host)
    intent.putExtra(AuthTabIntent.EXTRA_HTTPS_REDIRECT_PATH, input.path)
    // Only the browser that said it supports Auth Tab: another one would load
    // the redirect as a page instead of handing it back.
    intent.setPackage(input.browser)
    return intent
  }

  override fun parseResult(input: AuthTabInput, resultCode: Int, intent: Intent?): AuthTabOutput {
    val uri = if (resultCode == Activity.RESULT_OK) intent?.data else null
    return AuthTabOutput(resultCode, uri)
  }
}
