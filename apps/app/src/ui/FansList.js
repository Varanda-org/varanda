// The fan list of a diary, newest first, no ranking. Used by the Fãs segment of
// Seguindo (the own list) and by the Fãs screen of another person.
//
// Trust: the seeder index (indexClient.js fetchFans) only says where to look.
// A row exists only when the fan's own diary returned a signed `fan` record,
// on, naming this author, at the seq and date the pointer gave (fans.js
// confirmFans). A lying seeder can omit rows or point at an older authentic
// mark, never forge one. The total is the seeder's word, shown as such.
//
// Requests only when the node is hosted. Nothing is persisted; a stranger's
// photo is not stored.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useBlocks } from '../blocksProvider'
import { useNames } from '../names'
import { fetchFans } from '../indexClient'
import { confirmFans, planFanPeeks } from '../fans.js'
import { TEXTS } from '../fansView.js'
import { END_TEXT, MORE_FAILED, NOT_HOSTED, SEEDER_DOWN, countLabel, errorFor, mergeRows, nextCursor, notesOf } from '../pessoas'
import { whoOf } from '../who'
import { pickAvatar } from '../media/avatar'
import { Soft, errorText, useBottomPad } from './index'
import { Avatar } from './Avatar'
import { RefreshableList } from './RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from './States'
import { type } from './theme'
import { useStyles } from './ThemeProvider'
import { isSeederDown, learnPeeked, peekAll } from '../screens/Conversa'

const isUnsupported = (err) => !!err && err.code === 'USAGE' &&
  (err.message === 'leitura sob demanda só na versão web' || err.message === 'método desconhecido')

const emptyList = () => ({
  phase: 'idle',
  rows: [],
  unavailable: 0,
  next: null,
  total: null,
  meta: { indexing: false, complete: true },
  unsupported: false,
  loadingMore: false,
  moreError: '',
  refreshing: false,
  error: ''
})

function FanRow ({ row, profile, onOpen }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  const title = displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const open = typeof onOpen === 'function' ? () => onOpen(row.key, { name: profile ? profile.name : null, username: profile ? profile.username : null }) : undefined
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
      accessibilityRole='link'
      accessibilityLabel={'ver o perfil de ' + title}
      disabled={!open}
      onPress={open}
    >
      <Avatar name={who.avatarName} publicKey={row.key} size={48} picture={pickAvatar(profile, row)} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  )
}

// `author` whose fans; `own` true on the own list (the empty words change).
// `isTop` false while another screen is stacked above, `active` false while
// the list is hidden: both stop reading. `header` sits above the list (the
// Seguindo segments). `onOpenMember(key, { name, username })` opens a profile.
export function FansList ({ author, own = false, isTop = true, active = true, header = null, onOpenMember, onCount }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const blocks = useBlocks()
  const names = useNames()
  const bottomPad = useBottomPad()
  const hosted = node.hosted === true
  const online = node.online
  const { request } = node
  const { learnMany, profileOf, resolveMany } = names
  const [list, setList] = useState(emptyList)
  const listRef = useRef(list)
  const gen = useRef(0)
  const blockedRef = useRef(blocks.has)
  blockedRef.current = blocks.has

  useEffect(() => () => { gen.current++ }, [])

  const patch = useCallback((p) => {
    listRef.current = { ...listRef.current, ...p }
    setList(listRef.current)
  }, [])

  // One page: the index list, then the peeks that verify it. null when
  // superseded; { unsupported }, { error, down } or { value, rows, unavailable, peeked }.
  const readPage = useCallback(async (cursor, alive) => {
    const res = await fetchFans(author, cursor)
    if (!alive()) return null
    if (!res.ok) return { error: errorFor(res.reason), down: false }
    const value = res.value
    const isBlocked = (key) => blockedRef.current(key)
    const peeked = new Map()
    // One fan diary at a time: a diary that throws only leaves its own rows
    // unconfirmed; the page fails only when no diary answered at all.
    let answered = 0
    let failure = null
    for (const params of planFanPeeks({ author, items: value.items, isBlocked })) {
      try {
        await peekAll(request, [params], peeked, alive)
        answered++
      } catch (err) {
        if (!alive()) return null
        if (isUnsupported(err)) return { unsupported: true }
        if (failure === null) failure = err
      }
      if (!alive()) return null
    }
    if (answered === 0 && failure !== null) {
      const down = isSeederDown(failure)
      return { error: down ? SEEDER_DOWN : errorText(failure), down }
    }
    const { rows, unavailable } = confirmFans({ author, items: value.items, peeks: peeked, isBlocked })
    const shown = rows.map((r) => {
      const peek = peeked.get(r.key)
      const profile = peek && peek.profile && typeof peek.profile === 'object' ? peek.profile : null
      return { ...r, name: profile && typeof profile.name === 'string' ? profile.name : null, username: peek && typeof peek.username === 'string' ? peek.username : null, avatar: profile ? profile.avatar : null }
    })
    return { value, rows: shown, unavailable, peeked }
  }, [author, request])

  const load = useCallback(async (refreshing) => {
    if (!hosted || typeof author !== 'string') return
    const mine = ++gen.current
    const alive = () => gen.current === mine
    patch(refreshing
      ? { refreshing: true, loadingMore: false }
      : { phase: 'loading', refreshing: false, loadingMore: false, error: '' })
    const page = await readPage(null, alive)
    if (page === null) return
    if (!page.value) {
      const fail = page.unsupported ? { unsupported: true } : { error: page.error }
      patch({ ...fail, phase: listRef.current.rows.length > 0 ? 'ready' : 'error', refreshing: false })
      return
    }
    const { value } = page
    patch({
      phase: 'ready',
      unsupported: false,
      rows: page.rows,
      unavailable: page.unavailable,
      next: nextCursor(null, value.next),
      total: value.total,
      meta: { indexing: value.indexing, complete: value.complete },
      refreshing: false,
      error: '',
      moreError: ''
    })
    learnPeeked(learnMany, page.peeked)
    resolveMany(page.rows.map((r) => r.key))
  }, [hosted, author, readPage, patch, learnMany, resolveMany])

  const loadMore = useCallback(async () => {
    const cur = listRef.current
    if (!hosted || online === false) return
    if (cur.phase !== 'ready' || cur.next === null || cur.loadingMore || cur.refreshing) return
    const mine = ++gen.current
    const alive = () => gen.current === mine
    patch({ loadingMore: true, moreError: '' })
    const page = await readPage(cur.next, alive)
    if (page === null) return
    if (!page.value) {
      patch({ loadingMore: false, moreError: page.down ? SEEDER_DOWN : MORE_FAILED })
      return
    }
    const { value } = page
    const now = listRef.current
    patch({
      loadingMore: false,
      rows: mergeRows(now.rows, page.rows),
      unavailable: now.unavailable + page.unavailable,
      next: nextCursor(now.next, value.next),
      total: value.total,
      meta: { indexing: value.indexing, complete: now.meta.complete && value.complete }
    })
    learnPeeked(learnMany, page.peeked)
    resolveMany(page.rows.map((r) => r.key))
  }, [hosted, online, readPage, patch, learnMany, resolveMany])

  const { phase, rows, unavailable, next, total, meta, unsupported, loadingMore, moreError, refreshing, error } = list

  useEffect(() => {
    if (!hosted || !active || online === false || phase !== 'idle') return
    load(false)
  }, [hosted, active, online, phase, load])

  useEffect(() => {
    if (typeof onCount === 'function' && phase === 'ready') onCount(total)
  }, [phase, total])

  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])
  const personOf = useCallback((key) => {
    const cached = profileOf(key)
    if (cached && (cached.name || cached.username)) return cached
    const row = byKey.get(key)
    if (row && (row.name || row.username)) return { name: row.name, username: row.username, avatar: row.avatar }
    return cached
  }, [profileOf, byKey])

  if (!hosted) {
    return (
      <View style={styles.flex}>
        {header}
        <EmptyState icon='gente' title={TEXTS.fansTitle} body={NOT_HOSTED} />
      </View>
    )
  }

  const ready = phase === 'ready'
  const atEnd = next === null
  const count = ready ? countLabel(total) : ''
  const notes = ready ? notesOf({ ...meta, unavailable }) : []

  const head = (
    <View style={styles.head}>
      {count ? <Text style={styles.count}>{count}</Text> : null}
      {notes.map((line) => <Soft key={line}>{line}</Soft>)}
      {ready ? <Soft>{TEXTS.fansNote}</Soft> : null}
      {rows.length > 0 && error ? <ErrorState message={displayText(error)} onRetry={() => load(true)} pending={refreshing} /> : null}
    </View>
  )

  let empty = null
  if (unsupported) {
    empty = <EmptyState icon='gente' title='Lista indisponível' body='Esta lista não está disponível nesta conexão.' />
  } else if (online === false && rows.length === 0) {
    empty = <EmptyState icon='gente' title='Sem conexão' body='A lista precisa de internet.' actionLabel='tentar de novo' onAction={() => load(false)} />
  } else if (phase === 'idle' || phase === 'loading') {
    empty = <Skeleton />
  } else if (phase === 'error') {
    empty = <ErrorState message={displayText(error || errorFor(null))} onRetry={() => load(false)} />
  } else if (rows.length === 0) {
    if (next !== null) {
      const onAction = loadingMore || moreError ? undefined : loadMore
      empty = <EmptyState icon='gente' title='Ninguém conferido até aqui' body='A lista continua.' actionLabel={onAction ? 'mostrar mais' : undefined} onAction={onAction} />
    } else if (total === 0 && meta.indexing !== true && meta.complete !== false) {
      empty = <EmptyState icon='estrela' title={TEXTS.fansEmptyTitle} body={own ? TEXTS.fansEmptyBodyOwn : TEXTS.fansEmptyBody} />
    } else if (unavailable === 0 && (meta.indexing === true || meta.complete === false)) {
      empty = (
        <EmptyState
          icon='gente'
          title={meta.indexing === true ? 'Ainda montando a lista' : 'Lista incompleta'}
          body={notesOf({ indexing: meta.indexing, complete: meta.complete })[0]}
          actionLabel='tentar de novo'
          onAction={() => load(false)}
        />
      )
    } else {
      empty = <EmptyState icon='gente' title={TEXTS.fansNone} body={TEXTS.fansNoneBody} actionLabel='tentar de novo' onAction={() => load(false)} />
    }
  }

  const canLoadMore = online !== false && ready && next !== null && !moreError && rows.length > 0

  return (
    <View style={styles.flex}>
      {header}
      <RefreshableList
        data={rows}
        extraData={[personOf]}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) => <FanRow row={item} profile={personOf(item.key)} onOpen={onOpenMember} />}
        ListHeaderComponent={head}
        ListEmptyComponent={empty}
        ListFooterComponent={ready
          ? <ListFooter loading={loadingMore} atEnd={atEnd && rows.length > 0} endText={END_TEXT} error={moreError} onRetry={loadMore} pending={loadingMore} />
          : null}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={() => load(true)}
        refreshing={refreshing}
        onLoadMore={isTop && active && canLoadMore ? loadMore : undefined}
        loadingMore={loadingMore}
        loadMoreError={!!moreError}
        atEnd={atEnd}
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  head: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  count: { ...type.postName, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 16, minHeight: 64 },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.rowName, color: colors.ink },
  handle: { ...type.meta, color: colors.soft }
})
