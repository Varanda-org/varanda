export const STORAGE_KEY = 'varanda-invite-seen'
export const FILE_NAME = 'varanda-invite-seen.json'
export const POLL_MS = 15 * 60 * 1000

const RECORD_KEYS = ['v', 'member', 'resetsAt', 'seenOpened']
const MEMBER_RE = /^[0-9a-f]{64}$/

export function seenRecordOf (value) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== RECORD_KEYS.length || !keys.every((key) => RECORD_KEYS.includes(key))) return null
    const { v, member, resetsAt, seenOpened } = value
    if (v !== 1 || typeof member !== 'string' || !MEMBER_RE.test(member)) return null
    if (typeof resetsAt !== 'string' || new Date(resetsAt).toISOString() !== resetsAt) return null
    if (!Number.isSafeInteger(seenOpened) || seenOpened < 0 || seenOpened > 100) return null
    return { v: 1, member, resetsAt, seenOpened }
  } catch {
    return null
  }
}

export function shouldAnnounce ({ summary, seen }) {
  if (!summary || summary.mode !== 'sorteio' || !(summary.remaining > 0)) return false
  const record = seenRecordOf(seen)
  return record === null || summary.resetsAt !== record.resetsAt || summary.opened > record.seenOpened
}

// Memory wins over a stale disk read after a refused write, including a read
// that was already in flight when the note appeared.
export function createInviteSeenStore ({ read, write }) {
  let memory = null
  let writes = Promise.resolve()
  return {
    async load () {
      if (memory !== null) return seenRecordOf(memory)
      try {
        const stored = seenRecordOf(JSON.parse(await read()))
        if (memory === null) memory = stored
      } catch {}
      return seenRecordOf(memory)
    },
    async save (record) {
      const valid = seenRecordOf(record)
      if (valid === null) return false
      memory = valid
      const pending = writes.then(() => write(JSON.stringify(valid))).then(() => true, () => false)
      writes = pending
      return pending
    }
  }
}

// The shell supplies capability gates; transport and timers are injected so
// a lock or identity change can invalidate every awaited step in tests too.
export function createInviteDropMonitor ({ policy, start, summary, store, setInterval, clearInterval, onNote }) {
  let current = null
  let timer = null
  let unavailable = false
  let note = null
  const seen = new Map()

  function clearTimer () {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  function publish (next) {
    note = next
    onNote(next)
  }

  async function poll (session) {
    if (current !== session || session.busy || unavailable) return
    session.busy = true
    try {
      if (session.policy === undefined) {
        const answer = await policy()
        if (current !== session) return
        session.policy = answer
        if (answer === null) unavailable = true
        if (!answer || answer.required !== true) {
          clearTimer()
          return
        }
      }
      const { member, request } = session
      const stored = await store.load()
      if (current !== session) return
      const record = seenRecordOf(stored)
      if (!seen.has(member) && record && record.member === member) seen.set(member, record)
      const { nonce } = await start({ member })
      if (current !== session) return
      const { signature } = await request('invite.sign', { action: 'summary', nonce })
      if (current !== session) return
      const answer = await summary({ member, nonce, signature })
      if (current !== session) return
      if (answer === null) {
        unavailable = true
        clearTimer()
        publish(null)
        return
      }
      const next = seenRecordOf({ v: 1, member, resetsAt: answer.resetsAt, seenOpened: answer.opened })
      if (next && shouldAnnounce({ summary: answer, seen: seen.get(member) })) {
        if (!note || note.resetsAt !== next.resetsAt || note.seenOpened !== next.seenOpened) publish(next)
      } else if (answer.remaining === 0 || answer.mode !== 'sorteio') {
        publish(null)
      }
    } catch {
      // A failed read says nothing about the available balance.
    } finally {
      session.busy = false
    }
  }

  // Stopping keeps the note: a visibility flicker (iOS 'inactive', a web tab
  // switch) must not erase the only notice on native, whose seen record was
  // already written. The shell hides it while disabled.
  function stop () {
    current = null
    clearTimer()
  }

  return {
    update ({ enabled, member, request }) {
      if (current && enabled && current.member === member && current.request === request) return
      stop()
      if (note && typeof member === 'string' && member !== note.member) publish(null)
      if (!enabled || unavailable || typeof member !== 'string' || !MEMBER_RE.test(member)) return
      const session = { member, request, busy: false, policy: undefined }
      current = session
      timer = setInterval(() => { poll(session) }, POLL_MS)
      poll(session)
    },
    markSeen (record) {
      if (!current || record !== note) return
      const previous = seen.get(record.member)
      if (previous && previous.resetsAt === record.resetsAt && previous.seenOpened >= record.seenOpened) return
      seen.set(record.member, record)
      // The memory guard is synchronous, even if persistence rejects.
      Promise.resolve().then(() => store.save(record)).catch(() => {})
    },
    dismiss () { publish(null) },
    stop
  }
}
