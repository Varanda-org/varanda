import rpc from '@varanda/rpc'
import { validOrigin } from './feiraLink.js'
import { tokensOf } from './topics.js'
import { CAT_LABELS } from './feira.js'

const { feira, displayText } = rpc
export const STORAGE_KEY = 'varanda-feira-alerts'
export const FILE_NAME = 'varanda-feira-alerts.json'
export const MAX_SEARCHES = 10
export const INTERVAL_MS = 15 * 60 * 1000
const MAX_ORIGINS = 8
const time = (n) => Number.isSafeInteger(n) && n >= 0
const empty = () => ({ searches: [], counts: {}, lastRun: null })

function normalize (value) {
  if (!value || !feira.isUf(value.uf)) return null
  const cityLabel = typeof value.cityLabel === 'string' ? displayText(value.cityLabel).trim().slice(0, feira.MAX_PLACE) : ''
  const cityKey = feira.cityKey(cityLabel)
  if (!cityKey || cityKey !== value.cityKey) return null
  if (value.kind !== 'todos' && !feira.isKind(value.kind)) return null
  if (value.cat !== 'todas' && !feira.isCat(value.cat)) return null
  if (Array.isArray(value.tokens) && value.tokens.some((token) => typeof token !== 'string')) return null
  const words = Array.isArray(value.tokens) ? value.tokens.join(' ') : value.tokens
  const tokens = [...new Set(tokensOf(typeof words === 'string' ? words : ''))].sort().slice(0, 8)
  const { uf, kind, cat } = value
  const id = JSON.stringify([uf, cityKey, kind, cat, tokens])
  const kindLabel = { todos: 'Todos', produto: 'Produtos', servico: 'Serviços', procura: 'Procura-se' }[kind]
  const label = [cityLabel + '/' + uf, kindLabel, CAT_LABELS[cat] || 'Todas as categorias', tokens.join(' ')].filter(Boolean).join(' · ')
  return { id, uf, cityKey, cityLabel, kind, cat, tokens, seenAtMs: time(value.seenAtMs) ? value.seenAtMs : 0, label }
}

export function list (searches) {
  const out = []
  for (const value of Array.isArray(searches) ? searches : []) {
    const item = normalize(value)
    if (item && !out.some((s) => s.id === item.id)) out.push(item)
    if (out.length === MAX_SEARCHES) break
  }
  return out
}

export function add (searches, value, now) {
  const items = list(searches)
  const item = normalize({ ...value, seenAtMs: now })
  if (!item || !time(now)) return { searches: items, saved: false, full: false }
  if (items.some((s) => s.id === item.id)) return { searches: items, saved: true, full: false }
  if (items.length === MAX_SEARCHES) return { searches: items, saved: false, full: true }
  return { searches: [...items, item], saved: true, full: false }
}

export const remove = (searches, id) => list(searches).filter((s) => s.id !== id)
export const markSeen = (searches, id, now) => list(searches).map((s) => s.id === id && time(now) ? { ...s, seenAtMs: Math.max(s.seenAtMs, now) } : s)
export const plan = (now, lastRun) => time(now) && (lastRun === null || lastRun === undefined || (time(lastRun) && now - lastRun >= INTERVAL_MS))

export function countNew (page, seenAtMs, now = Date.now()) {
  if (!time(seenAtMs) || !time(now)) return 0
  const refs = new Set()
  for (const row of Array.isArray(page?.items) ? page.items : []) {
    if (!row || row.stale || !['disponivel', 'reservado'].includes(row.status)) continue
    if (typeof row.author !== 'string' || !/^[0-9a-f]{64}$/.test(row.author) || !Number.isSafeInteger(row.seq) || row.seq < 1) continue
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN
    if (at > seenAtMs && at <= now) refs.add(row.author + ':' + row.seq)
  }
  return refs.size
}

function cleanState (value) {
  const searches = list(value?.searches)
  const counts = {}
  for (const s of searches) {
    const count = value?.counts?.[s.id]
    counts[s.id] = Number.isSafeInteger(count) && count >= 0 ? count : 0
  }
  return { searches, counts, lastRun: time(value?.lastRun) ? value.lastRun : null }
}

function decode (raw) {
  const map = new Map()
  let value
  try { value = JSON.parse(raw) } catch { return map }
  if (value?.v !== 1 || !Array.isArray(value.origins)) return map
  for (const entry of value.origins.slice(0, MAX_ORIGINS)) {
    if (validOrigin(entry?.origin)) map.set(entry.origin, cleanState(entry))
  }
  return map
}

export function createAlertsStore ({ read, write }) {
  let memory = new Map()
  let dirty = false
  let queue = Promise.resolve()
  function access (origin, change) {
    const run = queue.then(async () => {
      if (!validOrigin(origin)) return { ...empty(), persisted: false }
      if (!dirty) {
        try { memory = decode(await read()) } catch {}
      }
      const state = cleanState(memory.get(origin))
      if (!change) return state
      const result = change(state)
      if (result === null) return null
      memory.delete(origin)
      memory.set(origin, cleanState(result))
      while (memory.size > MAX_ORIGINS) memory.delete(memory.keys().next().value)
      dirty = true
      try {
        await write(JSON.stringify({ v: 1, origins: [...memory].map(([origin, state]) => ({ origin, ...state })) }))
        dirty = false
      } catch {}
      return { ...result, persisted: !dirty }
    })
    queue = run.catch(() => {})
    return run
  }
  return {
    load: (origin) => access(origin),
    list: async (origin) => (await access(origin)).searches,
    add: (origin, value, now = Date.now()) => access(origin, (state) => ({ ...state, ...add(state.searches, value, now) })),
    remove: (origin, id) => access(origin, (state) => cleanState({ ...state, searches: remove(state.searches, id) })),
    markSeen: (origin, id, now = Date.now()) => access(origin, (state) => ({ ...state, searches: markSeen(state.searches, id, now), counts: { ...state.counts, [id]: 0 } })),
    beginRun: (origin, now) => access(origin, (state) => state.searches.length && plan(now, state.lastRun) ? { ...state, lastRun: now } : null),
    recordCounts: (origin, results) => access(origin, (state) => {
      for (const result of results) {
        const current = state.searches.find((s) => s.id === result.id)
        // Opening or removing a search while its read is in flight wins.
        if (current && current.seenAtMs === result.seenAtMs) state.counts[current.id] = result.count
      }
      return cleanState(state)
    })
  }
}
