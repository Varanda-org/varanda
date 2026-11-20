// Web: hands the .ics text to the browser as a download. Globals are read
// inside the call. -> { ok: true } or { ok: false }.
import { FILE_NAME } from './ics.js'

export const calendarExportAvailable = true

export function exportCalendar (text, name = FILE_NAME) {
  try {
    const blob = new globalThis.Blob([text], { type: 'text/calendar;charset=utf-8' })
    const url = globalThis.URL.createObjectURL(blob)
    const a = globalThis.document.createElement('a')
    a.href = url
    a.download = name
    a.rel = 'noopener'
    globalThis.document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => globalThis.URL.revokeObjectURL(url), 1000)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
