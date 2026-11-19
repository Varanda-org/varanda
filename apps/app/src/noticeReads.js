import { seenOnScreen } from './notices.js'

export function groupReadState ({ rows, partial, failed, error }) {
  if (failed || error) return { groups: [], privateUnread: undefined }
  const groups = rows.filter((row) => row.visibility === 'public' && row.seeded !== true)
    .map((row) => ({ group: row.group, unread: row.unread, at: row.last?.at }))
  // An omitted private group or count cannot stand for an empty inbox.
  const complete = !partial && rows.every((row) => row.seeded !== true &&
    (row.visibility === 'public' || row.visibility === 'private') &&
    Number.isSafeInteger(row.unread) && row.unread >= 0)
  const privateUnread = complete
    ? rows.filter((row) => row.visibility === 'private').reduce((sum, row) => sum + row.unread, 0)
    : undefined
  return { groups, privateUnread }
}

export function avisoReadRows (rows, seenIds) {
  const seen = new Set(seenOnScreen(rows, seenIds))
  return rows.map((row) => ({
    kind: row.kind,
    key: row.key,
    seq: row.seq,
    post: row.post,
    at: row.at,
    read: seen.has(row.seen)
  }))
}
