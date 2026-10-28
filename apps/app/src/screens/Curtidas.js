// Curtidas: who liked and who reposted a post, two tabs pushed above the
// tabs (App.js screen stack, entry { screen: 'curtidas', key: ref, params:
// { kind } }). The seeder index (src/indexClient.js fetchEngagers) only says
// where to look; each row is verified with diary.peek (the engager's own
// signed like or repost of this post, src/engagers.js), so the index can hide
// people but never add one. Hosted web only: natively and on varanda-serve
// nothing is requested. Nothing is persisted. No follow pill (the profile has
// it) and no like timestamp.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { fetchEngagers } from '../indexClient'
import { planPeeks } from '../thread'
import {
  END_TEXT, ENGAGERS_TITLE, MORE_FAILED, SEEDER_DOWN, TAB_LABEL,
  confirmEngagers, countLabel, errorFor, listView, mergeRows, nextCursor, notesOf
} from '../engagers'
import { whoOf } from '../who'
import { Soft, errorText, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { OfflineNote } from '../ui/OfflineNote'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { colors, type } from '../ui/theme'
import { isSeederDown, learnPeeked, peekAll } from './Conversa'

const TABS = ['likes', 'reposts']

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
  error: ''
})

// Peek-only names: a row shows what the engager's own diary says, never the
// names cache, so it matches what was verified.
function EngagerRow ({ row, onOpen }) {
  const profile = { name: row.name, username: row.username }
  const who = whoOf(profile)
  const title = displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const open = typeof onOpen === 'function' ? () => onOpen(row.author, profile) : undefined
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
      accessibilityRole='link'
      accessibilityLabel={'ver o perfil de ' + title}
      disabled={!open}
      onPress={open}
    >
      <Avatar name={who.avatarName} publicKey={row.author} size={44} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  )
}

export default function Curtidas ({ entry, onBack, onOpenMember }) {
  const node = useNode()
  const names = useNames()
  const bottomPad = useBottomPad()
  const focal = entry.key
  const hosted = node.hosted === true
  const online = node.online
  const { request } = node
  const { learnMany } = names
  const [kind, setKind] = useState(entry.params && entry.params.kind === 'reposts' ? 'reposts' : 'likes')
  const [tabs, setTabs] = useState(() => ({ likes: emptyTab(), reposts: emptyTab() }))
  const tabsRef = useRef(tabs)
  // One generation per tab: only the latest read of that tab may commit.
  const gens = useRef({ likes: 0, reposts: 0 })

  useEffect(() => () => {
    gens.current.likes++
    gens.current.reposts++
  }, [])

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
    const peeked = new Map()
    try {
      await peekAll(request, planPeeks({ refs: value.items, authors: value.authors }), peeked, alive)
    } catch (err) {
      if (!alive()) return null
      if (isUnsupported(err)) return { unsupported: true }
      const down = isSeederDown(err)
      return { error: down ? SEEDER_DOWN : errorText(err), down }
    }
    if (!alive()) return null
    const { rows, unconfirmed } = confirmEngagers({ kind: k, focal, items: value.items, peeked })
    return { value, rows, unconfirmed, peeked }
  }, [focal, request])

  const load = useCallback(async (k, refreshing) => {
    if (!hosted) return
    const gen = ++gens.current[k]
    const alive = () => gens.current[k] === gen
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
      moreError: ''
    })
    learnPeeked(learnMany, page.peeked)
  }, [hosted, readPage, patch, learnMany])

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
  const { phase, rows, unconfirmed, next, total, meta, unsupported, loadingMore, moreError, refreshing, error } = cur

  // Also covers the connection coming back; a tab already loaded is not
  // read again on a switch.
  useEffect(() => {
    if (!hosted || online === false || phase !== 'idle') return
    load(kind, false)
  }, [hosted, online, kind, phase, load])

  const v = listView({ hosted, online, unsupported, phase, rows, next, unconfirmed, error, kind, total, indexing: meta.indexing, complete: meta.complete })

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

  const ready = phase === 'ready'
  const count = ready ? countLabel(kind, total) : ''
  // The 'hidden' view already says why the list is short.
  const notes = ready && v.view !== 'hidden'
    ? notesOf({ ...meta, unconfirmed, total, listed: rows.length, atEnd: next === null })
    : []
  const header = ready
    ? (
      <View style={styles.head}>
        {count ? <Text style={styles.count}>{count}</Text> : null}
        {notes.map((line) => <Soft key={line}>{line}</Soft>)}
        {rows.length > 0 && error ? <ErrorState message={displayText(error)} onRetry={() => load(kind, true)} pending={refreshing} /> : null}
      </View>
      )
    : null

  // No automatic continuation over an empty list: there the 'mostrar mais'
  // of the empty view is the only way forward.
  const canMore = ready && next !== null && !moreError && rows.length > 0

  return (
    <View style={styles.flex}>
      <TopBar title={ENGAGERS_TITLE} onBack={onBack} />
      <OfflineNote />
      <View style={styles.tabs} accessibilityRole='tablist'>
        {TABS.map((k) => {
          const selected = k === kind
          return (
            <Pressable
              key={k}
              accessibilityRole='tab'
              accessibilityState={{ selected }}
              onPress={() => setKind(k)}
              style={[styles.tab, selected && styles.tabOn]}
            >
              <Text style={[styles.tabText, selected && styles.tabTextOn]}>{TAB_LABEL[k]}</Text>
            </Pressable>
          )
        })}
      </View>
      <View style={styles.flex}>
        <RefreshableList
          // One list per tab: a shared one would carry the scroll offset and
          // the end-reached latch over to the other tab.
          key={kind}
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

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.line },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabOn: { borderBottomColor: colors.accent },
  tabText: { ...type.pill, color: colors.soft },
  tabTextOn: { color: colors.accent },
  head: { paddingHorizontal: 16, paddingVertical: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.line },
  count: { ...type.postName, color: colors.ink },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  handle: { ...type.postMeta, color: colors.soft }
})
