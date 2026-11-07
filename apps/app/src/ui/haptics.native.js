import * as Haptics from 'expo-haptics'

// Fire and forget: a device without a vibrator must never break a tap.
export function tap (kind) {
  try {
    let pending
    if (kind === 'select') pending = Haptics.selectionAsync()
    else if (kind === 'success') pending = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    else if (kind === 'warn') pending = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
    else pending = Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
  } catch {}
}
