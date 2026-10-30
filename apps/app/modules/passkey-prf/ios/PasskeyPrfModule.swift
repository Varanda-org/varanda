import AuthenticationServices
import CryptoKit
import ExpoModulesCore
import UIKit

// WebAuthn through AuthenticationServices with the PRF extension (iOS 18 and
// later). Takes the WebAuthn JSON that src/passkeyOptions.js builds and
// answers the registration or assertion response JSON (base64url fields,
// clientExtensionResults.prf), so JS reads both platforms alike. Below iOS 18
// there is no PRF API: isAvailable is false and every ceremony is
// UNSUPPORTED. Without the associated domain (webcredentials:<host>, see
// ios/Varanda/Varanda.entitlements) the system refuses the rp.id: UNSUPPORTED
// too. Native error text never reaches JS.
public class PasskeyPrfModule: Module {
  private var ceremony: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("PasskeyPrf")

    Function("isAvailable") { () -> Bool in
      if #available(iOS 18.0, *) {
        return true
      }
      return false
    }

    AsyncFunction("create") { (requestJson: String, promise: Promise) in
      guard #available(iOS 18.0, *) else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
      self.run(promise) { try PasskeyRequests.registration(requestJson) }
    }.runOnQueue(.main)

    AsyncFunction("get") { (requestJson: String, promise: Promise) in
      guard #available(iOS 18.0, *) else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
      self.run(promise) { try PasskeyRequests.assertion(requestJson) }
    }.runOnQueue(.main)
  }

  @available(iOS 18.0, *)
  private func run(_ promise: Promise, build: () throws -> ASAuthorizationRequest) {
    if ceremony != nil {
      promise.reject("WEBAUTHN", "busy")
      return
    }
    let request: ASAuthorizationRequest
    do {
      request = try build()
    } catch {
      promise.reject("WEBAUTHN", "bad request")
      return
    }
    let delegate = PasskeyCeremony(promise: promise) { [weak self] in
      self?.ceremony = nil
    }
    ceremony = delegate
    delegate.start(request)
  }
}

enum PasskeyRequestError: Error {
  case invalid
}

@available(iOS 18.0, *)
enum PasskeyRequests {
  static func object(_ json: String) throws -> [String: Any] {
    guard let data = json.data(using: .utf8),
          let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw PasskeyRequestError.invalid
    }
    return value
  }

  static func prfInput(_ options: [String: Any]) throws -> Data {
    guard let ext = options["extensions"] as? [String: Any],
          let prf = ext["prf"] as? [String: Any],
          let eval = prf["eval"] as? [String: Any],
          let first = eval["first"] as? String,
          let input = Base64Url.decode(first) else {
      throw PasskeyRequestError.invalid
    }
    return input
  }

  static func registration(_ json: String) throws -> ASAuthorizationRequest {
    let options = try object(json)
    guard let rp = options["rp"] as? [String: Any],
          let rpId = rp["id"] as? String,
          let user = options["user"] as? [String: Any],
          let userIdText = user["id"] as? String,
          let userId = Base64Url.decode(userIdText),
          let name = user["name"] as? String,
          let challengeText = options["challenge"] as? String,
          let challenge = Base64Url.decode(challengeText) else {
      throw PasskeyRequestError.invalid
    }
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
    let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: name, userID: userId)
    request.displayName = user["displayName"] as? String ?? name
    request.userVerificationPreference = .required
    request.attestationPreference = .none
    let input = try prfInput(options)
    request.prf = .inputValues(ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: input))
    return request
  }

  static func assertion(_ json: String) throws -> ASAuthorizationRequest {
    let options = try object(json)
    guard let rpId = options["rpId"] as? String,
          let challengeText = options["challenge"] as? String,
          let challenge = Base64Url.decode(challengeText) else {
      throw PasskeyRequestError.invalid
    }
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
    let request = provider.createCredentialAssertionRequest(challenge: challenge)
    request.userVerificationPreference = .required
    if let allow = options["allowCredentials"] as? [[String: Any]] {
      request.allowedCredentials = allow.compactMap { item in
        guard let id = item["id"] as? String, let raw = Base64Url.decode(id) else { return nil }
        return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: raw)
      }
    }
    let input = try prfInput(options)
    request.prf = .inputValues(ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: input))
    return request
  }
}

@available(iOS 18.0, *)
final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  private let promise: Promise
  private let done: () -> Void
  private var controller: ASAuthorizationController?

  init(promise: Promise, done: @escaping () -> Void) {
    self.promise = promise
    self.done = done
  }

  func start(_ request: ASAuthorizationRequest) {
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self
    self.controller = controller
    controller.performRequests()
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    return windows.first(where: { $0.isKeyWindow }) ?? windows.first ?? ASPresentationAnchor()
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    defer { finish() }
    if let reg = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
      var prf: [String: Any] = ["enabled": reg.prf?.isSupported ?? false]
      if let first = reg.prf?.first {
        prf["results"] = ["first": Base64Url.encode(first.withUnsafeBytes { Data($0) })]
      }
      let id = Base64Url.encode(reg.credentialID)
      var response: [String: Any] = ["clientDataJSON": Base64Url.encode(reg.rawClientDataJSON)]
      if let attestation = reg.rawAttestationObject {
        response["attestationObject"] = Base64Url.encode(attestation)
      }
      resolve([
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": "platform",
        "response": response,
        "clientExtensionResults": ["prf": prf]
      ])
      return
    }
    if let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
      var ext: [String: Any] = [:]
      if let output = assertion.prf {
        ext["prf"] = ["results": ["first": Base64Url.encode(output.first.withUnsafeBytes { Data($0) })]]
      }
      let id = Base64Url.encode(assertion.credentialID)
      var response: [String: Any] = [
        "clientDataJSON": Base64Url.encode(assertion.rawClientDataJSON),
        "authenticatorData": Base64Url.encode(assertion.rawAuthenticatorData),
        "signature": Base64Url.encode(assertion.signature)
      ]
      if let userId = assertion.userID, !userId.isEmpty {
        response["userHandle"] = Base64Url.encode(userId)
      }
      resolve([
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": "platform",
        "response": response,
        "clientExtensionResults": ext
      ])
      return
    }
    promise.reject("WEBAUTHN", "unexpected credential")
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    defer { finish() }
    promise.reject(PasskeyCeremony.code(error), "ceremony failed")
  }

  private func resolve(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let text = String(data: data, encoding: .utf8) else {
      promise.reject("WEBAUTHN", "bad response")
      return
    }
    promise.resolve(text)
  }

  private func finish() {
    controller = nil
    done()
  }

  static func code(_ error: Error) -> String {
    let ns = error as NSError
    if ns.domain == ASAuthorizationError.errorDomain {
      switch ASAuthorizationError.Code(rawValue: ns.code) {
      case .canceled:
        return "CANCELLED"
      case .matchedExcludedCredential:
        return "EXISTS"
      case .failed:
        // The usual failure without the webcredentials associated domain:
        // the app may not speak for this rp.id.
        let text = (ns.userInfo[NSLocalizedFailureReasonErrorKey] as? String ?? "") + " " + ns.localizedDescription
        return text.lowercased().contains("associated") ? "UNSUPPORTED" : "WEBAUTHN"
      default:
        return "WEBAUTHN"
      }
    }
    return "WEBAUTHN"
  }
}

enum Base64Url {
  static func encode(_ data: Data) -> String {
    return data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ text: String) -> Data? {
    var b64 = text
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
      .replacingOccurrences(of: "=", with: "")
    while b64.count % 4 != 0 {
      b64 += "="
    }
    return Data(base64Encoded: b64)
  }
}
