// iOS/Android: there are no App Links, so an invite reaches the app as a
// varanda:///convite/<code> link, as an https link of this installation that
// the system hands to the app, or pasted by hand in the link step. App.js
// routes every URL the app is opened with here (Linking's initial URL and
// its 'url' listener). The code lives in this process's memory only, for the
// session, like the web's tab storage; it goes only to the account service.
// No react-native import: the tests load this module with import().

import rpc from '@varanda/rpc'
import { createSignupInviteHolder } from './signupInvite.js'
import { parseAppLink, parseInviteInput } from './linkReturn.js'

const { parseInviteCardUrl, FRAGMENT_MARK } = rpc

function memoryStorage () {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

const storage = memoryStorage()
const holder = createSignupInviteHolder({ getStorage: () => storage })
const NO_HISTORY = { state: null, replaceState () {} }

function keep (code) {
  return holder.capture({ location: { pathname: '/convite/' + code, search: '', hash: '' }, history: NO_HISTORY })
}

// With no argument (App.js at import): the record held, if any. With a URL
// the app was opened with: a valid invite link replaces the held code (a
// newer link wins); any other URL changes nothing. With paste: true, the
// text may also be the bare code. A '#c1.' card on the same link is kept
// beside the code (keep() has already dropped any older card).
export function captureSignupInvite (url, { paste = false } = {}) {
  try {
    if (url === undefined) return holder.load()
    const code = paste ? parseInviteInput(url) : inviteCode(url)
    if (code === null) return null
    const rec = keep(code)
    keepCard(url, code)
    return rec
  } catch {
    return null
  }
}

function keepCard (url, code) {
  try {
    const link = url.trim()
    const card = parseInviteCardUrl(link)
    if (card === null || card.code !== code) return
    holder.keepCard(code, link.slice(link.indexOf(FRAGMENT_MARK) + FRAGMENT_MARK.length))
  } catch {}
}

function inviteCode (url) {
  const link = parseAppLink(url)
  return link !== null && link.kind === 'convite' ? link.code : null
}

export function loadSignupInvite () {
  try { return holder.load() } catch { return null }
}

export function dropSignupInvite () {
  try { return holder.drop() } catch { return false }
}

export function loadSignupInviteCard () {
  try { return holder.loadCard() } catch { return null }
}

export function dropSignupInviteCard () {
  try { return holder.dropCard() } catch { return false }
}
