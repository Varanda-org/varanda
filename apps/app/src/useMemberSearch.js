// Account search state for the Seguindo screen (hosted web only): the typed
// query, a 400 ms debounce, the seeder's /index search answer (untrusted: it
// only says where to look) and one diary.peek per listed member. Rows come
// only from confirmedHits over the peeks, never from the index body, and
// appear one by one as the peeks land.
//
// A generation counter guards every run: any query change, clear, retry or
// flush, and any change of hosted/online bumps it before anything else, so a
// run in flight can never publish after it. Nothing is logged or persisted.

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchSearch } from './indexClient'
import { confirmedHits, planSearchPeeks, queryPath, queryTokens } from './search'
import { isDiaryGone, peekAll } from './screens/Conversa'

const DEBOUNCE_MS = 400
const NOT_READY = 'A busca ainda não está disponível.'
const FAILED = 'Não foi possível buscar agora.'

const EMPTY = Object.freeze({ phase: 'idle', hits: [], more: false, indexing: false, complete: true, unchecked: 0, error: '' })

function stateOf (phase, extra) {
  return { ...EMPTY, phase, ...extra }
}

export function useMemberSearch ({ request, hosted, online, ownKey }) {
  const [query, setQueryState] = useState('')
  const [state, setState] = useState(EMPTY)
  const genRef = useRef(0)
  const timerRef = useRef(null)
  // The path whose run finished and is on screen: not fetched again unless
  // retry/flush. Reset whenever the results are cleared.
  const shownRef = useRef(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const requestRef = useRef(request)
  requestRef.current = request
  const ownRef = useRef(null)
  ownRef.current = typeof ownKey === 'string' ? ownKey.toLowerCase() : null

  const stopTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const run = useCallback(async (path, text, gen) => {
    const alive = () => gen === genRef.current
    const own = ownRef.current
    setState(stateOf('loading'))
    const res = await fetchSearch(path)
    if (!alive()) return
    if (!res || !res.ok) {
      setState(stateOf('error', { error: res && res.reason === 'not-found' ? NOT_READY : FAILED }))
      return
    }
    const { members, more, indexing, complete } = res.value
    const meta = { more: more === true, indexing: indexing === true, complete: complete !== false }
    const plan = planSearchPeeks(members, own)
    const peeked = new Map()
    const gone = new Set()
    const wrapped = (m, p) => requestRef.current(m, p).catch((err) => {
      if (isDiaryGone(err) && p && typeof p.author === 'string') gone.add(p.author)
      throw err
    })
    const qTokens = queryTokens(text)
    const list = Array.isArray(members) ? members : []
    // Members not shown that the node could not check: no peek, or a peek
    // missing a hinted profile or @nome (its block did not arrive). Refused
    // ones ('diário indisponível') never count.
    const uncheckedCount = (hits) => {
      const shown = new Set(hits.map((h) => h.author))
      let n = 0
      for (const m of list) {
        const author = m && typeof m.author === 'string' ? m.author : null
        if (author === null || author.toLowerCase() === own) continue
        if (gone.has(author) || shown.has(author)) continue
        const peek = peeked.get(author)
        if (!peek || (m.profileSeq != null && peek.profile == null) || (m.usernameSeq != null && peek.username == null)) n++
      }
      return n
    }
    const publish = (done) => {
      const hits = confirmedHits(qTokens, members, peeked, own).hits
      setState(stateOf(done ? 'ready' : 'loading', { ...meta, hits, unchecked: done ? uncheckedCount(hits) : 0 }))
    }
    publish(false)
    try {
      for (const item of plan) {
        await peekAll(wrapped, [item], peeked, alive)
        if (!alive()) return
        publish(false)
      }
    } catch {
      if (!alive()) return
      setState(stateOf('error', { error: FAILED }))
      return
    }
    if (!alive()) return
    shownRef.current = path
    publish(true)
  }, [])

  // Decides what the current query means; `force` (retry/flush) runs at once
  // even for the path already shown.
  const decide = useCallback((text, force) => {
    const gen = ++genRef.current
    stopTimer()
    const clearTo = (phase) => {
      shownRef.current = null
      setState(stateOf(phase))
    }
    if (!hosted) return clearTo('idle')
    if (typeof text !== 'string' || text.trim() === '') return clearTo('idle')
    if (online === false) return clearTo('offline')
    const path = queryPath(text)
    if (path === null) return clearTo('short')
    if (!force && path === shownRef.current) return
    clearTo('loading')
    if (force) {
      run(path, text, gen)
      return
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (gen === genRef.current) run(path, text, gen)
    }, DEBOUNCE_MS)
  }, [hosted, online, run])

  useEffect(() => { decide(query, false) }, [query, decide])

  useEffect(() => () => {
    genRef.current++
    stopTimer()
  }, [])

  // An emptied field drops the results in the same render and stops any run.
  const setQuery = useCallback((text) => {
    const next = typeof text === 'string' ? text : ''
    if (next.trim() === '') {
      genRef.current++
      stopTimer()
      shownRef.current = null
      setState(EMPTY)
    }
    setQueryState(next)
  }, [])

  const flush = useCallback(() => decide(queryRef.current, true), [decide])
  const clear = useCallback(() => {
    genRef.current++
    stopTimer()
    shownRef.current = null
    setState(EMPTY)
    setQueryState('')
  }, [])

  return {
    query,
    setQuery,
    flush,
    retry: flush,
    clear,
    phase: state.phase,
    hits: state.hits,
    more: state.more,
    indexing: state.indexing,
    complete: state.complete,
    unchecked: state.unchecked,
    error: state.error
  }
}
