// Opaque marks of one-time notices already shown, kept in the member's
// encrypted seen document so a second device of the same passkey does not
// repeat them. Pure and memory only: the shell moves tokens to and from
// seenSync.
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { seenRecordOf } from './inviteDrop.js'
import { ONCE_DEVICE_PREFIX, PAGE_NOTICE_PREFIX, pageNoticeKey } from './pageNotice.js'

export const ONCE_KINDS = Object.freeze(['page-dm-notice', 'invite-drop'])

const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/

// Keyed with the account's own secret (seen.onceKey): a token cut from the
// seen window lands in plain JSON in the browser storage, and hashing the
// public Página keys must not tell which of them it names.
export function onceToken (key, kind, member, id) {
  if (typeof key !== 'string' || !HEX64.test(key) || !onceArgs(kind, member, id)) return null
  const mac = hmac(sha256, hexToBytes(key), utf8ToBytes('varanda-once-v1\n' + kind + '\n' + member + '\n' + id))
  return bytesToHex(mac.subarray(0, 16))
}

function onceArgs (kind, member, id) {
  return ONCE_KINDS.includes(kind) && typeof member === 'string' && HEX64.test(member) &&
    typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('\n')
}

export function inviteDropOnceId (record) {
  const valid = seenRecordOf(record)
  return valid === null ? null : valid.resetsAt + '#' + valid.seenOpened
}

// Per member: its key, the tokens its last answered pass held (remote) and
// the tokens marked here (local). A local token stays unsynced until a pass
// delivers it or the remote set holds it, and every pass sends the unsynced
// ones, so a mark outlives a reset of the pass's pending list.
export function createOnceRegistry () {
  const keys = new Map()
  const remote = new Map()
  const local = new Map()
  const unsynced = new Map()
  // Shown before the member's key came: kept here, never on the device under
  // the plain id, and marked when the key arrives.
  const waiting = new Map()
  // Marks made from `waiting`: their opaque device entry is still to write.
  const owed = new Map()
  const markListeners = new Set()
  const changeListeners = new Set()

  function known (member, token) {
    return (remote.has(member) && remote.get(member).has(token)) || (local.has(member) && local.get(member).has(token))
  }

  function tokenOf (kind, member, id) {
    return keys.has(member) ? onceToken(keys.get(member), kind, member, id) : null
  }

  function call (set, arg) {
    for (const fn of [...set]) {
      try { fn(arg) } catch {}
    }
  }

  function settle (member, done) {
    const left = unsynced.get(member)
    if (!left) return
    for (const t of done) left.delete(t)
    if (left.size === 0) unsynced.delete(member)
  }

  function mark (kind, member, id) {
    const token = tokenOf(kind, member, id)
    if (token === null) return null
    if (!known(member, token)) {
      if (!local.has(member)) local.set(member, new Set())
      local.get(member).add(token)
      if (!unsynced.has(member)) unsynced.set(member, new Set())
      unsynced.get(member).add(token)
      call(markListeners, { member, token })
    }
    return token
  }

  return {
    setKey (member, key) {
      if (typeof member !== 'string' || !HEX64.test(member) || typeof key !== 'string' || !HEX64.test(key)) return
      if (keys.get(member) === key) return
      keys.set(member, key)
      const held = waiting.get(member)
      waiting.delete(member)
      for (const [kind, id] of held ? held.values() : []) {
        const token = mark(kind, member, id)
        if (token === null) continue
        if (!owed.has(member)) owed.set(member, new Map())
        owed.get(member).set(token, kind)
      }
      call(changeListeners)
    },
    // The unsynced tokens stay: opaque without the key, they still go out
    // with the member's next pass. What waits for the key is dropped, so a
    // notice may show again, never skipped for another member.
    forget (member) {
      waiting.delete(member)
      owed.delete(member)
      const hadKey = keys.delete(member)
      const hadRemote = remote.delete(member)
      if (hadKey || hadRemote) call(changeListeners)
    },
    setRemote (member, tokens) {
      if (typeof member !== 'string' || !HEX64.test(member)) return
      const next = new Set()
      if (Array.isArray(tokens)) for (const t of tokens) if (typeof t === 'string' && HEX32.test(t)) next.add(t)
      const before = remote.get(member)
      const same = !!before && before.size === next.size && [...next].every((t) => before.has(t))
      remote.set(member, next)
      settle(member, next)
      if (!same) call(changeListeners)
    },
    // A merge answered with these tokens sent: the node's document holds
    // them now (or cut them earlier and drops them), so they stop going out.
    delivered (member, tokens) {
      if (Array.isArray(tokens)) settle(member, tokens)
    },
    // The member's token for (kind, id), or null while its key is unknown.
    token (kind, member, id) {
      return tokenOf(kind, member, id)
    },
    remoteKnown (member) {
      return remote.has(member)
    },
    unsynced (member) {
      return unsynced.has(member) ? [...unsynced.get(member)] : []
    },
    has (kind, member, id) {
      const token = tokenOf(kind, member, id)
      return token !== null && known(member, token)
    },
    isRemote (kind, member, id) {
      const token = tokenOf(kind, member, id)
      return token !== null && remote.has(member) && remote.get(member).has(token)
    },
    mark,
    // Holds (kind, id) for a member whose key is unknown; false when the key
    // is known (mark instead) or the arguments are not valid.
    wait (kind, member, id) {
      if (!onceArgs(kind, member, id) || keys.has(member)) return false
      if (!waiting.has(member)) waiting.set(member, new Map())
      waiting.get(member).set(kind + '\n' + id, [kind, id])
      return true
    },
    waiting (kind, member, id) {
      return waiting.has(member) && waiting.get(member).has(kind + '\n' + id)
    },
    // The tokens of `kind` marked from the waiting set whose device entry is
    // still owed, handed out once.
    takeOwed (kind, member) {
      const due = owed.get(member)
      if (!due) return []
      const out = []
      for (const [token, k] of due) if (k === kind) out.push(token)
      for (const token of out) due.delete(token)
      if (due.size === 0) owed.delete(member)
      return out
    },
    onMark (fn) {
      markListeners.add(fn)
      return () => { markListeners.delete(fn) }
    },
    onChange (fn) {
      changeListeners.add(fn)
      return () => { changeListeners.delete(fn) }
    }
  }
}

// The own tokens of a pass: the unsynced once-marks first, so the request
// cap never cuts them, then what the screens reported.
export function withOnceTokens (avisos, unsynced) {
  const own = []
  for (const t of Array.isArray(unsynced) ? unsynced : []) {
    if (typeof t === 'string' && HEX32.test(t) && !own.includes(t)) own.push(t)
  }
  const reported = avisos && Array.isArray(avisos.own) ? avisos.own : []
  for (const t of reported) if (!own.includes(t)) own.push(t)
  return { own, pages: avisos && avisos.pages ? avisos.pages : {} }
}

// With the member's key, the device flag of a shown notice goes under an
// opaque name, so the device storage does not list the Páginas the member
// wrote to. Only that member-bound entry is offered again as a mark: a
// page-keyed flag from before may be another member's on a shared device,
// so it reads as shown here and nothing more. Before the key, a shown notice
// waits in the registry and the device gets nothing; its opaque entry is
// written by the first read or write after the key. Without a syncing
// member, the base.
export function syncedPageNoticeStore (base, member, registry) {
  if (typeof member !== 'string' || !HEX64.test(member) || !registry) return base
  const read = (key) => {
    try { return base.getItem(key) } catch { return null }
  }
  const settleOwed = () => {
    for (const token of registry.takeOwed('page-dm-notice', member)) {
      try { base.setItem(ONCE_DEVICE_PREFIX + token, '1') } catch {}
    }
  }
  const pageOf = (key) => {
    if (typeof key !== 'string' || !key.startsWith(PAGE_NOTICE_PREFIX)) return null
    const page = key.slice(PAGE_NOTICE_PREFIX.length)
    return pageNoticeKey(page) === key ? page : null
  }
  const tokenOf = (page) => page === null ? null : registry.token('page-dm-notice', member, page)
  return {
    getItem (key) {
      settleOwed()
      const page = pageOf(key)
      const token = tokenOf(page)
      if (token === null) return page !== null && registry.waiting('page-dm-notice', member, page) ? '1' : read(key)
      if (registry.has('page-dm-notice', member, page)) return '1'
      if (read(ONCE_DEVICE_PREFIX + token) === '1') {
        // Shown here before its mark reached the document (a closed tab):
        // offered again once a pass told what it holds.
        if (registry.remoteKnown(member) && !registry.isRemote('page-dm-notice', member, page)) registry.mark('page-dm-notice', member, page)
        return '1'
      }
      return read(key)
    },
    setItem (key, value) {
      settleOwed()
      const page = pageOf(key)
      const token = tokenOf(page)
      if (page !== null && token === null) {
        if (value === '1') registry.wait('page-dm-notice', member, page)
        return
      }
      try { base.setItem(token === null ? key : ONCE_DEVICE_PREFIX + token, value) } catch {}
      if (value === '1' && token !== null) registry.mark('page-dm-notice', member, page)
    }
  }
}
