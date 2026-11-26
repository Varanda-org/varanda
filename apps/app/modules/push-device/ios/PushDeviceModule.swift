import ExpoModulesCore
import CoreFoundation
import UIKit
import UserNotifications

public class PushDeviceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PushDevice")
    Events("onToken", "onIntent", "onSync")

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

    OnStartObserving("onSync") { [weak self] in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        PushDeviceState.shared.observeSync(self, true)
      }
    }

    OnStopObserving("onSync") { [weak self] in
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        PushDeviceState.shared.observeSync(self, false)
      }
    }

    AsyncFunction("clearDelivered") { (tags: [String], promise: Promise) in
      guard let tags = PushDeviceState.validTags(tags) else {
        promise.resolve(nil)
        return
      }
      PushDeviceState.clearDelivered(tags) { promise.resolve(nil) }
    }

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
  private var observingSync = false
  private var registering = false
  private var waiters: [UUID: Promise] = [:]

  private init() {}

  func attach(_ module: PushDeviceModule) {
    self.module = module
    observingIntents = false
    observingSync = false
  }

  func detach(_ module: PushDeviceModule) {
    stopObserving(module)
    observeSync(module, false)
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

  func observeSync(_ module: PushDeviceModule, _ observing: Bool) {
    if self.module === module { observingSync = observing }
  }

  static func validTags(_ value: Any?) -> Set<String>? {
    guard let tags = value as? [String], (1...64).contains(tags.count),
          tags.allSatisfy({ tag in
            tag.utf8.count == 16 && tag.utf8.allSatisfy {
              (65...90).contains($0) || (97...122).contains($0) ||
                (48...57).contains($0) || $0 == 45 || $0 == 95
            }
          }) else { return nil }
    return Set(tags)
  }

  static func safeInteger(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let time = number.doubleValue
    guard time.isFinite, time >= 0, time <= 9_007_199_254_740_991,
          time.rounded(.down) == time else { return nil }
    return time
  }

  static func clearDelivered(_ tags: Set<String>, asOf: Double? = nil, completion: @escaping () -> Void) {
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { notifications in
      let identifiers = notifications.compactMap { notification -> String? in
        let info = notification.request.content.userInfo
        guard let tag = info["t"] as? String, tags.contains(tag) else { return nil }
        if let asOf = asOf {
          guard let g = safeInteger(info["g"]), g <= asOf else { return nil }
        }
        return notification.request.identifier
      }
      center.removeDeliveredNotifications(withIdentifiers: identifiers)
      completion()
    }
  }

  static func seenSync(_ info: [AnyHashable: Any], completion: @escaping (UIBackgroundFetchResult) -> Void) {
    guard info["k"] as? String == "seen-sync",
          let tags = validTags(info["c"]), let asOf = safeInteger(info["a"]) else {
      completion(.noData)
      return
    }
    clearDelivered(tags, asOf: asOf) {
      DispatchQueue.main.async {
        if shared.observingSync { shared.module?.sendEvent("onSync") }
        completion(.newData)
      }
    }
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
          ["dm", "dm-page", "group", "group-private", "social", "invite-drop"].contains(kind) else { return }
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
