import AVFoundation
import ExpoModulesCore
import FaceLiveness
import SwiftUI
import UIKit

// The AWS Face Liveness capture with the official amplify-ui-swift-liveness
// view, presented full screen over the app. index.js validates the input and
// keeps the error text generic; this side only answers with a bare code from
// index.js CODES, so no SDK message, session id or credential ever reaches JS.
// The credentials stay in memory for one capture and are dropped when it ends.
public class FaceLivenessModule: Module {
  private var capture: LivenessCapture?

  public func definition() -> ModuleDefinition {
    Name("FaceLiveness")

    // The simulator has no front camera, so it answers false there.
    Function("isAvailable") { () -> Bool in
      return FaceLivenessModule.frontCamera()
    }

    AsyncFunction("start") { (input: [String: Any], promise: Promise) in
      if self.capture != nil {
        promise.reject("BUSY", "busy")
        return
      }
      guard let request = LivenessRequest(input) else {
        promise.reject("FAILED", "invalid input")
        return
      }
      guard FaceLivenessModule.frontCamera() else {
        promise.reject("UNSUPPORTED", "no front camera")
        return
      }
      if request.credentials.expiration <= Date() {
        promise.reject("SESSION_EXPIRED", "expired")
        return
      }
      let capture = LivenessCapture(request: request, promise: promise) { [weak self] in
        self?.capture = nil
      }
      self.capture = capture
      capture.begin()
    }.runOnQueue(.main)

    // The capture screen outlives the React screen that opened it: when that
    // screen goes away, the capture closes and start() answers CANCELLED.
    // Only async functions take a queue, so this hops to main itself; start
    // runs there too, so `capture` is only ever touched on main.
    Function("cancel") {
      DispatchQueue.main.async { [weak self] in
        self?.capture?.cancel()
      }
    }
  }

  static func frontCamera() -> Bool {
    return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) != nil
  }
}

struct LivenessRequest {
  let sessionId: String
  let region: String
  var credentials: StaticCredentials

  init?(_ input: [String: Any]) {
    guard let sessionId = input["sessionId"] as? String, !sessionId.isEmpty,
          let region = input["region"] as? String, !region.isEmpty,
          let creds = input["credentials"] as? [String: Any],
          let accessKeyId = creds["accessKeyId"] as? String, !accessKeyId.isEmpty,
          let secretAccessKey = creds["secretAccessKey"] as? String, !secretAccessKey.isEmpty,
          let sessionToken = creds["sessionToken"] as? String, !sessionToken.isEmpty,
          let expiration = (creds["expiration"] as? NSNumber)?.doubleValue,
          expiration.isFinite else {
      return nil
    }
    self.sessionId = sessionId
    self.region = region
    self.credentials = StaticCredentials(
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
      sessionToken: sessionToken,
      expiration: Date(timeIntervalSince1970: expiration / 1000)
    )
  }
}

final class LivenessCapture {
  private var request: LivenessRequest?
  private let promise: Promise
  private let done: () -> Void
  private var controller: UIViewController?
  private var watchdog: DispatchWorkItem?
  private var settled = false

  // The SDK never answers when the stream fails before it opens: it stays on
  // its loading view. A liveness session lasts three minutes on the service,
  // so four minutes after presentation no capture can still succeed, and only
  // one stuck like that is still open.
  static let watchdogSeconds: TimeInterval = 240

  init(request: LivenessRequest, promise: Promise, done: @escaping () -> Void) {
    self.request = request
    self.promise = promise
    self.done = done
  }

  func begin() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      present()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          if granted {
            self.present()
          } else {
            self.finish("CAMERA_DENIED")
          }
        }
      }
    default:
      finish("CAMERA_DENIED")
    }
  }

  private func present() {
    guard let request = request, let host = LivenessCapture.topController() else {
      finish("FAILED")
      return
    }
    let view = LivenessScreen(
      sessionId: request.sessionId,
      region: request.region,
      provider: StaticCredentialsProvider(credentials: request.credentials),
      onClose: { [weak self] in
        self?.finish("CANCELLED")
      }
    ) { [weak self] result in
      DispatchQueue.main.async {
        self?.complete(result)
      }
    }
    let controller = PortraitHostingController(rootView: view)
    controller.modalPresentationStyle = .fullScreen
    controller.isModalInPresentation = true
    self.controller = controller
    // The SDK holds its own copy for the stream; this one is not needed again.
    self.request = nil
    let watchdog = DispatchWorkItem { [weak self] in
      self?.finish("FAILED")
    }
    self.watchdog = watchdog
    DispatchQueue.main.asyncAfter(deadline: .now() + LivenessCapture.watchdogSeconds, execute: watchdog)
    host.present(controller, animated: true)
  }

  // A camera prompt still open settles here too: its answer then finds no
  // request left and finish() is already done, so nothing is presented.
  func cancel() {
    finish("CANCELLED")
  }

  private func complete(_ result: Result<Void, FaceLivenessDetectionError>) {
    switch result {
    case .success:
      finish(nil)
    case .failure(let error):
      finish(LivenessCapture.code(error))
    }
  }

  // Settles once: the SDK can report the end of a capture from more than one
  // path, and a promise must not be answered twice.
  private func finish(_ code: String?) {
    if settled { return }
    settled = true
    request = nil
    watchdog?.cancel()
    watchdog = nil
    let answer = { [promise, done] in
      if let code = code {
        promise.reject(code, "liveness failed")
      } else {
        promise.resolve(nil)
      }
      done()
    }
    if let controller = controller, let host = controller.presentingViewController {
      self.controller = nil
      host.dismiss(animated: true, completion: answer)
    } else {
      controller = nil
      answer()
    }
  }

  static func code(_ error: FaceLivenessDetectionError) -> String {
    switch error {
    case .userCancelled:
      return "CANCELLED"
    // The SDK also reports unknown and camera pipeline errors as a denied
    // permission, so only a camera that is really not allowed counts as one.
    case .cameraPermissionDenied:
      return AVCaptureDevice.authorizationStatus(for: .video) == .authorized ? "FAILED" : "CAMERA_DENIED"
    case .cameraNotAvailable:
      return "UNSUPPORTED"
    // The same rule as the web detector: a valid session id that the stream
    // rejects ran out or was already used, so the service has to start again.
    // The SDK reports every timeout, the session's included, as the face
    // oval one; a timed out session also needs a new one, as on Android.
    case .sessionNotFound, .validation, .sessionTimedOut, .faceInOvalMatchExceededTimeLimitError:
      return "SESSION_EXPIRED"
    default:
      return "FAILED"
    }
  }

  static func topController() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    var top = (windows.first(where: { $0.isKeyWindow }) ?? windows.first)?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

struct LivenessScreen: View {
  let sessionId: String
  let region: String
  let provider: StaticCredentialsProvider
  let onClose: () -> Void
  let onCompletion: (Result<Void, FaceLivenessDetectionError>) -> Void
  @State private var isPresented = true
  // A count, not a flag: the check and the rotate prompt can both hold one.
  @State private var sdkCloseShown = 0
  private let theme = FaceLivenessDetectorTheme()

  // The SDK offers its own close only during the check and the rotate prompt.
  // The loading, camera and get ready views have none, and a stream that never
  // opens leaves the loading view up for good, so this close covers them. It
  // hides while the SDK's own is on screen, so there is one close and the SDK
  // still ends its session itself when that one is used.
  var body: some View {
    FaceLivenessDetectorView(
      sessionID: sessionId,
      credentialsProvider: provider,
      region: region,
      isPresented: $isPresented,
      onCompletion: onCompletion
    )
    .cancelButton { configuration in
      CloseCircle(theme: theme, label: configuration.accessibilityLabel) {
        configuration.cancel()
      }
      .onAppear { sdkCloseShown += 1 }
      .onDisappear { sdkCloseShown -= 1 }
    }
    .faceLivenessDetectorTheme(theme)
    // Top leading: the SDK's controls are the close at top trailing, the info
    // button at the right of the get ready warning and the begin button at the
    // bottom.
    .overlay(alignment: .topLeading) {
      if sdkCloseShown <= 0 {
        CloseCircle(theme: theme, label: "Fechar", action: onClose)
          .padding(16)
      }
    }
  }
}

// The same look as the SDK's close, which it does not export.
struct CloseCircle: View {
  let theme: FaceLivenessDetectorTheme
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: "xmark")
        .font(.system(size: 18, weight: .bold))
        .foregroundColor(theme.colors.onBackground)
        .frame(width: 44, height: 44)
        .background(theme.colors.background)
        .clipShape(Circle())
    }
    .accessibilityLabel(Text(label))
  }
}

// The capture is portrait only: the SDK pauses a landscape check behind its
// rotate prompt, and the app must not offer the rotation in the first place.
final class PortraitHostingController<Content: View>: UIHostingController<Content> {
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    return .portrait
  }

  override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
    return .portrait
  }
}
