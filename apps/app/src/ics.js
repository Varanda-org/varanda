// A single-event iCalendar (.ics) text. Every peer-supplied string is escaped
// (RFC 5545 TEXT) and control characters are dropped so a title can never add
// a property line. Lines are CRLF terminated and folded at 75 octets.

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

export function escapeText (s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/;/g, '\\;').replace(/,/g, '\\,')
}

// Fold by octets without splitting a UTF-8 character.
export function fold (line) {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const parts = []
  let cur = ''
  let size = 0
  let limit = 75
  for (const ch of line) {
    const n = enc.encode(ch).length
    if (size + n > limit) {
      parts.push(cur)
      cur = ''
      size = 0
      limit = 74
    }
    cur += ch
    size += n
  }
  parts.push(cur)
  return parts.join('\r\n ')
}

// card: { title, place, startMs, endMs }, uid: stable id text, now: ms.
export function buildIcs ({ card, uid, now = Date.now() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Varanda//Eventos//PT',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + escapeText(uid) + '@varanda',
    'DTSTAMP:' + stamp(now),
    'DTSTART:' + stamp(card.startMs)
  ]
  if (card.endMs !== null && card.endMs !== undefined) lines.push('DTEND:' + stamp(card.endMs))
  lines.push('SUMMARY:' + escapeText(card.title))
  if (card.place) lines.push('LOCATION:' + escapeText(card.place))
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

export const FILE_NAME = 'evento.ics'
