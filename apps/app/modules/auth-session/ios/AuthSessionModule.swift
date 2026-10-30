import AuthenticationServices
import ExpoModulesCore
import UIKit

// The Google step of the account link in an ASWebAuthenticationSession with an
// https callback (iOS 17.4 and later): the system hands the redirect back to
// this app only, and only for a host tied to it by the webcredentials
// associated domain (ios/Varanda/Varanda.entitlements). Gated like
// passkey-prf: Info.plist VarandaWebCredentials is false until the entitlement
// is added, and while it is false the module reports itself unavailable.
// Native error text never reaches JS, and URLs are never logged (they carry
// the OAuth state and the redeem code).
public class AuthSessionModule: Module {
  private var running: AnyObject?

  private static var webCredentials: Bool {
    return Bundle.main.object(forInfoDictionaryKey: "VarandaWebCredentials") as? Bool == true
  }

  public func definition() -> ModuleDefinition {
    Name("AuthSession")

    Function("isAvailable") { () -> Bool in
      if #available(iOS 17.4, *) {
        return AuthSessionModule.webCredentials
      }
      return false
    }

    AsyncFunction("open") { (url: String, host: String, path: String, promise: Promise) in
      guard AuthSessionModule.validArgs(url, host, path), let target = URL(string: url) else {
        promise.reject("INVALID", "invalid")
        return
      }
      guard #available(iOS 17.4, *), AuthSessionModule.webCredentials else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
      if self.running != nil {
        promise.reject("BUSY", "busy")
        return
      }
      let run = AuthSessionRun(promise: promise, host: host, path: path) { [weak self] in
        self?.running = nil
      }
      self.running = run
      run.start(target)
    }.runOnQueue(.main)
  }

  static func validArgs(_ url: String, _ host: String, _ path: String) -> Bool {
    return url.hasPrefix("https://") && url.count > 8 &&
      !host.isEmpty && !host.contains(where: { $0 == "/" || $0 == ":" || $0.isWhitespace }) &&
      path.hasPrefix("/") && !path.contains(where: { $0 == "?" || $0 == "#" || $0.isWhitespace })
  }
}

@available(iOS 17.4, *)
final class AuthSessionRun: NSObject, ASWebAuthenticationPresentationContextProviding {
  private let promise: Promise
  private let host: String
  private let path: String
  private let done: () -> Void
  private var session: ASWebAuthenticationSession?
  private var finished = false

  init(promise: Promise, host: String, path: String, done: @escaping () -> Void) {
    self.promise = promise
    self.host = host
    self.path = path
    self.done = done
  }

  func start(_ url: URL) {
    let session = ASWebAuthenticationSession(url: url, callback: .https(host: host, path: path)) { [self] callbackURL, error in
      DispatchQueue.main.async {
        self.finish(self.answer(callbackURL, error))
      }
    }
    session.presentationContextProvider = self
    // Keep the browser's cookies: the person stays signed in to Google.
    session.prefersEphemeralWebBrowserSession = false
    self.session = session
    if !session.start() {
      finish(["type": "failed", "reason": "unknown"])
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    return windows.first(where: { $0.isKeyWindow }) ?? windows.first ?? ASPresentationAnchor()
  }

  private func answer(_ callbackURL: URL?, _ error: Error?) -> [String: Any] {
    if let error = error {
      if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
        return ["type": "cancel"]
      }
      return ["type": "failed", "reason": "unknown"]
    }
    // Defense in depth: the system already matched host and path.
    guard let callbackURL = callbackURL,
          callbackURL.scheme == "https",
          callbackURL.host?.lowercased() == host.lowercased(),
          callbackURL.port == nil,
          callbackURL.user == nil,
          callbackURL.path == path else {
      return ["type": "failed", "reason": "unknown"]
    }
    return ["type": "ok", "url": callbackURL.absoluteString]
  }

  private func finish(_ result: [String: Any]) {
    if finished { return }
    finished = true
    session = nil
    promise.resolve(result)
    done()
  }
}
