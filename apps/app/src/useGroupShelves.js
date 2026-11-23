// The discovery shelves of Comunidades (src/groupShelves.js says what each
// one holds and in what order). Three group shelves come from the seeder's
// /index/discover/groups lists and the two community shelves from
// /index/discover/communities; "Grupos de quem você segue" is worked out on
// this device from /index/discover/of of up to 24 followed diaries, one at a
// time, never one index call per group.
//
// Blocks fail closed: nothing is asked and nothing shows until the block list
// of this run is loaded. The followed rows are kept raw (per diary, for
// FOLLOW_CACHE_MS) and the shelf is derived again on every render against
// the current block list, so a block made after the fetch hides that group
// or community, its creator, or that diary at once.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBlocks } from './blocksProvider'
import { readFollowKeys } from './follow'
import { membersLabel } from './groups'
import { fanOut } from './groupFanOut'
import { fetchDiscoverCommunities, fetchDiscoverGroups } from './indexClient'
import { cacheGeneration, registerLocalCache } from './localCaches'
import {
  COMMUNITY_ORDER_TEXT,
  COMMUNITY_PARTIAL_TEXT,
  COMMUNITY_SHELF_IDS,
  COMMUNITY_SHELF_TITLES,
  FOLLOW_CACHE_MS,
  JOIN_TEXT,
  GROUP_LIST_LIMIT,
  GROUP_LIST_PAGES,
  ORDER_TEXT,
  PARTIAL_TEXT,
  SHELF_IDS,
  SHELF_TITLES,
  activeText,
  followReason,
  followSample,
  joinedOf,
  olderSeeder,
  tallyFollowed,
  trendingRows,
  visibleRows
} from './groupShelves'

const BROWSE_ORDERS = ['trending', 'members', 'recent']
const FOLLOW_PAGE = 500
const NO_SHELVES = []
const NO_COMMUNITY_SHELVES = []

function keySet (keys) {
  if (keys === null || typeof keys !== 'object' || typeof keys[Symbol.iterator] !== 'function') return null
  const set = new Set()
  for (const key of keys) if (typeof key === 'string') set.add(key.toLowerCase())
  return set
}

// Raw followed rows by bindingKey: { at, perDiary, sampledAll }. Never a
// derived shelf.
const followCache = new Map()

function withoutDiaries (perDiary, drop) {
  return perDiary.filter(({ diary }) => !drop.has(diary)).map((d) => ({
    diary: d.diary,
    groups: d.groups.filter((row) => !drop.has(row.creator))
  }))
}

function withDiaries (perDiary, keep) {
  return perDiary.filter(({ diary }) => keep.has(diary))
}

registerLocalCache({
  wipe: () => { followCache.clear() },
  dropAuthors: (keys) => {
    const drop = keySet(keys)
    if (drop === null) return
    for (const [key, entry] of followCache) followCache.set(key, { ...entry, perDiary: withoutDiaries(entry.perDiary, drop) })
  },
  keepOnlyAuthors: (keys) => {
    const keep = keySet(keys)
    if (keep === null) return
    for (const [key, entry] of followCache) followCache.set(key, { ...entry, perDiary: withDiaries(entry.perDiary, keep) })
  }
})

function cacheable (bindingKey) {
  return typeof bindingKey === 'string' && bindingKey !== ''
}

function freshEntry (entry, now) {
  return entry !== null && entry !== undefined && now - entry.at >= 0 && now - entry.at < FOLLOW_CACHE_MS
}

function readCache (bindingKey, now) {
  if (!cacheable(bindingKey)) return null
  const entry = followCache.get(bindingKey)
  return freshEntry(entry, now) ? entry : null
}

// group.list pages until `total` or GROUP_LIST_PAGES pages. A page that is
// not { groups: [...], total } makes the whole read fail (null): joinedOf
// would read it as "joined nothing".
async function readJoined (request, alive) {
  const pages = []
  let offset = 0
  for (let i = 0; i < GROUP_LIST_PAGES; i++) {
    const page = await request('group.list', { offset, limit: GROUP_LIST_LIMIT })
    if (!alive()) return null
    if (page === null || typeof page !== 'object' || !Array.isArray(page.groups) || !Number.isSafeInteger(page.total) || page.total < 0) return null
    for (const row of page.groups) {
      if (row === null || typeof row !== 'object' || typeof row.group !== 'string' || typeof row.role !== 'string') return null
    }
    pages.push(page)
    offset += page.groups.length
    if (page.groups.length === 0 || offset >= page.total) break
  }
  return joinedOf(pages)
}

function browseItem (row, trending) {
  const members = membersLabel(row.writerCount)
  return {
    group: row.group,
    name: row.name,
    meta: trending ? [members, activeText(row.active)].filter(Boolean).join(' · ') : members,
    reason: null
  }
}

function communityItem (row) {
  return {
    community: row.community,
    name: row.name,
    meta: [membersLabel(row.members), JOIN_TEXT[row.join]].filter(Boolean).join(' · ')
  }
}

// enabled: a hosted node; request: node.request; pageKey: the page acting
// (null for the member, who alone has the followed shelf); bindingKey: the
// snapshot binding as a string ('' for none, which caches nothing); ownKey:
// the person's own diary key, left out of the followed count.
// -> { shelves: [{ id, title, orderText, note, items }], communityShelves:
// [{ id, title, orderText, note, items: [{ community, name, meta }] }], reload }
export function useGroupShelves ({ enabled, request, pageKey, bindingKey, ownKey, groupVersions }) {
  const blocks = useBlocks()
  const ready = enabled === true && blocks.loadState === 'ok'
  const member = pageKey === null
  const requestRef = useRef(request)
  requestRef.current = request

  const [browse, setBrowse] = useState(null)
  const [joined, setJoined] = useState(null)
  // { key, at, perDiary, sampledAll } for bindingKey `key`, or null.
  const [followed, setFollowed] = useState(null)
  const followedRef = useRef(null)
  followedRef.current = followed
  const [tick, setTick] = useState(0)
  const [followTick, setFollowTick] = useState(0)

  const browseGen = useRef(0)
  const joinedGen = useRef(0)
  const runningFollow = useRef(null)

  useEffect(() => registerLocalCache({
    wipe: () => {
      runningFollow.current = null
      setFollowed(null)
    },
    dropAuthors: (keys) => {
      const drop = keySet(keys)
      if (drop !== null) setFollowed((f) => (f === null ? f : { ...f, perDiary: withoutDiaries(f.perDiary, drop) }))
    },
    keepOnlyAuthors: (keys) => {
      const keep = keySet(keys)
      if (keep !== null) setFollowed((f) => (f === null ? f : { ...f, perDiary: withDiaries(f.perDiary, keep) }))
    }
  }), [])

  useEffect(() => {
    const mine = ++browseGen.current
    if (!ready) {
      setBrowse(null)
      return
    }
    ;(async () => {
      const results = await Promise.all([
        ...BROWSE_ORDERS.map((order) => fetchDiscoverGroups(order)),
        ...COMMUNITY_SHELF_IDS.map((order) => fetchDiscoverCommunities(order))
      ])
      if (mine !== browseGen.current) return
      setBrowse({ older: olderSeeder(results), results })
    })()
    return () => { browseGen.current++ }
  }, [ready, tick])

  // The fan-out waits for the browse answers: an older seeder that knows none
  // of the lists gets no /index/discover/of calls either.
  const fanOutOk = browse !== null && browse.older === false

  useEffect(() => {
    const mine = ++joinedGen.current
    if (!ready || !fanOutOk || !member) {
      setJoined(null)
      return
    }
    const alive = () => mine === joinedGen.current
    ;(async () => {
      let set = null
      try {
        set = await readJoined(requestRef.current, alive)
      } catch {
        set = null
      }
      if (alive()) setJoined(set)
    })()
    return () => { joinedGen.current++ }
  }, [ready, fanOutOk, member, tick, groupVersions])

  useEffect(() => {
    const key = bindingKey
    if (!ready || !fanOutOk || !member) {
      setFollowed(null)
      return
    }
    const cached = readCache(key, Date.now())
    if (cached !== null) {
      setFollowed({ key, ...cached })
      return
    }
    // Another binding's rows never stay on screen while this one is read.
    setFollowed((f) => (f !== null && f.key === key ? f : null))
    const run = { key }
    runningFollow.current = run
    const alive = () => runningFollow.current === run
    const clear = () => {
      if (alive()) runningFollow.current = null
    }
    ;(async () => {
      try {
        const gen = cacheGeneration()
        const keys = await readFollowKeys(requestRef.current, FOLLOW_PAGE)
        if (!alive()) return
        if (keys === null) {
          setFollowed(null)
          return
        }
        const sample = followSample(keys, Date.now())
        const out = await fanOut(sample, alive)
        if (out === null || !alive()) return
        const failed = !out.answeredAll && out.perDiary.length === 0
        const entry = { at: Date.now(), perDiary: out.perDiary, sampledAll: out.answeredAll && sample.length >= keys.size, failed }
        // A wipe, a block or an unfollow since the read began: neither kept nor
        // shown, since rendering filters blocks but not follows.
        if (gen !== cacheGeneration()) return
        // A read that failed before any row came back is never kept, so a
        // refresh after the network returns asks again.
        if (cacheable(key) && !failed) followCache.set(key, entry)
        setFollowed({ key, ...entry })
      } finally {
        clear()
      }
    })()
    return clear
  }, [ready, fanOutOk, member, bindingKey, followTick])

  // The browse lists are asked again; the followed rows only when none is
  // fresh, so a pull to refresh never restarts the 24 calls.
  const reload = useCallback(() => {
    setTick((n) => n + 1)
    if (runningFollow.current?.key === bindingKey) return
    const f = followedRef.current
    if (f === null || f.key !== bindingKey || f.failed || !freshEntry(f, Date.now())) setFollowTick((n) => n + 1)
  }, [bindingKey])

  const blocked = blocks.keys
  const shelves = useMemo(() => {
    if (!ready || browse === null || browse.older) return NO_SHELVES
    const out = []
    for (const id of SHELF_IDS) {
      let items = []
      let note = null
      if (id === 'followed') {
        if (!member || joined === null || followed === null || followed.key !== bindingKey) continue
        const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
        items = tallyFollowed(followed.perDiary, { joined, blocked, own }).map((row) => ({
          group: row.group,
          name: row.name,
          meta: membersLabel(row.writerCount),
          reason: followReason(row.count, followed.sampledAll)
        }))
      } else {
        const res = browse.results[BROWSE_ORDERS.indexOf(id)]
        if (!res || res.ok !== true) continue
        const trending = id === 'trending'
        let rows = visibleRows(res.value.groups, blocked)
        if (trending) rows = trendingRows(rows)
        items = rows.map((row) => browseItem(row, trending))
        if (res.value.indexing === true || res.value.complete === false) note = PARTIAL_TEXT
      }
      if (items.length > 0) out.push({ id, title: SHELF_TITLES[id], orderText: ORDER_TEXT[id], note, items })
    }
    return out
  }, [ready, browse, member, joined, followed, bindingKey, ownKey, blocked])

  const communityShelves = useMemo(() => {
    if (!ready || browse === null || browse.older) return NO_COMMUNITY_SHELVES
    const out = []
    COMMUNITY_SHELF_IDS.forEach((id, i) => {
      const res = browse.results[BROWSE_ORDERS.length + i]
      if (!res || res.ok !== true) return
      const items = visibleRows(res.value.communities, blocked).map(communityItem)
      const note = res.value.indexing === true || res.value.complete === false ? COMMUNITY_PARTIAL_TEXT : null
      if (items.length > 0) out.push({ id, title: COMMUNITY_SHELF_TITLES[id], orderText: COMMUNITY_ORDER_TEXT[id], note, items })
    })
    return out
  }, [ready, browse, blocked])

  return { shelves, communityShelves, reload }
}
