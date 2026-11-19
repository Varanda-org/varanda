import ExpoModulesCore
import UIKit
import UserNotifications

public class PushDeviceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PushDevice")
    Events("onToken", "onIntent")

    OnCreate { [weak self] in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        PushDeviceState.shared.attach(self)
      }
    }

    OnDestroy { [weak self] in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        PushDeviceState.shared.detach(self)
      }
    }

    OnStartObserving("onIntent") { [weak self] in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        PushDeviceState.shared.startObserving(self)
      }
    }

    OnStopObserving("onIntent") { [weak self] in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        PushDeviceState.shared.stopObserving(self)
      }
    }

    Function("configured") { true }

    AsyncFunction("permission") { (promise: Promise) in
      PushDeviceState.permission(promise)
    }

    AsyncFunction("request") { (promise: Promise) in
      let center = UNUserNotificationCenter.current()
      center.getNotificationSettings { settings in
        guard settings.authorizationStatus == .notDetermined else {
          promise.resolve(PushDeviceState.permissionName(settings.authorizationStatus))
          return
        }
        center.requestAuthorization(options: [.alert, .sound]) { _, error in
          guard error == nil else {
            promise.resolve("undetermined")
            return
          }
          PushDeviceState.permission(promise)
        }
      }
    }

    AsyncFunction("token") { (promise: Promise) in
      PushDeviceState.shared.token(promise)
    }.runOnQueue(.main)

    AsyncFunction("launchIntent") { () -> String? in
      return PushDeviceState.shared.launchIntent()
    }.runOnQueue(.main)
  }
}

// Delegate callbacks and module calls share the main queue so a timeout,
// registration and intent consumption cannot settle the same request twice.
final class PushDeviceState {
  static let shared = PushDeviceState()
  private weak var module: PushDeviceModule?
  private var currentToken: String?
  private var pendingIntent: String?
  private var observingIntents = false
  private var registering = false
  private var waiters: [UUID: Promise] = [:]

  private init() {}

  func attach(_ module: PushDeviceModule) {
    self.module = module
    observingIntents = false
  }

  func detach(_ module: PushDeviceModule) {
    stopObserving(module)
    if self.module === module { self.module = nil }
  }

  func startObserving(_ module: PushDeviceModule) {
    guard self.module === module else { return }
    observingIntents = true
    if let kind = launchIntent() { module.sendEvent("onIntent", ["kind": kind]) }
  }

  func stopObserving(_ module: PushDeviceModule) {
    if self.module === module { observingIntents = false }
  }

  static func permissionName(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .authorized, .provisional, .ephemeral: return "granted"
    case .denied: return "denied"
    default: return "undetermined"
    }
  }

  static func permission(_ promise: Promise) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      promise.resolve(permissionName(settings.authorizationStatus))
    }
  }

  func token(_ promise: Promise) {
    let id = UUID()
    waiters[id] = promise
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
      self.finish(id, nil)
    }
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      DispatchQueue.main.async {
        guard self.waiters[id] != nil else { return }
        guard Self.permissionName(settings.authorizationStatus) == "granted" else {
          self.finish(id, nil)
          return
        }
        if let token = self.currentToken, UIApplication.shared.isRegisteredForRemoteNotifications {
          self.finish(id, token)
          return
        }
        if !self.registering {
          self.registering = true
          UIApplication.shared.registerForRemoteNotifications()
        }
      }
    }
  }

  func registered(_ token: String) {
    let changed = currentToken != token
    currentToken = token
    settle(token)
    if changed { module?.sendEvent("onToken", ["token": token]) }
  }

  func registrationFailed() {
    currentToken = nil
    settle(nil)
  }

  private func finish(_ id: UUID, _ token: String?) {
    let promise = waiters.removeValue(forKey: id)
    if waiters.isEmpty { registering = false }
    promise?.resolve(token)
  }

  private func settle(_ token: String?) {
    let pending = Array(waiters.values)
    waiters.removeAll()
    registering = false
    for promise in pending { promise.resolve(token) }
  }

  func receive(_ value: Any?) {
    guard let kind = value as? String,
          ["dm", "dm-page", "group", "group-private"].contains(kind) else { return }
    if observingIntents, let module = module {
      module.sendEvent("onIntent", ["kind": kind])
    } else {
      pendingIntent = kind
    }
  }

  func launchIntent() -> String? {
    defer { pendingIntent = nil }
    return pendingIntent
  }
}
