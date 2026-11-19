import ExpoModulesCore
import UIKit
import UserNotifications

public class PushDeviceAppDelegate: ExpoAppDelegateSubscriber, UNUserNotificationCenterDelegate {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  public func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    DispatchQueue.main.async {
      PushDeviceState.shared.registered(token)
    }
  }

  public func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    DispatchQueue.main.async {
      PushDeviceState.shared.registrationFailed()
    }
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let info = notification.request.content.userInfo
    if info["k"] as? String == "seen-sync" {
      PushDeviceState.seenSync(info) { _ in completionHandler([]) }
    } else {
      completionHandler([])
    }
  }

  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    PushDeviceState.seenSync(userInfo, completion: completionHandler)
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let kind = response.notification.request.content.userInfo["k"]
    DispatchQueue.main.async {
      if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
        PushDeviceState.shared.receive(kind)
      }
      completionHandler()
    }
  }
}
