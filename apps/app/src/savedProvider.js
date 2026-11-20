// The saved posts list of this device, scoped by installation origin and own
// diary key (savedPostsStore.*.js). Post rows read it with useSaved() to offer
// Salvar or Tirar dos salvos, and the Posts salvos screen lists `entries`.
// Hosted nodes only: elsewhere `available` is false and nothing is stored.
// Refs only, nothing leaves the device, no count is shown to anyone.

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { installationOrigin } from './installation'
import { validOrigin } from './feiraLink'
import { addSaved, forgetSavedKey, loadSaved, removeSaved } from './savedPostsStore'
import { refKey } from './savedView'

const HEX64 = /^[0-9a-f]{64}$/
const EMPTY = Object.freeze([])
const NONE = Object.freeze({
  available: false,
  loaded: false,
  entries: EMPTY,
  has: () => false,
  save: async () => ({ ok: false, reason: 'invalid', persisted: false }),
  unsave: async () => false
})

const SavedContext = createContext(NONE)

export function useSaved () {
  return useContext(SavedContext)
}

function scopeOf ({ hosted, ownKey, origin }) {
  if (hosted !== true || typeof ownKey !== 'string' || !HEX64.test(ownKey.toLowerCase())) return null
  const where = origin || installationOrigin() || globalThis.location?.origin || null
  if (!validOrigin(where)) return null
  return { origin: where, key: ownKey.toLowerCase() }
}

// The account was removed from this device: forget its list under every
// installation origin (the key alone decides). Never throws; false when it
// could not be done, which callers may ignore. The origin argument is kept
// for the callers and no longer used.
export async function forgetSavedFor (ownKey) {
  if (typeof ownKey !== 'string' || !HEX64.test(ownKey.toLowerCase())) return false
  try {
    return await forgetSavedKey(ownKey.toLowerCase())
  } catch {
    return false
  }
}

export function SavedProvider ({ hosted, ownKey, origin, children }) {
  const scope = scopeOf({ hosted, ownKey, origin })
  const id = scope === null ? '' : scope.origin + '\n' + scope.key
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [state, setState] = useState({ id: '', entries: EMPTY })

  const reload = useCallback(async (forId) => {
    const s = scopeRef.current
    if (s === null || s.origin + '\n' + s.key !== forId) return
    let entries = EMPTY
    try {
      entries = await loadSaved(s.origin, s.key)
    } catch {}
    setState((cur) => (scopeRef.current !== null && scopeRef.current.origin + '\n' + scopeRef.current.key === forId ? { id: forId, entries } : cur))
  }, [])

  useEffect(() => {
    if (id === '') return
    reload(id)
  }, [id, reload])

  const entries = state.id === id && id !== '' ? state.entries : EMPTY
  const refs = useMemo(() => new Set(entries.map((e) => refKey(e.author, e.seq))), [entries])

  const save = useCallback(async (author, seq) => {
    const s = scopeRef.current
    if (s === null) return { ok: false, reason: 'invalid', persisted: false }
    const result = await addSaved(s.origin, s.key, { author, seq })
    await reload(s.origin + '\n' + s.key)
    return result
  }, [reload])

  const unsave = useCallback(async (author, seq) => {
    const s = scopeRef.current
    if (s === null) return false
    const ok = await removeSaved(s.origin, s.key, { author, seq })
    await reload(s.origin + '\n' + s.key)
    return ok
  }, [reload])

  const value = useMemo(() => id === ''
    ? NONE
    : { available: true, loaded: state.id === id, entries, has: (author, seq) => refs.has(refKey(author, seq)), save, unsave },
  [id, state.id, entries, refs, save, unsave])
  return createElement(SavedContext.Provider, { value }, children)
}
