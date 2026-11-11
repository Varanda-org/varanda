// Conversas: the tab, one list of private conversations and community groups,
// newest first (WhatsApp/Telegram style). Rows come from conversas.js
// (mergeRows) over the existing reads: dm.list (rpc 5.77) for the inbox, and
// community.list (5.62) then community.info (5.59, at most INFO_AT_ONCE at a
// time) for the groups the person belongs to. Pinned above them: Pedidos de
// mensagem (a dot, never a count; pushes nav 'pedidos', Mensagens.js) and
// Comunidades (pushes nav 'comunidades' to browse and create). Above the
// chips (Todas / Não lidas / Grupos) a search field filters the loaded rows
// (WhatsApp/Telegram); App.js draws the "+" in the top bar (`composing`, the
// NovaConversa sheet). Groups are counted as seen only by group.seen when
// a group opens (Grupo reports it as `seenTick`). dm.pull runs on mount, on
// pull to refresh and every PULL_EVERY_MS while visible; every pull and every
// dm.set bump node.dmVersion, which re-reads the inbox. Reads carry a
// generation: an answer older than a newer read is dropped. Acting as a page,
// the inbox is the page's (useDmRequest) and its groups stay in Comunidades.
// The group rows paint the stored 'conversasGrupos' snapshot
// (../screenSnapshot.js) until the live reads answer, only for the member
// acting as the member; the inbox is never stored and shows when dm.list
// answers.
// Props: { active, onOpenGroup, onOpenCommunity, onOpenThread,
// onOpenCommunities, onOpenRequests, showInbox, seenTick, composing,
// onComposing }.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { perfMarks, useNode } from '../node'
import { cacheGeneration } from '../localCaches'
import { useNames } from '../names'
import { FILTERS, FILTER_LABELS, RECENT_MAX, applyFilter, conversasReadsAllowed, communitiesRow, mergeRows, requestsRow } from '../conversas'
import { ErrorText, Soft, errorText, useBottomPad, useNow } from '../ui'
import { ConversationRow, personTitle } from '../ui/ConversationRow'
import { FilterChips } from '../ui/FilterChips'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, Skeleton } from '../ui/States'
import { layout, radius, space, type, webInputReset } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { NovaComunidade, memberSnapshotBinding, readGroupSnapshot, sameSnapshotBinding, saveGroupSnapshot } from './Comunidades'
import { useActing } from './Conversa'
import { NovaConversa } from './NovaConversa'
import { LOCKED_TEXT, PageInboxNote, useDmRequest } from './Mensagens'

export const PULL_EVERY_MS = 5 * 60 * 1000
export const INFO_AT_ONCE = 4
export const PARTIAL_TEXT = 'Algumas conversas ainda não carregaram.'
export const EMPTY_TEXT = 'Nenhuma conversa ainda'
const EMPTY_BODY = 'Toque em + para escrever para alguém ou criar uma comunidade.'
const MEMBER_ROLES = new Set(['creator', 'admin', 'member'])
const HEX64 = /^[0-9a-f]{64}$/
const LIST_DELAY_MS = 800
const SEARCH_PLACEHOLDER = 'Buscar conversas'
// ConversationRow's avatar width, so pinned titles start where row titles do.
const AVATAR_COLUMN = 48
const PINNED_HEIGHT = 56

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
function seedRow (r) {
  const row = { group: r.group, community: r.community, role: r.role, general: r.general, seeded: true }
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
  return rows === null ? NO_GROUPS : { ...NO_GROUPS, rows: rows.map(seedRow), seeded: true }
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
    try {
      const res = await requestRef.current('community.list', {})
      communities = Array.isArray(res && res.communities) ? res.communities : []
    } catch (err) {
      if (mine !== gen.current) return
      setState((s) => ({ ...s, loaded: true, loading: false, partial: true, error: errorText(err) }))
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
      }
    })
    if (mine !== gen.current) return
    setState((s) => ({
      rows: partial ? withMissedSeeds(rows, s.rows, missed) : rows,
      loaded: true,
      loading: false,
      partial,
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

// The inbox folder of dm.list, paged like the old Mensagens list.
function useInbox ({ ready, dm, dmVersion, pageKey }) {
  const [state, setState] = useState({ rows: [], next: null, requests: false, loaded: false, error: '' })
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageError, setPageError] = useState('')
  const gen = useRef(0)
  const nextRef = useRef(state.next)
  nextRef.current = state.next

  const list = useCallback(async () => {
    const mine = ++gen.current
    try {
      const r = await dm('dm.list', { folder: 'inbox' })
      if (mine !== gen.current) return
      setState({ rows: Array.isArray(r.conversations) ? r.conversations : [], next: r.next || null, requests: r.requests === true, loaded: true, error: '' })
      setPageError('')
    } catch (err) {
      if (mine !== gen.current) return
      setState((s) => ({ ...s, loaded: true, error: errorText(err) }))
    }
  }, [dm])

  // Another acting identity is another inbox: the old rows never stay.
  const seenPage = useRef(pageKey)
  useEffect(() => {
    if (seenPage.current === pageKey) return
    seenPage.current = pageKey
    gen.current++
    setState({ rows: [], next: null, requests: false, loaded: false, error: '' })
    setPageError('')
  }, [pageKey])

  useEffect(() => {
    if (ready) list()
  }, [ready, dmVersion, list])

  // One page at a time; a failed page waits for the footer retry or a pull.
  const busy = useRef(false)
  const loadMore = useCallback(async () => {
    const mine = gen.current
    const cursor = nextRef.current
    if (!cursor || busy.current) return
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
      }
    } catch (err) {
      if (mine === gen.current) setPageError(errorText(err))
    }
    busy.current = false
    setLoadingMore(false)
  }, [dm])

  return { ...state, list, loadMore, loadingMore, pageError }
}

function matches (text, query) {
  return typeof text === 'string' && text.toLocaleLowerCase('pt-BR').includes(query)
}

export function Conversas ({
  active, onOpenGroup, onOpenCommunity, onOpenThread, onOpenCommunities, onOpenRequests, showInbox = 0, seenTick = 0,
  composing = false, onComposing
}) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const bottomPad = useBottomPad()
  const now = useNow(60000)
  const hosted = node.hosted === true
  const unlocked = !!(node.passkey && node.passkey.status && node.passkey.status.unlocked === true)
  const { dm, pageKey } = useDmRequest()
  const ready = hosted && unlocked
  const bumpDm = node.bumpDm
  const [filter, setFilter] = useState('todas')
  const [query, setQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [creating, setCreating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Set while rendering: the effects below must see the first show in the
  // same pass that makes the tab active.
  const shownOnce = useRef(false)
  if (active) shownOnce.current = true
  const allowed = conversasReadsAllowed({ active, shownOnce: shownOnce.current })

  const inbox = useInbox({ ready: ready && allowed, dm, dmVersion: node.dmVersion, pageKey })
  const acting = useActing()
  const snapshotBinding = memberSnapshotBinding({ node, acting, pageKey })
  const groups = useGroupRows({ enabled: hosted && allowed && pageKey === null, request: node.request, versions: node.groupVersions, seenTick, binding: snapshotBinding })

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
  const { resolveMany, profileOf } = names
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
  // A search keeps the chip: both narrow the same loaded rows, and the
  // pinned rows step aside while it runs.
  const data = useMemo(() => {
    if (needle !== '') {
      return applyFilter(merged.filter((row) => {
        const title = row.kind === 'dm' ? personTitle(profileOf(row.peer)) : row.title
        return matches(title, needle) || matches(row.subtitle, needle)
      }), filter)
    }
    const rows = filter === 'todas' ? paged : merged
    return applyFilter([requestsRow({ requests: inbox.requests }), communitiesRow(), ...rows], filter)
  }, [merged, paged, needle, filter, inbox.requests, profileOf])
  // The sheet's "Conversas recentes": the loaded private conversations,
  // newest first (mergeRows order).
  const recent = useMemo(() => merged.filter((row) => row.kind === 'dm').slice(0, RECENT_MAX).map((row) => row.peer), [merged])

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

  if (!hosted) return <View style={styles.root}><Skeleton /></View>

  const items = data.filter((row) => row.kind === 'dm' || row.kind === 'group')
  const dmLoaded = !ready || inbox.loaded
  const loaded = dmLoaded && (pageKey !== null || groups.loaded)
  const dmFailed = ready && inbox.error !== ''
  const groupsFailed = pageKey === null && groups.error !== ''
  const partial = loaded && (dmFailed || groupsFailed || (pageKey === null && groups.partial))

  const header = (
    <View>
      <PageInboxNote pageKey={pageKey} />
      <View style={[styles.search, searchFocused && styles.searchFocused]}>
        <Icon name='lupa' size={20} color={colors.soft} />
        <TextInput
          style={[styles.input, webInputReset]}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          value={query}
          onChangeText={setQuery}
          placeholder={SEARCH_PLACEHOLDER}
          placeholderTextColor={colors.placeholder}
          autoCapitalize='none'
          autoCorrect={false}
          returnKeyType='search'
          accessibilityLabel='buscar conversas'
        />
        {query !== ''
          ? (
            <Pressable accessibilityRole='button' accessibilityLabel='limpar busca' hitSlop={space.md} onPress={() => setQuery('')} style={styles.clear}>
              <Icon name='fechar' size={18} color={colors.soft} />
            </Pressable>
            )
          : null}
      </View>
      <FilterChips options={FILTERS.map((id) => ({ id, label: FILTER_LABELS[id] }))} selected={filter} onSelect={setFilter} />
      {!unlocked ? <View style={styles.pad}><Soft>{LOCKED_TEXT}</Soft></View> : null}
      {partial
        ? (
          <View style={styles.pad}>
            <Soft>{PARTIAL_TEXT}</Soft>
            {dmFailed ? <ErrorText>{inbox.error}</ErrorText> : null}
            {groupsFailed ? <ErrorText>{groups.error}</ErrorText> : null}
            <Pill label='tentar de novo' onPress={refresh} />
          </View>
          )
        : null}
    </View>
  )

  // A failed older page comes first: under a chip that leaves no loaded row,
  // the older (maybe unread) conversations are only reachable through it.
  let footer = null
  if (!loaded) footer = <Skeleton />
  else if (inbox.pageError) {
    footer = (
      <View style={styles.pad}>
        <Soft>{PARTIAL_TEXT}</Soft>
        <ErrorText>{inbox.pageError}</ErrorText>
        <Pill label='tentar de novo' onPress={() => inbox.loadMore()} />
      </View>
    )
  } else if (items.length === 0 && !partial && (ready || needle !== '' || filter === 'grupos')) {
    if (needle !== '') footer = <View style={styles.pad}><Soft>Nenhuma conversa encontrada.</Soft></View>
    else if (filter === 'todas') footer = <EmptyState icon='conversas' title={EMPTY_TEXT} body={EMPTY_BODY} />
    else if (filter === 'grupos') footer = <EmptyState icon='gente' title='Nenhum grupo ainda' body='Os grupos das suas comunidades aparecem aqui.' />
    else if (!inbox.requests) footer = <EmptyState icon='conversas' title='Nada novo por aqui' />
  }

  const renderItem = ({ item }) => {
    if (item.kind === 'requests') {
      return (
        <PinnedRow icon='conversas' title={item.title} dot={item.unread === true} chevron onPress={() => { if (typeof onOpenRequests === 'function') onOpenRequests() }} />
      )
    }
    if (item.kind === 'communities') {
      return (
        <PinnedRow icon='gente' title={item.title} chevron onPress={() => { if (typeof onOpenCommunities === 'function') onOpenCommunities() }} />
      )
    }
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
        data={data}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        extraData={{ now, names: profileOf }}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={refresh}
        refreshing={refreshing}
        onLoadMore={ready && needle === '' && inbox.next && !inbox.loadingMore && !inbox.pageError ? inbox.loadMore : undefined}
        loadingMore={inbox.loadingMore}
        loadMoreError={inbox.pageError || undefined}
        atEnd={!ready || !inbox.next}
      />
      {sheets}
    </View>
  )
}

// Pedidos de mensagem and Comunidades: compact pinned rows, the glyph in the
// avatar column so the titles line up with the rows below. Pedidos shows a
// dot for news, never a count.
function PinnedRow ({ icon, title, dot, chevron, onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={title + (dot ? ', há pedidos novos' : '')}
      onPress={onPress}
      style={({ pressed }) => [styles.pinnedRow, pressed && styles.pressed]}
    >
      <View style={styles.glyph}><Icon name={icon} size={24} color={colors.accent} /></View>
      <Text style={styles.pinnedTitle} numberOfLines={1}>{title}</Text>
      {dot ? <View style={styles.dot} /> : null}
      {chevron ? <Icon name='seta' size={20} color={colors.soft} /> : null}
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pad: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginVertical: space.sm,
    paddingHorizontal: space.md,
    // minHeight: large system text grows the field instead of squeezing it.
    minHeight: layout.hit,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.inputOff
  },
  searchFocused: { borderColor: colors.accent, backgroundColor: colors.card },
  input: { ...type.postText, flex: 1, minWidth: 0, minHeight: layout.hit - 3, paddingVertical: 0, color: colors.ink },
  clear: { minWidth: space.xl, minHeight: space.xl, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: colors.line },
  pinnedRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: PINNED_HEIGHT, paddingHorizontal: space.lg },
  glyph: { width: AVATAR_COLUMN, alignItems: 'center', justifyContent: 'center' },
  pinnedTitle: { ...type.postName, flex: 1, minWidth: 0, color: colors.ink },
  dot: { width: 12, height: 12, borderRadius: radius.pill, backgroundColor: colors.accent }
})
