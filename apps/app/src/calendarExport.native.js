// iOS/Android: no way to attach a file with the share sheet (shareNav.native.js),
// so the calendar export is unavailable and the screen hides the action.
export const calendarExportAvailable = false

export function exportCalendar () {
  return { ok: false, reason: 'unavailable' }
}
