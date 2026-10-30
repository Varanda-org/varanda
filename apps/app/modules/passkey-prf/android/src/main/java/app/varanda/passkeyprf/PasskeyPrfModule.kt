package app.varanda.passkeyprf

import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.domerrors.SecurityError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

// WebAuthn through Android's Credential Manager: the request and the response
// are the WebAuthn JSON the platform takes and returns, so the PRF extension
// (extensions.prf.eval.first) passes through to the Google Password Manager
// and its output comes back in clientExtensionResults.prf. Native error text
// never reaches JS: only the codes CANCELLED, EXISTS, UNSUPPORTED, WEBAUTHN.
class PasskeyPrfModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

  override fun definition() = ModuleDefinition {
    Name("PasskeyPrf")

    // minSdk is 31; Credential Manager runs there through Play services.
    Function("isAvailable") {
      true
    }

    AsyncFunction("create") { requestJson: String, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("WEBAUTHN", "no activity", null)
        return@AsyncFunction
      }
      scope.launch {
        try {
          val manager = CredentialManager.create(activity)
          val result = manager.createCredential(activity, CreatePublicKeyCredentialRequest(requestJson))
          if (result is CreatePublicKeyCredentialResponse) {
            promise.resolve(result.registrationResponseJson)
          } else {
            promise.reject("WEBAUTHN", "unexpected response", null)
          }
        } catch (e: CreateCredentialException) {
          promise.reject(createCode(e), "create failed", null)
        } catch (e: Exception) {
          promise.reject("WEBAUTHN", "create failed", null)
        }
      }
    }

    AsyncFunction("get") { requestJson: String, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("WEBAUTHN", "no activity", null)
        return@AsyncFunction
      }
      scope.launch {
        try {
          val manager = CredentialManager.create(activity)
          val request = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson)))
          val credential = manager.getCredential(activity, request).credential
          if (credential is PublicKeyCredential) {
            promise.resolve(credential.authenticationResponseJson)
          } else {
            promise.reject("WEBAUTHN", "unexpected credential", null)
          }
        } catch (e: GetCredentialException) {
          promise.reject(getCode(e), "get failed", null)
        } catch (e: Exception) {
          promise.reject("WEBAUTHN", "get failed", null)
        }
      }
    }

    OnDestroy {
      scope.cancel()
    }
  }

  private fun createCode(e: CreateCredentialException): String = when (e) {
    is CreateCredentialCancellationException -> "CANCELLED"
    is CreateCredentialNoCreateOptionException -> "UNSUPPORTED"
    is CreateCredentialUnsupportedException -> "UNSUPPORTED"
    is CreatePublicKeyCredentialDomException -> when (e.domError) {
      is InvalidStateError -> "EXISTS"
      is NotAllowedError -> "CANCELLED"
      // The app is not tied to the rp.id (assetlinks.json): no passkey here.
      is SecurityError -> "UNSUPPORTED"
      else -> "WEBAUTHN"
    }
    else -> "WEBAUTHN"
  }

  private fun getCode(e: GetCredentialException): String = when (e) {
    is GetCredentialCancellationException -> "CANCELLED"
    // No Varanda passkey for this rp.id: like a browser whose sheet the person
    // closes, the ceremony simply did not happen.
    is NoCredentialException -> "CANCELLED"
    is GetCredentialUnsupportedException -> "UNSUPPORTED"
    is GetPublicKeyCredentialDomException -> when (e.domError) {
      is NotAllowedError -> "CANCELLED"
      is SecurityError -> "UNSUPPORTED"
      else -> "WEBAUTHN"
    }
    else -> "WEBAUTHN"
  }
}
