// Who the app acts as: the member or one of the pages they run. A pure
// subscription store (no React) read by the hooks that publish, like, delete
// or message. Names and @nomes come from the page and are peer text, so they
// only leave this module through displayText.

import rpc from '@varanda/rpc'

const { displayText } = rpc

const KEY_RE = /^[0-9a-f]{64}$/
const ME = Object.freeze({ kind: 'me' })

export function createActingAs () {
  let state = ME
  const listeners = new Set()

  function emit () {
    for (const fn of [...listeners]) {
      try { fn() } catch {}
    }
  }

  function commit (next) {
    const same = next.kind === state.kind && next.key === state.key && next.name === state.name &&
      next.username === state.username
    if (same) return state
    state = next
    emit()
    return state
  }

  const get = () => state
  const me = () => commit(ME)

  // A bad key or a closed page never becomes the acting identity: the next
  // post would be signed for a page nobody can write to.
  function asPage ({ key, name, username, closed } = {}) {
    const k = typeof key === 'string' ? key.toLowerCase() : ''
    if (!KEY_RE.test(k) || closed === true) return me()
    return commit(Object.freeze({
      kind: 'page',
      key: k,
      name: typeof name === 'string' ? name : '',
      username: typeof username === 'string' ? username : ''
    }))
  }

  const isPage = () => state.kind === 'page'

  // Never a raw key as a label.
  function label () {
    if (state.kind !== 'page') return 'Você'
    const name = displayText(state.name).trim()
    if (name !== '') return name
    const username = displayText(state.username).trim()
    return username !== '' ? '@' + username : 'Página'
  }

  function subscribe (fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  const set = (next) => (next && next.kind === 'page' ? asPage(next) : me())

  return { get, set, me, asPage, isPage, label, subscribe, reset: me }
}

const shared = createActingAs()
export const { get, set, me, asPage, isPage, label, subscribe, reset } = shared
