import { seenOnScreen } from './notices.js'
import { readTags } from './noticeTags.js'

const UNREAD_MAX = 256
const UNREAD_MS = 24 * 3600 * 1000

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

export function avisoReadRows (rows, seenIds, state, now = Date.now()) {
  const seen = new Set(seenOnScreen(rows, seenIds))
  const snapshot = rows.map((row) => ({
    kind: row.kind,
    key: row.key,
    seq: row.seq,
    post: row.post,
    at: row.at,
    read: seen.has(row.seen)
  }))
  if (!state) return snapshot
  if (!state.unread) state.unread = new Map()
  if (!state.blocked) state.blocked = new Set()
  const { unread, blocked } = state
  // Once a row is forgotten, a later partial page cannot prove its tag read.
  // Keep only its tag until this namespace's state is reset, also bounded.
  const forget = (id, entry) => {
    unread.delete(id)
    if (blocked.has(entry.tag)) return
    if (blocked.size < UNREAD_MAX) blocked.add(entry.tag)
    else state.overflow = true
  }
  for (const row of snapshot) {
    const tag = readTags({ avisos: [{ ...row, read: true }] })[0]
    if (!tag) continue
    const id = JSON.stringify([tag, row.key, row.seq])
    if (row.read) unread.delete(id)
    else {
      unread.set(id, { row, tag, at: now })
      if (unread.size > UNREAD_MAX) {
        const [oldest, entry] = unread.entries().next().value
        forget(oldest, entry)
      }
    }
  }
  for (const [id, entry] of unread) {
    if (now - entry.at >= UNREAD_MS) forget(id, entry)
  }
  if (state.overflow) return []
  const result = snapshot.filter((row) => !blocked.has(readTags({ avisos: [{ ...row, read: true }] })[0]))
  // Hidden first pages omit older rows, so absence must not clear their veto.
  return result.concat([...unread.values()].map((entry) => entry.row))
}
