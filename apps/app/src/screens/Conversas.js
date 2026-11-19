// Conversas: the tab, one list of private conversations and community groups,
// newest first (WhatsApp/Telegram style). Rows come from conversas.js
// (mergeRows) over the existing reads: dm.list (rpc 5.77) for the inbox, and
// community.list (5.62) then community.info (5.59, at most INFO_AT_ONCE at a
// time) for the groups the person belongs to. A strip in the list header,
// under the chips, holds Pedidos (a dot, never a count; pushes nav 'pedidos',
// Mensagens.js) and Comunidades (pushes nav 'comunidades' to browse and
// create). Above the chips (Todas / Não lidas / Grupos) a search field filters the loaded rows
// (WhatsApp/Telegram); App.js draws the "+" in the top bar (`composing`, the
// NovaConversa sheet). Groups are counted as seen only by group.seen when
// a group opens (Grupo reports it as `seenTick`). dm.pull runs on mount, on
// pull to refresh and every PULL_EVERY_MS while visible; every pull and every
// dm.set bump node.dmVersion, which re-reads the inbox back to the depth
// already loaded (inboxPaging.js); a search pages through the rest of dm.list
// on the device, and Não lidas does the same while unread is still only on a
// later page. Reads carry a
// generation: an answer older than a newer read is dropped. Acting as a page,
// the inbox is the page's (useDmRequest) and its groups stay in Comunidades.
// The group rows paint the stored 'conversasGrupos' snapshot
// (../screenSnapshot.js) until the live reads answer, only for the member
// acting as the member; the inbox is never stored and shows when dm.list
// answers.
// Props: { active, onOpenGroup, onOpenCommunity, onOpenThread,
// onOpenCommunities, onOpenRequests, showInbox, seenTick, composing,
// onComposing, onGroupsUnread }.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { perfMarks, useNode } from '../node'
import { cacheGeneration } from '../localCaches'
import { useNames } from '../names'
import { fetchMember } from '../indexClient'
import { diaryPeekSlots } from '../engagement'
import { readPeerEntry } from '../peerProfile'
import { SEARCH_PAGES_MAX, SEARCH_PAGE_GAP_MS, mergeFirstPage, readDepth, settleRefresh, refreshDepth, searchPaging, unreadPaging } from '../inboxPaging'
import { groupsUnread, showNaoLidasEmpty } from '../conversasDot'
import { groupReadState } from '../noticeReads'
import { planRowPeeks, runRowPeeks } from '../rowPeek'
import { FILTERS, FILTER_LABELS, RECENT_MAX, applyFilter, conversasReadsAllowed, communitiesRow, mergeRows, oldKeyRow, requestsRow } from '../conversas'
import { ErrorText, Soft, errorText, useBottomPad, useNow } from '../ui'
import { Badge } from '../ui/Badge'
import { ConversationRow, personTitle } from '../ui/ConversationRow'
import { FilterChips } from '../ui/FilterChips'
import { HistoryImportedNote } from '../ui/HistoryCopy'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { SearchField } from '../ui/SearchField'
import { EmptyState as ListEmptyState, SkeletonRow } from '../ui/States'
import { layout, radius, space, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { NovaComunidade, bindingKeyOf, memberSnapshotBinding, readGroupSnapshot, sameSnapshotBinding, saveGroupSnapshot } from './Comunidades'
import { useActing } from './Conversa'
import { NovaConversa } from './NovaConversa'
import { heldOldKeys, oldPageKeys } from '../pageOldKeys'
import { LOCKED_TEXT, PageInboxNote, useDmRequest } from './Mensagens'
import { dmScreenGate } from '../coreDm'
import { CoreDmActivate, useCoreDm } from '../ui/useCoreDm'

export const PULL_EVERY_MS = 5 * 60 * 1000
export const INFO_AT_ONCE = 4
const SEARCH_SPENT_EMPTY = 'Nada encontrado nas conversas buscadas até agora. Há conversas mais antigas.'
const SEARCH_SPENT_MORE = 'Há conversas mais antigas que a busca ainda não leu.'
export const PARTIAL_TEXT = 'Algumas conversas ainda não carregaram.'
export const EMPTY_TEXT = 'Nenhuma conversa ainda'
const EMPTY_BODY = 'Toque em + para escrever para alguém ou criar uma comunidade.'
const MEMBER_ROLES = new Set(['creator', 'admin', 'member'])
const HEX64 = /^[0-9a-f]{64}$/
const LIST_DELAY_MS = 800
const SEARCH_PLACEHOLDER = 'Buscar conversas'
const RETRY_LABEL = 'Tentar de novo'
// The strip's short names; the spoken label keeps the full row title.
const STRIP_PARTS = {
  requests: { label: 'Pedidos', news: ', há pedidos novos' },
  communities: { label: 'Comunidades', news: ', há novidades' },
  'old-key': { label: 'Chave antiga', news: '' }
}

// Runs `work` over `items` with at most `limit` calls in flight.
async function eachLimited (items, limit, work) {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++]
      await work(item)
    }
  }
  const lanes = []
  for (let i = 0; i < Math.min(limit, items.length); i++) lanes.push(lane())
  await Promise.all(lanes)
}

const NO_GROUPS = { rows: [], loaded: false, loading: false, partial: false, error: '' }

// A stored row as the live read would give it, without last post or unread
// count (never stored). A private group has no stored name: mergeRows shows
// its placeholder until the live answer.
function seedRow (r, binding) {
  const row = { group: r.group, community: r.community, role: r.role, general: r.general, seeded: true, seedBinding: binding }
  if (r.name !== null) {
    if (r.general) row.title = r.name
    else row.name = r.name
  }
  return row
}

// The stored rows for `binding`, with loaded false so community.list and
// community.info still run and replace them; else no rows.
function seededGroups (binding) {
  const rows = readGroupSnapshot('conversasGrupos', binding)
  return rows === null ? NO_GROUPS : { ...NO_GROUPS, rows: rows.map((r) => seedRow(r, binding)), seeded: true }
}

// `rows` without the stored rows read for another binding: another
// installation, association or owner, even with the same key (its store was
// already wiped). Live rows stay.
export function seedsFor (rows, binding) {
  const out = rows.filter((r) => r.seeded !== true || sameSnapshotBinding(r.seedBinding, binding))
  return out.length === rows.length ? rows : out
}

// The live rows plus the stored rows of `missed` communities the live read
// did not list; a live row wins, one row per group.
function withMissedSeeds (live, shown, missed) {
  const listed = new Set(live.map((r) => r.group))
  return live.concat(shown.filter((r) => r.seeded === true && missed.has(r.community) && !listed.has(r.group)))
}

// The groups the person belongs to, flattened from each community.info with
// its community set (5.59 group rows carry none). Geral is titled by its
// community, the name people know it by. `binding`: memberSnapshotBinding,
// null for a page actor.
function useGroupRows ({ enabled, request, versions, seenTick, binding }) {
  const bindingRef = useRef(binding)
  bindingRef.current = binding
  const [state, setState] = useState(() => (enabled ? seededGroups(binding) : NO_GROUPS))
  const gen = useRef(0)
  const requestRef = useRef(request)
  requestRef.current = request
  const liveMarked = useRef(false)

  const load = useCallback(async () => {
    const mine = ++gen.current
    const cacheGen = cacheGeneration()
    const snapshotBinding = bindingRef.current
    setState((s) => ({ ...s, loading: true }))
    let communities
    let failed = false
    try {
      const res = await requestRef.current('community.list', {})
      failed = !res
      communities = Array.isArray(res && res.communities) ? res.communities : []
    } catch (err) {
      if (mine !== gen.current) return
      setState((s) => ({ ...s, loaded: true, loading: false, partial: true, failed: true, error: errorText(err) }))
      return
    }
    const wanted = communities.filter((c) => c && typeof c.community === 'string' && HEX64.test(c.community) &&
      c.state === 'ready' && MEMBER_ROLES.has(c.role))
    const rows = []
    // Communities whose community.info gave no groups or an incomplete list:
    // their stored rows the answer left out stay listed until a later read
    // answers for them in full.
    const missed = new Set()
    let partial = false
    await eachLimited(wanted, INFO_AT_ONCE, async (c) => {
      try {
        const info = await requestRef.current('community.info', { community: c.community })
        if (mine !== gen.current) return
        // Only a missing answer is unknown for the tab dot: an incomplete one still answered.
        if (!info) failed = true
        if (!info || info.incomplete === true) partial = true
        if (!info || info.incomplete === true) missed.add(c.community)
        const name = info && typeof info.name === 'string' && info.name !== '' ? info.name : (typeof c.name === 'string' ? c.name : '')
        for (const g of (info && Array.isArray(info.groups) ? info.groups : [])) {
          if (!g || typeof g.group !== 'string' || !MEMBER_ROLES.has(g.role)) continue
          const row = { ...g, community: c.community }
          if (g.general === true && name !== '') row.title = name
          rows.push(row)
        }
      } catch {
        partial = true
        missed.add(c.community)
        failed = true
      }
    })
    if (mine !== gen.current) return
    setState((s) => ({
      rows: partial ? withMissedSeeds(rows, s.rows, missed) : rows,
      loaded: true,
      loading: false,
      partial,
      failed,
      error: ''
    }))
    if (!liveMarked.current) {
      liveMarked.current = true
      perfMarks().mark('rows-live:conversas')
    }
    // Only a complete list: a partial one would drop the groups it missed.
    if (!partial && sameSnapshotBinding(snapshotBinding, bindingRef.current)) saveGroupSnapshot('conversasGrupos', snapshotBinding, rows, cacheGen)
  }, [])

  useEffect(() => {
    if (enabled) {
      // Enabled after the first render (the node became hosted): the stored
      // rows go up now, unless rows are already there.
      setState((s) => (s.loaded || s.rows.length > 0 ? s : seededGroups(bindingRef.current)))
      load()
    } else {
      gen.current++
      setState(NO_GROUPS)
    }
  }, [enabled, load])

  // memberSnapshotBinding is a new object each render: the effect follows
  // what it names.
  const bindingKey = bindingKeyOf(binding)
  useEffect(() => {
    setState((s) => {
      const rows = seedsFor(s.rows, bindingRef.current)
      return rows === s.rows ? s : { ...s, rows, seeded: rows.some((r) => r.seeded === true) }
    })
  }, [bindingKey])

  const seeded = state.seeded === true
  useEffect(() => {
    if (seeded) perfMarks().mark('rows-snapshot:conversas')
  }, [seeded])

  // Unread counts move with group.seen (no event) and groups.changed (a
  // burst of events costs one read).
  const firstTick = useRef(seenTick)
  useEffect(() => {
    if (!enabled || seenTick === firstTick.current) return
    firstTick.current = seenTick
    load()
  }, [enabled, seenTick, load])
  const firstVersions = useRef(versions)
  useEffect(() => {
    if (!enabled || versions === firstVersions.current) return
    firstVersions.current = versions
    const timer = setTimeout(load, LIST_DELAY_MS)
    return () => clearTimeout(timer)
  }, [enabled, versions, load])

  return { ...state, load }
}

// The keys a moved Página held before, with conversations this device can
// read (pageOldKeys.js). Only while acting as a Página; a slow answer for
// another Página or an older version is dropped by the generation.
function useOldKeys ({ enabled, request, pageKey, dmVersion }) {
  const [state, setState] = useState({ page: null, keys: [] })
  const gen = useRef(0)
  const chains = useRef(new Map())
  useEffect(() => {
    const mine = ++gen.current
    if (!enabled) {
      setState((cur) => (cur.keys.length === 0 ? cur : { page: null, keys: [] }))
      return
    }
    ;(async () => {
      try {
        // The verified chain does not change: only a non-empty one is kept.
        let chain = chains.current.get(pageKey)
        if (!chain) {
          chain = await oldPageKeys(request, pageKey)
          if (chain.length > 0) chains.current.set(pageKey, chain)
        }
        const keys = await heldOldKeys(request, chain)
        if (mine === gen.current) setState({ page: pageKey, keys })
      } catch {}
    })()
  }, [enabled, request, pageKey, dmVersion])
  return useMemo(() => (state.page === pageKey && pageKey !== null ? state.keys : NO_KEYS), [state, pageKey])
}

const NO_KEYS = []

// The inbox folder of dm.list, paged like the old Mensagens list.
function useInbox ({ ready, dm, dmVersion, pageKey, needle }) {
  const [state, setState] = useState({ rows: [], next: null, requests: false, inboxUnread: false, loaded: false, error: '' })
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageError, setPageError] = useState('')
  const gen = useRef(0)
  const nextRef = useRef(state.next)
  nextRef.current = state.next
  // Pages on screen, and the depth the newest refresh set out to read: a
  // refresh that overlaps another never reads fewer pages than either.
  const depthRef = useRef(1)
  const wantRef = useRef(0)

  const list = useCallback(async () => {
    const mine = ++gen.current
    const depth = refreshDepth(depthRef.current, wantRef.current)
    wantRef.current = depth
    let first
    try {
      first = await dm('dm.list', { folder: 'inbox' })
    } catch (err) {
      if (mine !== gen.current) return
      setState((s) => ({ ...s, loaded: true, error: errorText(err) }))
      return
    }
    if (mine !== gen.current) return
    const rows = Array.isArray(first.conversations) ? first.conversations : []
    const requests = first.requests === true
    const inboxUnread = first.inboxUnread === true
    if (depth <= 1) {
      depthRef.current = 1
      setState({ rows, next: first.next || null, requests, inboxUnread, loaded: true, error: '' })
      setPageError('')
      return
    }
    // The fresh first page goes up over the loaded rows at once; the deeper
    // pages are read again and swapped in a single time, so the list never
    // empties or shrinks while the walk runs.
    setState((s) => ({ ...s, rows: mergeFirstPage(s.rows, rows), requests, inboxUnread, loaded: true, error: '' }))
    setPageError('')
    try {
      const deep = await readDepth({
        first,
        depth,
        read: (cursor) => dm('dm.list', { folder: 'inbox', before: cursor }),
        current: () => mine === gen.current
      })
      if (deep === null) return
      const loadedDepth = depthRef.current
      depthRef.current = settleRefresh({ rows: [], next: null }, deep, loadedDepth).depth
      wantRef.current = deep.depth
      setState((s) => {
        const out = settleRefresh(s, deep, loadedDepth)
        return { ...s, rows: out.rows, next: out.next, requests, inboxUnread, loaded: true, error: '' }
      })
    } catch (err) {
      if (mine !== gen.current) return
      wantRef.current = depthRef.current
      setPageError(errorText(err))
    }
  }, [dm])

  // Another acting identity is another inbox: the old rows never stay.
  const seenPage = useRef(pageKey)
  useEffect(() => {
    if (seenPage.current === pageKey) return
    seenPage.current = pageKey
    gen.current++
    depthRef.current = 1
    wantRef.current = 0
    setState({ rows: [], next: null, requests: false, inboxUnread: false, loaded: false, error: '' })
    setPageError('')
  }, [pageKey])

  useEffect(() => {
    if (ready) list()
  }, [ready, dmVersion, list])

  // One page at a time; a failed page waits for the footer retry or a pull.
  // -> 'ok', 'error', 'busy' (a page is already coming), 'stale' (a refresh
  // moved the list under it) or 'none' (no next page).
  const busy = useRef(false)
  const loadMore = useCallback(async () => {
    const mine = gen.current
    const cursor = nextRef.current
    if (!cursor) return 'none'
    if (busy.current) return 'busy'
    let result = 'ok'
    busy.current = true
    setLoadingMore(true)
    setPageError('')
    try {
      const r = await dm('dm.list', { folder: 'inbox', before: cursor })
      if (mine === gen.current && cursor === nextRef.current) {
        const page = Array.isArray(r.conversations) ? r.conversations : []
        // The state, not the ref, decides: a first page that landed before this
        // render moved `next`, and this older page no longer belongs after it.
        setState((s) => {
          if (s.next !== cursor) return s
          const have = new Set(s.rows.map((row) => row.peer))
          return { ...s, rows: s.rows.concat(page.filter((row) => row && !have.has(row.peer))), next: r.next || null }
        })
        depthRef.current += 1
      } else {
        result = 'stale'
      }
    } catch (err) {
      // A refresh that moved the list under this page owns the error state now.
      if (mine === gen.current) {
        setPageError(errorText(err))
        result = 'error'
      } else {
        result = 'stale'
      }
    }
    busy.current = false
    setLoadingMore(false)
    return result
  }, [dm])

  // A search covers the whole inbox, not only the pages loaded: while text is
  // typed (`needle`, empty when no search is on or the tab is off screen) and more pages
  // exist, page through the rest on the device, one page at a time with a
  // pause between them. Changing the text, clearing it, leaving the screen or
  // an error ends the walk; the budget is kept across keystrokes and starts
  // over only when the search ends.
  const [paging, setPaging] = useState(false)
  const spent = useRef(0)
  const [walkRound, setWalkRound] = useState(0)
  // The person asks to go on after the budget ran out: a new budget.
  const searchMore = useCallback(() => {
    spent.current = 0
    setWalkRound((n) => n + 1)
  }, [])
  const hasNext = state.next !== null
  useEffect(() => {
    if (needle === '') spent.current = 0
    if (!ready || needle === '' || !hasNext) return undefined
    const run = { alive: true }
    let failed = false
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const walk = async () => {
      setPaging(true)
      while (run.alive && searchPaging({ needle, next: nextRef.current, pages: spent.current, failed })) {
        spent.current++
        if (await loadMore() === 'error') failed = true
        if (!run.alive) return
        await wait(SEARCH_PAGE_GAP_MS)
      }
      if (run.alive) setPaging(false)
    }
    walk()
    return () => {
      run.alive = false
      setPaging(false)
    }
  }, [ready, needle, hasNext, pageKey, loadMore, walkRound])

  const searchSpent = needle !== '' && hasNext && !paging && spent.current >= SEARCH_PAGES_MAX
  // The Não lidas walk reads the newest cursor through the ref, not a stale closure.
  return { ...state, list, loadMore, loadingMore, pageError, paging: paging && needle !== '' && !pageError, searchSpent, searchMore, nextRef }
}

function matches (text, query) {
  return typeof text === 'string' && text.toLocaleLowerCase('pt-BR').includes(query)
}

export function Conversas ({
  active, onOpenGroup, onOpenCommunity, onOpenThread, onOpenCommunities, onOpenRequests, onOpenOldKey, showInbox = 0, seenTick = 0,
  composing = false, onComposing, onGroupsUnread
}) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const bottomPad = useBottomPad()
  const now = useNow(60000)
  const hosted = node.hosted === true
  const unlocked = !!(node.passkey && node.passkey.status && node.passkey.status.unlocked === true)
  const { dm, pageKey } = useDmRequest()
  // A core node reads and writes its Conversas once its engine answers.
  const core = useCoreDm(node)
  const gate = dmScreenGate({ hosted, unlocked, core: core.state })
  const ready = gate.ready
  const bumpDm = node.bumpDm
  const [filter, setFilter] = useState('todas')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Set while rendering: the effects below must see the first show in the
  // same pass that makes the tab active.
  const shownOnce = useRef(false)
  if (active) shownOnce.current = true
  const allowed = conversasReadsAllowed({ active, shownOnce: shownOnce.current })

  // Search text reaches the inbox only while the tab is on screen: leaving it ends the paging.
  const inbox = useInbox({ ready: ready && allowed, dm, dmVersion: node.dmVersion, pageKey, needle: active ? query.trim().toLocaleLowerCase('pt-BR') : '' })
  const acting = useActing()
  const oldKeys = useOldKeys({ enabled: ready && allowed && pageKey !== null, request: node.request, pageKey, dmVersion: node.dmVersion })
  const snapshotBinding = memberSnapshotBinding({ node, acting, pageKey })
  const groups = useGroupRows({ enabled: hosted && allowed && pageKey === null, request: node.request, versions: node.groupVersions, seenTick, binding: snapshotBinding })
  // Only a finished member read may say no group is unread. A Página has no groups here.
  useEffect(() => {
    if (pageKey !== null) return
    if (typeof onGroupsUnread !== 'function') return
    if (!groups.loaded || groups.loading) return
    const complete = groups.loaded && !groups.loading && !groups.failed && !groups.error
    onGroupsUnread(groupsUnread(mergeRows({ groups: groups.rows }), { complete }), groupReadState(groups))
  }, [pageKey, onGroupsUnread, groups.rows, groups.loaded, groups.loading, groups.failed, groups.error, groups.partial])

  // A pull that failed may still have filed messages: read again either way.
  const pull = useCallback(async () => {
    try { await dm('dm.pull', {}) } catch {}
    if (typeof bumpDm === 'function') bumpDm()
    else await inbox.list()
  }, [dm, bumpDm, inbox.list])
  const pullRef = useRef(pull)
  pullRef.current = pull

  // The pull is how waiting messages are found (the shell's dot reads the
  // local inbox), so it must not wait for the tab to be opened: it waits only
  // for the boot to go quiet, then runs as before.
  const [quiet, setQuiet] = useState(false)
  const nodeWhenIdle = node.whenIdle
  useEffect(() => {
    if (!ready || quiet || allowed || typeof nodeWhenIdle !== 'function') return
    let alive = true
    const wait = nodeWhenIdle(4000)
    wait.promise.then(() => { if (alive) setQuiet(true) }, () => {})
    return () => {
      alive = false
      wait.cancel()
    }
  }, [ready, quiet, allowed, nodeWhenIdle])
  const pulls = allowed || quiet

  const enabled = useRef(false)
  useEffect(() => {
    if (!ready || !pulls) return
    let alive = true
    const start = async () => {
      if (!enabled.current) {
        enabled.current = true
        // Starts the wallet top-up early; the first send calls it again.
        try { await dm('dm.enable', {}) } catch { enabled.current = false }
      }
      if (alive) pullRef.current()
    }
    start()
    return () => { alive = false }
  }, [ready, pulls, dm, node.epoch])

  // Runs only while the app is visible; hiding it clears the timer.
  const visible = node.visible !== false
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  useEffect(() => {
    if (!ready || !pulls || !visible) return
    const timer = setInterval(() => {
      if (visibleRef.current) pullRef.current()
    }, PULL_EVERY_MS)
    return () => clearInterval(timer)
  }, [ready, pulls, visible])

  // Back on screen (the tab chosen, or a pushed thread closed): read again.
  const wasActive = useRef(active)
  // The first show is read by the gated effects above (allowed flips with
  // it); reading here too would send every list twice.
  const shownBefore = useRef(active)
  const groupsLoad = groups.load
  const inboxList = inbox.list
  useEffect(() => {
    const back = active && !wasActive.current
    wasActive.current = active
    if (!back) return
    if (!shownBefore.current) {
      shownBefore.current = true
      return
    }
    if (ready) inboxList()
    if (hosted && pageKey === null) groupsLoad()
  }, [active, ready, hosted, pageKey, inboxList, groupsLoad])

  // A push wake shows the whole inbox, whatever filter or search was on
  // screen (App.js pops the stack, the request folder included).
  const lastShow = useRef(showInbox)
  useEffect(() => {
    if (lastShow.current === showInbox) return
    lastShow.current = showInbox
    setFilter('todas')
    setQuery('')
  }, [showInbox])

  const names = useNames()
  const { resolveMany, profileOf, learnVerified, forgetVerified, isPeeked, peekScope } = names
  const peers = useMemo(() => inbox.rows.map((r) => r.peer), [inbox.rows])
  useEffect(() => {
    if (peers.length > 0) resolveMany(peers)
  }, [peers, resolveMany])

  const merged = useMemo(() => mergeRows({ dmConversations: ready ? inbox.rows : [], groups: groups.rows }), [ready, inbox.rows, groups.rows])
  // While older private conversations wait on a later dm.list page, a group
  // older than the oldest loaded one would sit above conversations nobody
  // has seen yet, and those would then land above it. Hold such groups back
  // until the inbox catches up. Não lidas, Grupos and a search list every
  // group: there an unread group must never wait behind unloaded pages.
  // A stored group row has no time: it stays listed (after the dated rows)
  // until community.info replaces it.
  const storedGroupIds = useMemo(() => new Set(groups.rows.filter((r) => r.seeded === true).map((r) => r.group)), [groups.rows])
  const paged = useMemo(() => {
    if (!ready || !inbox.next || inbox.rows.length === 0) return merged
    const oldest = Date.parse(inbox.rows[inbox.rows.length - 1].at)
    if (!Number.isFinite(oldest)) return merged
    return merged.filter((row) => {
      if (row.kind !== 'group' || storedGroupIds.has(row.group)) return true
      const at = row.at === null ? NaN : Date.parse(row.at)
      return Number.isFinite(at) && at >= oldest
    })
  }, [merged, ready, inbox.next, inbox.rows, storedGroupIds])
  const needle = query.trim().toLocaleLowerCase('pt-BR')
  // A search keeps the chip: both narrow the same loaded rows.
  const data = useMemo(() => {
    if (needle !== '') {
      return applyFilter(merged.filter((row) => {
        const title = row.kind === 'dm' ? personTitle(profileOf(row.peer)) : row.title
        return matches(title, needle) || matches(row.subtitle, needle)
      }), filter)
    }
    const rows = filter === 'todas' ? paged : merged
    return applyFilter(rows, filter)
  }, [merged, paged, needle, filter, profileOf])
  // A pending Pedidos stays in every chip and during a search. With none
  // waiting, it follows the chip, and a search still hides the whole strip.
  // Old keys and Comunidades always follow the chip and step aside for a search.
  const pinned = useMemo(() => {
    const filtered = needle !== '' ? [] : applyFilter([requestsRow({ requests: inbox.requests }), ...oldKeys.map(oldKeyRow), communitiesRow()], filter)
    if (!inbox.requests) return filtered
    return filtered.some((row) => row.kind === 'requests') ? filtered : [requestsRow({ requests: true }), ...filtered]
  }, [needle, filter, inbox.requests, oldKeys])
  // Loaded unread rows, not the pinned Pedidos row: that one must not stop the walk.
  const unreadLoaded = useMemo(() => applyFilter(merged, 'nao-lidas').filter((row) => row.kind !== 'requests').length, [merged])
  const unreadLoadedRef = useRef(0)
  unreadLoadedRef.current = unreadLoaded
  const [unreadPagingNow, setUnreadPagingNow] = useState(false)
  const unreadPages = useRef(0)
  const unreadFor = useRef({ filter, pageKey })
  const [unreadRound, setUnreadRound] = useState(0)
  // The person asks to go on after the budget ran out: a new budget.
  const unreadMore = useCallback(() => {
    unreadPages.current = 0
    setUnreadRound((n) => n + 1)
  }, [])
  const inboxHasNext = inbox.next !== null
  const pageError = inbox.pageError
  // While Não lidas has no unread row loaded but the inbox has some, the walk owns
  // paging: the list's own loader would pause after a few dry pages and say so.
  const unreadWalkOwns = filter === 'nao-lidas' && needle === '' && unreadLoaded === 0 && inbox.inboxUnread === true
  const nextRef = inbox.nextRef
  const loadMoreInbox = inbox.loadMore
  useEffect(() => {
    // Another chip or another Página starts a new budget. unreadMore resets it itself.
    const leftChip = unreadFor.current.filter === 'nao-lidas' && filter !== 'nao-lidas'
    const otherInbox = unreadFor.current.pageKey !== pageKey
    if (leftChip || otherInbox) unreadPages.current = 0
    unreadFor.current = { filter, pageKey }
    // A failed page waits for the footer retry; its success clears pageError and resumes the walk.
    if (!ready || !active || filter !== 'nao-lidas' || needle !== '' || !inboxHasNext || pageError) return undefined
    const run = { alive: true }
    let failed = false
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const walk = async () => {
      setUnreadPagingNow(true)
      while (run.alive && unreadPaging({
        filter,
        unreadRows: unreadLoadedRef.current,
        inboxUnread: inbox.inboxUnread,
        next: nextRef.current,
        pages: unreadPages.current,
        failed
      })) {
        const got = await loadMoreInbox()
        if (got === 'error') failed = true
        // A page someone else is already fetching is not a page this walk read.
        if (got !== 'busy') unreadPages.current++
        if (!run.alive) return
        await wait(SEARCH_PAGE_GAP_MS)
      }
      if (run.alive) setUnreadPagingNow(false)
    }
    walk()
    return () => {
      run.alive = false
      setUnreadPagingNow(false)
    }
  }, [ready, active, filter, needle, inboxHasNext, inbox.inboxUnread, unreadLoaded, loadMoreInbox, nextRef, unreadRound, pageKey, pageError])
  const unreadSpent = filter === 'nao-lidas' && needle === '' && inboxHasNext && !unreadPagingNow && unreadPages.current >= SEARCH_PAGES_MAX && unreadLoaded === 0 && inbox.inboxUnread === true
  // The sheet's "Conversas recentes": the loaded private conversations,
  // newest first (mergeRows order).
  const recent = useMemo(() => merged.filter((row) => row.kind === 'dm').slice(0, RECENT_MAX).map((row) => row.peer), [merged])

  // A person the node has no profile for (not followed) is named in the list
  // the way an open conversation names its header: the index hints, then a
  // node-verified diary.peek (rowPeek.js). Only the rows near the top, once per
  // scope, one at a time, and only while this tab is on screen and online;
  // the core node refuses the peek and the row keeps "Pessoa".
  const rowPeers = useMemo(() => data.filter((row) => row.kind === 'dm').map((row) => row.peer), [data])
  const peekLatest = useRef({})
  peekLatest.current = { rowPeers, profileOf, isPeeked, learnVerified, forgetVerified, request: node.request, peekScope }
  const peekTried = useRef(new Set())
  const peekRun = useRef(0)
  const peekActive = useRef(null)
  const peekGate = hosted && ready && active && node.visible !== false && node.online !== false
  useEffect(() => {
    if (!peekGate) {
      peekRun.current++
      peekActive.current = null
      return undefined
    }
    const scope = peekLatest.current.peekScope
    // A walk of this scope is already running and re-plans on its own.
    if (peekActive.current !== null && peekActive.current.scope === scope) return undefined
    const run = ++peekRun.current
    const current = () => peekRun.current === run && peekLatest.current.peekScope === scope
    peekActive.current = { run, scope }
    runRowPeeks({
      plan: () => planRowPeeks({ peers: peekLatest.current.rowPeers, profileOf: peekLatest.current.profileOf, isPeeked: peekLatest.current.isPeeked, tried: peekTried.current, scope }),
      tried: peekTried.current,
      scope,
      read: (peer) => readPeerEntry(peer, {
        fetchMember,
        peek: (params) => diaryPeekSlots.run(() => current() ? peekLatest.current.request('diary.peek', params) : null, { front: true })
      }),
      current,
      learn: (peer, entry) => peekLatest.current.learnVerified([[peer, entry]], scope),
      forget: (peer) => peekLatest.current.forgetVerified([peer], scope)
    }).then(() => {
      if (peekActive.current !== null && peekActive.current.run === run) peekActive.current = null
    })
    return undefined
  }, [peekGate, rowPeers, peekScope])
  useEffect(() => () => { peekRun.current++ }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([
        ready ? pull() : null,
        hosted && pageKey === null ? groupsLoad() : null
      ])
    } finally {
      setRefreshing(false)
    }
  }, [ready, hosted, pageKey, pull, groupsLoad])

  const closeCompose = useCallback(() => {
    if (typeof onComposing === 'function') onComposing(false)
  }, [onComposing])
  const EmptyState = useCallback((props) => (
    <ListEmptyState
      actionLabel='Todas'
      onAction={() => setFilter('todas')}
      secondaryLabel='Nova conversa'
      onSecondary={typeof onComposing === 'function' ? () => onComposing(true) : undefined}
      {...props}
    />
  ), [onComposing])

  const sheets = (
    <>
      <NovaConversa
        open={composing === true}
        onClose={closeCompose}
        onOpenThread={(peer) => onOpenThread(peer)}
        recent={recent}
        onNewCommunity={pageKey === null ? () => setCreating(true) : undefined}
        onNewGroup={typeof onOpenCommunities === 'function' ? () => onOpenCommunities() : undefined}
      />
      <NovaComunidade
        visible={creating}
        onClose={() => { setCreating(false); groupsLoad() }}
        onUncertain={groupsLoad}
        onCreated={(community) => {
          setCreating(false)
          groupsLoad()
          if (typeof onOpenCommunity === 'function') onOpenCommunity(community)
        }}
      />
    </>
  )

  if (gate.activate) return <View style={styles.root}><CoreDmActivate core={core} style={styles.pad} /></View>
  if (!hosted && !ready) return <View style={styles.root}><View>{[0, 1, 2].map((key) => <SkeletonRow key={key} />)}</View></View>

  const items = data.filter((row) => row.kind === 'dm' || row.kind === 'group')
  const dmLoaded = !ready || inbox.loaded
  // A core node lists no groups here.
  const loaded = dmLoaded && (pageKey !== null || !hosted || groups.loaded)
  const dmFailed = ready && inbox.error !== ''
  const groupsFailed = hosted && pageKey === null && groups.error !== ''
  const partial = loaded && (dmFailed || groupsFailed || (hosted && pageKey === null && groups.partial))

  const header = (
    <View>
      <PageInboxNote pageKey={pageKey} />
      <HistoryImportedNote />
      <View style={styles.search}>
        <SearchField
          label='buscar conversas'
          clearLabel='limpar busca'
          placeholder={SEARCH_PLACEHOLDER}
          value={query}
          onChangeText={setQuery}
        />
      </View>
      <FilterChips options={FILTERS.map((id) => ({ id, label: FILTER_LABELS[id] }))} selected={filter} onSelect={setFilter} />
      {gate.locked ? <View style={styles.pad}><Soft>{LOCKED_TEXT}</Soft></View> : null}
      {partial
        ? (
          <View style={styles.pad}>
            <Soft>{PARTIAL_TEXT}</Soft>
            {dmFailed ? <ErrorText>{inbox.error}</ErrorText> : null}
            {groupsFailed ? <ErrorText>{groups.error}</ErrorText> : null}
            <Pill label={RETRY_LABEL} onPress={refresh} />
          </View>
          )
        : null}
      {pinned.length > 0
        ? (
          <View style={styles.strip}>
            {pinned.map((item, i) => (
              <Fragment key={item.key}>
                {i > 0 ? <Text style={styles.stripSep} aria-hidden importantForAccessibility='no' accessibilityElementsHidden>·</Text> : null}
                {item.kind === 'requests'
                  ? <StripPart kind='requests' title={item.title} dot={item.unread === true} onPress={() => { if (typeof onOpenRequests === 'function') onOpenRequests() }} />
                  : item.kind === 'old-key'
                    ? <StripPart kind='old-key' title={item.title} dot={false} onPress={() => { if (typeof onOpenOldKey === 'function') onOpenOldKey(item.page) }} />
                    : <StripPart kind='communities' title={item.title} dot={item.unread === true} onPress={() => { if (typeof onOpenCommunities === 'function') onOpenCommunities() }} />}
              </Fragment>
            ))}
          </View>
          )
        : null}
    </View>
  )

  // A failed older page comes first: under a chip that leaves no loaded row,
  // the older (maybe unread) conversations are only reachable through it.
  let footer = null
  if (!loaded) footer = <View>{[0, 1, 2].map((key) => <SkeletonRow key={key} />)}</View>
  else if (inbox.pageError) {
    footer = (
      <View style={styles.pad}>
        <Soft>{PARTIAL_TEXT}</Soft>
        <ErrorText>{inbox.pageError}</ErrorText>
        <Pill label={RETRY_LABEL} onPress={() => inbox.loadMore()} />
      </View>
    )
  } else if (needle !== '' && inbox.paging) {
    // The search is still paging through older conversations: the same
    // skeleton as a first load, never "nada encontrado" while pages remain.
    footer = <View accessible accessibilityLabel='Buscando conversas' accessibilityLiveRegion='polite'>{[0, 1].map((key) => <SkeletonRow key={key} />)}</View>
  } else if (needle !== '' && inbox.searchSpent) {
    // The walk spent its budget with older conversations still unread: say so
    // and let the person go on, never "nada encontrado" while pages remain.
    footer = (
      <View style={styles.pad}>
        <Soft>{items.length === 0 ? SEARCH_SPENT_EMPTY : SEARCH_SPENT_MORE}</Soft>
        <Pill label='Buscar mais' onPress={() => inbox.searchMore()} />
      </View>
    )
  } else if (filter === 'nao-lidas' && needle === '' && unreadPagingNow && unreadLoaded === 0) {
    // The walk is still paging toward an unread row: never "nada novo" while it runs.
    footer = <View accessible accessibilityLabel='Buscando conversas não lidas' accessibilityLiveRegion='polite'>{[0, 1].map((key) => <SkeletonRow key={key} />)}</View>
  } else if (unreadSpent) {
    footer = (
      <View style={styles.pad}>
        <Soft>Ainda há conversas não lidas mais antigas.</Soft>
        <Pill label='Buscar mais' onPress={() => unreadMore()} />
      </View>
    )
  } else if (items.length === 0 && !partial && (ready || needle !== '' || filter === 'grupos')) {
    if (needle !== '') footer = <EmptyState icon='conversas' title='Nenhuma conversa encontrada.' actionLabel='Limpar busca' onAction={() => setQuery('')} />
    else if (filter === 'todas') footer = <EmptyState icon='conversas' title={EMPTY_TEXT} body={EMPTY_BODY} actionLabel={typeof onComposing === 'function' ? 'Nova conversa' : undefined} onAction={typeof onComposing === 'function' ? () => onComposing(true) : undefined} secondaryLabel='Nova comunidade' onSecondary={pageKey === null ? () => setCreating(true) : undefined} />
    else if (filter === 'grupos') footer = <EmptyState icon='gente' title='Nenhum grupo ainda' body='Os grupos das suas comunidades aparecem aqui.' actionLabel='Comunidades' onAction={onOpenCommunities} secondaryLabel='Nova comunidade' onSecondary={pageKey === null ? () => setCreating(true) : undefined} />
    else if (showNaoLidasEmpty({ rows: items, requests: inbox.requests, more: inbox.next !== null, inboxUnread: inbox.inboxUnread })) footer = <EmptyState icon='conversas' title='Nada novo por aqui' />
  }

  const renderItem = ({ item }) => {
    if (item.kind === 'dm') {
      return (
        <ConversationRow
          item={{ kind: 'dm', key: item.peer, preview: item.subtitle, mine: item.mine, at: item.at, unread: item.unread }}
          now={now}
          onPress={() => onOpenThread(item.peer)}
        />
      )
    }
    return (
      <ConversationRow
        item={{ kind: 'group', key: item.group, name: item.title, preview: item.subtitle, mine: item.mine, at: item.at, unread: item.unread }}
        now={now}
        onPress={() => onOpenGroup(item.group)}
      />
    )
  }

  return (
    <View style={styles.root}>
      <RefreshableList
        perfId='conversas'
        data={data}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        extraData={{ now, names: profileOf }}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={refresh}
        refreshing={refreshing}
        onLoadMore={ready && needle === '' && !unreadWalkOwns && inbox.next && !inbox.loadingMore && !inbox.pageError ? inbox.loadMore : undefined}
        loadingMore={inbox.loadingMore}
        loadMoreError={inbox.pageError || undefined}
        atEnd={!ready || !inbox.next}
      />
      {sheets}
    </View>
  )
}

// One part of the Pedidos · Comunidades strip: its own 44 pt target, spoken
// by the full row title. Pedidos shows a dot for news, never a count.
function StripPart ({ kind, title, dot, onPress }) {
  const styles = useStyles(makeStyles)
  const part = STRIP_PARTS[kind]
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={title + (dot ? part.news : '')}
      onPress={onPress}
      style={({ pressed }) => [styles.stripPart, pressed && styles.pressed]}
    >
      <Text style={styles.stripLabel} numberOfLines={1}>{part.label}</Text>
      {dot ? <Badge /> : null}
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pad: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  // The shared field draws the pill. This screen still insets it with the row gutter.
  search: { marginHorizontal: space.lg, marginVertical: space.sm },
  pressed: { backgroundColor: colors.line },
  // The strip's inset plus a part's own padding put the labels on the row gutter.
  strip: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', paddingHorizontal: space.lg - space.sm },
  stripPart: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, minHeight: layout.hit, minWidth: layout.hit, paddingHorizontal: space.sm, borderRadius: radius.sm },
  stripLabel: { ...type.more, color: colors.ink },
  stripSep: { ...type.more, color: colors.soft }
})
