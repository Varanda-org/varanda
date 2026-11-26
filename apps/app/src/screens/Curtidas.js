// Curtidas: who liked and who reposted a post, two tabs pushed above the
// tabs (App.js screen stack, entry { screen: 'curtidas', key: ref, params:
// { kind } }). The seeder index (src/indexClient.js fetchEngagers) only says
// where to look; each row is verified with diary.peek (the engager's own
// signed like or repost of this post, src/engagers.js), so the index can hide
// people but never add one. It requests only when the node is hosted
// (node.hosted === true: the site and the installed app on an installation);
// a manual configuration or varanda-serve requests nothing.
// Only the first page of the likes tab of the last post opened is kept on
// the device (the 'listas' snapshot, ../listsSnapshot.js): it paints at once
// behind the block gate while the live page answers and replaces it. The
// reposts tab and later pages stay in memory. No follow pill (the profile has it) and no like
// timestamp. A known total is part of the tab label, not a line of its own.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useBlocks } from '../blocksProvider'
import { withoutBlockedRefs } from '../memberBlocks'
import { useNames } from '../names'
import { fetchEngagers } from '../indexClient'
import { planPeeks } from '../thread'
import { formatCount } from '../format'
import {
  END_TEXT, ENGAGERS_TITLE, MORE_FAILED, SEEDER_DOWN, TAB_LABEL,
  confirmEngagers, countLabel, errorFor, listView, mergeRows, nextCursor, notesOf
} from '../engagers'
import { whoOf } from '../who'
import { cachedRowsShown, withoutBlockedRows } from '../cachedRows'
import { cacheGeneration } from '../localCaches'
import { buildScreenSnapshot } from '../screenSnapshot'
import { loadScreenSnapshot, saveScreenSnapshot } from '../screenSnapshotStore'
import { Soft, errorText, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { OfflineNote } from '../ui/OfflineNote'
import { RefreshableList } from '../ui/RefreshableList'
import { Segmented } from '../ui/Segmented'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { isSeederDown, learnPeeked, peekAll, useActing } from './Conversa'
import { memberSnapshotBinding, sameSnapshotBinding } from './Comunidades'

const TABS = ['likes', 'reposts']
const SAVE_DELAY_MS = 2000
const SAVE_ROWS_MAX = 30
const engagerAuthors = (row) => [row.author]

// diary.peek refused by a node that cannot read on demand (native,
// varanda-serve, or an older node): the web-only view, not an error.
const isUnsupported = (err) => !!err && err.code === 'USAGE' &&
  (err.message === 'leitura sob demanda só na versão web' || err.message === 'método desconhecido')

const emptyTab = () => ({
  phase: 'idle',
  rows: [],
  unconfirmed: 0,
  next: null,
  total: null,
  meta: { indexing: false, complete: true },
  unsupported: false,
  loadingMore: false,
  moreError: '',
  refreshing: false,
  error: '',
  // Rows painted from the stored page, not yet confirmed by a live read.
  seeded: false
})

// The drawn label uses the compact count. The spoken label keeps countLabel's
// full sentence ("1 curtida", not "1"). An unknown total stays off both.
function tabLabel (kind, stored) {
  const name = TAB_LABEL[kind]
  // A stored total counts too: it is the last one a live page gave.
  const tab = stored && stored.seeded === true ? { ...stored, phase: 'ready' } : stored
  const sentence = tab && tab.phase === 'ready' ? countLabel(kind, tab.total) : ''
  const shown = sentence ? displayText(formatCount(tab.total)) : ''
  return {
    text: shown ? name + ' · ' + shown : name,
    spoken: shown ? name + ', ' + sentence : name
  }
}

// Peek-only names: a row shows what the engager's own diary says, never the
// names cache, so it matches what was verified.
function EngagerRow ({ row, onOpen }) {
  const styles = useStyles(makeStyles)
  const profile = { name: row.name, username: row.username }
  const who = whoOf(profile)
  const title = displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const open = typeof onOpen === 'function' ? () => onOpen(row.author, { ...profile, avatar: row.avatar }) : undefined
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
      accessibilityRole='link'
      accessibilityLabel={'ver o perfil de ' + title}
      disabled={!open}
      onPress={open}
    >
      <Avatar name={who.avatarName} publicKey={row.author} size={48} picture={row.avatar} persist={false} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  )
}

export default function Curtidas ({ entry, onBack, onOpenMember }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const blocks = useBlocks()
  const names = useNames()
  const bottomPad = useBottomPad()
  const focal = entry.key
  const hosted = node.hosted === true
  const online = node.online
  const { request } = node
  const { learnMany } = names
  const [kind, setKind] = useState(entry.params && entry.params.kind === 'reposts' ? 'reposts' : 'likes')
  const acting = useActing()
  const binding = memberSnapshotBinding({ node, acting, pageKey: acting && acting.kind === 'page' ? acting.key : null })
  const nodeRef = useRef(node)
  nodeRef.current = node
  const actingRef = useRef(acting)
  actingRef.current = acting
  const bindingRef = useRef(binding)
  bindingRef.current = binding
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const saveTimer = useRef(null)
  const [tabs, setTabs] = useState(() => {
    const base = { likes: emptyTab(), reposts: emptyTab() }
    if (binding === null || !hosted) return base
    const snapshot = loadScreenSnapshot('listas', binding)
    const entry = snapshot && snapshot.body && snapshot.body.lists ? snapshot.body.lists.curtidas : null
    if (!entry || entry.scope !== focal || !Array.isArray(entry.rows) || entry.rows.length === 0) return base
    return { ...base, likes: { ...emptyTab(), rows: entry.rows, total: entry.total === undefined ? null : entry.total, seeded: true } }
  })
  const tabsRef = useRef(tabs)
  // One generation per tab: only the latest read of that tab may commit.
  const gens = useRef({ likes: 0, reposts: 0 })

  useEffect(() => () => {
    gens.current.likes++
    gens.current.reposts++
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = null
  }, [])

  // The first live page of the likes tab, stored after a short quiet time
  // with the generation and the identity its request was sent with.
  const armSave = useCallback((stamp, rows, total) => {
    if (stamp.binding === null || cacheGeneration() !== stamp.gen) return
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      if (cacheGeneration() !== stamp.gen) return
      const now = memberSnapshotBinding({ node: nodeRef.current, acting: actingRef.current, pageKey: actingRef.current && actingRef.current.kind === 'page' ? actingRef.current.key : null })
      // Filtered by a block list that has answered, never a partial one.
      if (!sameSnapshotBinding(stamp.binding, now) || blocksRef.current.loadState !== 'ok') return
      const keys = blocksRef.current.keys
      const previous = loadScreenSnapshot('listas', now)
      const snapshot = buildScreenSnapshot('listas', {
        ...now,
        previous: previous ? previous.body : null,
        name: 'curtidas',
        scope: focal,
        rows: withoutBlockedRows(rows, keys, engagerAuthors).slice(0, SAVE_ROWS_MAX),
        total,
        blocked: keys
      })
      if (snapshot !== null) saveScreenSnapshot('listas', snapshot, stamp.gen)
    }, SAVE_DELAY_MS)
  }, [focal])

  const patch = useCallback((k, p) => {
    tabsRef.current = { ...tabsRef.current, [k]: { ...tabsRef.current[k], ...p } }
    setTabs(tabsRef.current)
  }, [])

  // One page: the index list, then the peeks that verify it. Returns null
  // when superseded, { unsupported }, { error, down } or { value, rows,
  // unconfirmed, peeked }.
  const readPage = useCallback(async (k, cursor, alive) => {
    const res = await fetchEngagers(k, focal, cursor)
    if (!alive()) return null
    if (!res.ok) return { error: errorFor(res.reason), down: false }
    const value = res.value
    const items = withoutBlockedRefs(value.items, blocks.has)
    const peeked = new Map()
    try {
      await peekAll(request, planPeeks({ refs: items, authors: value.authors }), peeked, alive)
    } catch (err) {
      if (!alive()) return null
      if (isUnsupported(err)) return { unsupported: true }
      const down = isSeederDown(err)
      return { error: down ? SEEDER_DOWN : errorText(err), down }
    }
    if (!alive()) return null
    const { rows, unconfirmed } = confirmEngagers({ kind: k, focal, items, peeked })
    return { value, rows, unconfirmed, peeked }
  }, [focal, request, blocks.has])

  const load = useCallback(async (k, refreshing) => {
    if (!hosted) return
    const gen = ++gens.current[k]
    const alive = () => gens.current[k] === gen
    // Read before the request is sent, so a lock or wipe meanwhile voids it.
    const stamp = k === 'likes' ? { gen: cacheGeneration(), binding: bindingRef.current } : null
    patch(k, refreshing
      ? { refreshing: true, loadingMore: false }
      : { phase: 'loading', refreshing: false, loadingMore: false, error: '' })
    const page = await readPage(k, null, alive)
    if (page === null) return
    if (!page.value) {
      const fail = page.unsupported ? { unsupported: true } : { error: page.error }
      if (tabsRef.current[k].rows.length > 0) patch(k, { ...fail, phase: 'ready', refreshing: false })
      else patch(k, { ...fail, phase: 'error', refreshing: false })
      return
    }
    const { value } = page
    patch(k, {
      phase: 'ready',
      unsupported: false,
      rows: page.rows,
      unconfirmed: page.unconfirmed,
      next: value.next,
      total: value.total,
      meta: { indexing: value.indexing, complete: value.complete },
      refreshing: false,
      error: '',
      moreError: '',
      seeded: false
    })
    if (stamp !== null && value.complete !== false) armSave(stamp, page.rows, value.total)
    learnPeeked(learnMany, page.peeked)
  }, [hosted, readPage, patch, learnMany, armSave])

  const loadMore = useCallback(async (k) => {
    const cur = tabsRef.current[k]
    if (!hosted || online === false) return
    if (cur.phase !== 'ready' || cur.next === null || cur.loadingMore || cur.refreshing) return
    const gen = ++gens.current[k]
    const alive = () => gens.current[k] === gen
    patch(k, { loadingMore: true, moreError: '' })
    const page = await readPage(k, cur.next, alive)
    if (page === null) return
    if (!page.value) {
      patch(k, { loadingMore: false, moreError: page.down ? SEEDER_DOWN : MORE_FAILED })
      return
    }
    const { value } = page
    const now = tabsRef.current[k]
    patch(k, {
      loadingMore: false,
      rows: mergeRows(now.rows, page.rows),
      unconfirmed: now.unconfirmed + page.unconfirmed,
      next: nextCursor(now.next, value.next),
      total: value.total,
      meta: { indexing: value.indexing, complete: now.meta.complete && value.complete }
    })
    learnPeeked(learnMany, page.peeked)
  }, [hosted, online, readPage, patch, learnMany])

  const cur = tabs[kind]
  const { phase, rows: rawRows, unconfirmed, next, total, meta, unsupported, loadingMore, moreError, refreshing, error, seeded } = cur
  // A stored row was verified by the save, not by this open: nothing of
  // other people paints until block.list has answered.
  const rows = useMemo(() => (seeded
    ? cachedRowsShown(rawRows, { loadState: blocks.loadState, blocked: blocks.keys, owner: binding ? binding.owner : null, authorsOf: engagerAuthors })
    : rawRows), [seeded, rawRows, blocks.loadState, blocks.keys, binding])

  // Also covers the connection coming back; a tab already loaded is not
  // read again on a switch.
  useEffect(() => {
    if (!hosted || online === false || phase !== 'idle') return
    load(kind, false)
  }, [hosted, online, kind, phase, load])

  // Over a stored page the skeleton shows only when nothing is drawn.
  const viewPhase = seeded && phase === 'ready' ? (error && rows.length === 0 ? 'error' : 'loading') : phase
  const v = listView({ hosted, online, unsupported, phase: viewPhase, rows, next, unconfirmed, error, kind, total, indexing: meta.indexing, complete: meta.complete })

  let empty = null
  if (v.view === 'loading') {
    empty = <Skeleton />
  } else if (v.view === 'error') {
    empty = <ErrorState message={displayText(v.message)} onRetry={() => load(kind, false)} />
  } else if (v.view !== 'ready') {
    let onAction
    // While a page loads or failed, the footer owns the spinner and the retry.
    if (v.view === 'more') onAction = loadingMore || moreError ? undefined : () => loadMore(kind)
    else if (v.view === 'offline' || v.view === 'unchecked' || v.view === 'hidden') onAction = () => load(kind, false)
    empty = (
      <EmptyState
        icon={kind === 'reposts' ? 'republicar' : 'coracao'}
        title={v.title}
        body={v.body}
        actionLabel={onAction ? v.action : undefined}
        onAction={onAction}
      />
    )
  }

  const ready = phase === 'ready' && !seeded
  // The 'hidden' view already says why the list is short.
  const notes = ready && v.view !== 'hidden'
    ? notesOf({ ...meta, unconfirmed, total, listed: rows.length, atEnd: next === null })
    : []
  const listError = rows.length > 0 && error ? error : ''
  const header = notes.length > 0 || listError
    ? (
      <View style={styles.head}>
        {notes.map((line) => <Soft key={line}>{line}</Soft>)}
        {listError ? <ErrorState message={displayText(listError)} onRetry={() => load(kind, true)} pending={refreshing} /> : null}
      </View>
      )
    : null

  // No automatic continuation over an empty list: there the 'mostrar mais'
  // of the empty view is the only way forward.
  const canMore = hosted && online !== false && ready && next !== null && !moreError && rows.length > 0
  const options = TABS.map((k) => {
    const label = tabLabel(k, tabs[k])
    return { id: k, label: label.text, spoken: label.spoken }
  })

  return (
    <View style={styles.flex}>
      <TopBar title={ENGAGERS_TITLE} onBack={onBack} />
      <OfflineNote />
      <Segmented options={options} selected={kind} onSelect={setKind} />
      <View style={styles.flex}>
        <RefreshableList
          // One list per tab: a shared one would carry the scroll offset and
          // the end-reached latch over to the other tab.
          key={kind}
          perfId='curtidas'
          data={rows}
          keyExtractor={(row) => row.author}
          renderItem={({ item }) => <EngagerRow row={item} onOpen={onOpenMember} />}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          ListFooterComponent={ready
            ? (
              <ListFooter
                loading={loadingMore}
                atEnd={next === null && rows.length > 0}
                endText={END_TEXT}
                error={moreError}
                onRetry={() => loadMore(kind)}
                pending={loadingMore}
              />
              )
            : null}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          onRefresh={hosted ? () => load(kind, true) : undefined}
          refreshing={refreshing}
          onLoadMore={canMore ? () => loadMore(kind) : undefined}
          loadingMore={loadingMore}
          loadMoreError={!!moreError}
          atEnd={next === null}
        />
      </View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  head: { paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16
  },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.rowName, color: colors.ink },
  handle: { ...type.meta, color: colors.soft }
})
