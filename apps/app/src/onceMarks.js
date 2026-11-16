// Opaque marks of one-time notices already shown, kept in the member's
// encrypted seen document so a second device of the same passkey does not
// repeat them. Pure and memory only: the shell moves tokens to and from
// seenSync.
import { sha256 } from '@noble/hashes/sha2.js'
import { seenRecordOf } from './inviteDrop.js'
import { pageNoticeKey } from './pageNotice.js'

export const ONCE_KINDS = Object.freeze(['page-dm-notice', 'invite-drop'])

const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const PAGE_PREFIX = 'varanda-page-dm-notice-'

export function onceToken (kind, member, id) {
  if (!ONCE_KINDS.includes(kind)) return null
  if (typeof member !== 'string' || !HEX64.test(member)) return null
  if (typeof id !== 'string' || id.length === 0 || id.length > 200 || id.includes('\n')) return null
  const digest = sha256(new TextEncoder().encode('varanda-once-v1\n' + kind + '\n' + member + '\n' + id))
  let out = ''
  for (let i = 0; i < 16; i++) out += digest[i].toString(16).padStart(2, '0')
  return out
}

export function pageNoticeOnceId (page) {
  return pageNoticeKey(page) === null ? null : page
}

export function inviteDropOnceId (record) {
  const valid = seenRecordOf(record)
  return valid === null ? null : valid.resetsAt + '#' + valid.seenOpened
}

export function createOnceRegistry () {
  const remote = new Map()
  const local = new Map()
  const markListeners = new Set()
  const changeListeners = new Set()

  function known (member, token) {
    return (remote.has(member) && remote.get(member).has(token)) || (local.has(member) && local.get(member).has(token))
  }

  function call (set, arg) {
    for (const fn of [...set]) {
      try { fn(arg) } catch {}
    }
  }

  return {
    setRemote (member, tokens) {
      if (typeof member !== 'string' || !HEX64.test(member)) return
      const next = new Set()
      if (Array.isArray(tokens)) for (const t of tokens) if (typeof t === 'string' && HEX32.test(t)) next.add(t)
      const before = remote.get(member) || new Set()
      const same = before.size === next.size && [...next].every((t) => before.has(t))
      if (next.size === 0) remote.delete(member)
      else remote.set(member, next)
      if (!same) call(changeListeners)
    },
    has (kind, member, id) {
      const token = onceToken(kind, member, id)
      return token !== null && known(member, token)
    },
    mark (kind, member, id) {
      const token = onceToken(kind, member, id)
      if (token === null) return null
      if (!known(member, token)) {
        if (!local.has(member)) local.set(member, new Set())
        local.get(member).add(token)
        call(markListeners, { member, token })
      }
      return token
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

export function syncedPageNoticeStore (base, member, registry) {
  if (typeof member !== 'string' || !HEX64.test(member) || !registry) return base
  const pageOf = (key) => {
    if (typeof key !== 'string' || !key.startsWith(PAGE_PREFIX)) return null
    const page = key.slice(PAGE_PREFIX.length)
    return pageNoticeKey(page) === key ? page : null
  }
  return {
    getItem (key) {
      let value = null
      try { value = base.getItem(key) } catch {}
      if (value === '1') return '1'
      const page = pageOf(key)
      if (page !== null && registry.has('page-dm-notice', member, page)) return '1'
      return value
    },
    setItem (key, value) {
      try { base.setItem(key, value) } catch {}
      const page = pageOf(key)
      if (value === '1' && page !== null) registry.mark('page-dm-notice', member, page)
    }
  }
}
