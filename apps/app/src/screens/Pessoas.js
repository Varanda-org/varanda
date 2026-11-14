// Pessoas: the public 'Seguindo' or 'Seguidores' list of any diary, a stack
// screen (entry { screen: 'seguindo' | 'seguidores', key: author }).
//
// Trust: the seeder index (src/indexClient.js fetchFollows) only says where to
// look. Each row is a signed follow record verified with diary.peek
// (src/pessoas.js confirmFollows): for 'seguidores' the follower's own block,
// for 'seguindo' the author's block. A lying seeder can omit rows or point at
// an older authentic record, never forge one. The total is the seeder's word
// and is shown as such, never replaced by the number of rows that survived.
//
// Requests only when the node is hosted (node.hosted === true). Nothing is
// persisted; a stranger's photo is not stored (MemberRow keeps it only while
// followed). The field only filters the rows already loaded: it never searches
// accounts and never follows.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { useBlocks } from '../blocksProvider'
import { withoutBlockedKeys } from '../memberBlocks'
import { useNames } from '../names'
import { fetchFollows } from '../indexClient'
import { planPeeks } from '../thread'
import {
  END_TEXT, MORE_FAILED, NOT_HOSTED, PESSOAS_TITLE, SEEDER_DOWN,
  confirmFollows, countLabel, errorFor, mergeRows, nextCursor, notesOf, refOf
} from '../pessoas'
import { FILTER_EMPTY, FILTER_HINT, FILTER_LABEL, FILTER_PLACEHOLDER, filterPeople } from '../peopleFilter'
import { HELP } from '../help'
import { pickAvatar } from '../media/avatar'
import { whoOf } from '../who'
import { ErrorText, Notice, Soft, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { HelpButton } from '../ui/Help'
import { MemberRow } from '../ui/MemberRow'
import { OfflineNote } from '../ui/OfflineNote'
import { RefreshableList } from '../ui/RefreshableList'
import { SearchField } from '../ui/SearchField'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { isSeederDown, learnPeeked, peekAll, useFollowSet } from './Conversa'

// Half the names cache's retry window (5 s), as in Seguindo.js.
const NAMES_RETRY_MS = 2500
// The filter hint stays word for word, inside the field's help button.
const FILTER_HELP = Object.freeze({ title: 'Sobre o filtro', paragraphs: Object.freeze([FILTER_HINT]) })
const FOLLOW_FAILED = (r) => r.uncertain === true
  ? 'Não deu para confirmar. Pode ter funcionado: confira a lista.'
  : 'Não deu para seguir agora. Tente de novo.'

const isSeq = (n) => Number.isSafeInteger(n) && n >= 1

// diary.peek refused by a node that cannot read on demand: not an error.
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

// For 'seguindo' the follow records live in the author's diary, so the
// followed people's names need their own peeks; diary.peek takes at least one
// seq, so the hinted profile (or username) block is that seq.
function namePeeks (kind, author, ownKey, items, authors) {
  if (kind !== 'seguindo' || authors === null || typeof authors !== 'object') return []
  const plan = []
  const seen = new Set([author])
  if (ownKey) seen.add(ownKey)
  for (const item of items) {
    const key = item && item.key
    if (typeof key !== 'string' || seen.has(key)) continue
    seen.add(key)
    const hint = Object.prototype.hasOwnProperty.call(authors, key) ? authors[key] : null
    if (hint === null || typeof hint !== 'object') continue
    const profileSeq = isSeq(hint.profileSeq) ? hint.profileSeq : null
    const usernameSeq = isSeq(hint.usernameSeq) ? hint.usernameSeq : null
    if (profileSeq === null && usernameSeq === null) continue
    const chunk = { author: key, seqs: [profileSeq !== null ? profileSeq : usernameSeq] }
    if (profileSeq !== null) chunk.profileSeq = profileSeq
    if (usernameSeq !== null) chunk.usernameSeq = usernameSeq
    plan.push(chunk)
  }
  return plan
}

// What the peeked diary says about a row's person, for the name before the
// names cache learns it and for the photo.
function decorate (rows, peeked) {
  return rows.map((row) => {
    const peek = peeked.get(row.key)
    const profile = peek && peek.profile && typeof peek.profile === 'object' ? peek.profile : null
    return {
      ...row,
      name: profile && typeof profile.name === 'string' ? profile.name : null,
      username: peek && typeof peek.username === 'string' ? peek.username : null,
      avatar: profile ? profile.avatar : null
    }
  })
}

// The own account on someone's list: no pill. The photo is kept on disk
// only for the own key (`own`), never for a row this list put here.
function OwnRow ({ row, own, profile, onOpen }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  const title = displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const open = typeof onOpen === 'function' ? () => onOpen(row.key, { name: profile.name, username: profile.username }) : undefined
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
      accessibilityRole='link'
      accessibilityLabel={'ver o perfil de ' + title}
      disabled={!open}
      onPress={open}
    >
      <Avatar name={who.avatarName} publicKey={row.key} size={44} picture={pickAvatar(profile, row)} persist={typeof own === 'string' && row.key === own} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  )
}

// `entry` { screen: 'seguindo' | 'seguidores', key: author }. `isTop` false
// while another screen is stacked above, `active` false while the tab is
// hidden: both stop paging and the names re-ask. `onFollowsChanged` after a
// follow change; `onOpenMember(key, { name, username })` opens a profile;
// `onToast(text)` shows a confirmation (else the screen's own notice).
export default function Pessoas ({ entry, ownKey, isTop = true, active = true, onBack, onOpenMember, onFollowsChanged, onToast }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const blocks = useBlocks()
  const names = useNames()
  const bottomPad = useBottomPad()
  const kind = entry && entry.screen === 'seguidores' ? 'seguidores' : 'seguindo'
  const author = entry && typeof entry.key === 'string' ? entry.key.toLowerCase() : null
  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const hosted = node.hosted === true
  const online = node.online
  const { request } = node
  const { learnMany, profileOf, resolveMany } = names
  const [list, setList] = useState(emptyList)
  const listRef = useRef(list)
  const gen = useRef(0)
  const [text, setText] = useState('')
  const [done, setDone] = useNotice()
  const notify = (msg) => {
    if (typeof onToast === 'function') onToast(msg)
    else setDone(msg)
  }

  useEffect(() => () => { gen.current++ }, [])

  const patch = useCallback((p) => {
    listRef.current = { ...listRef.current, ...p }
    setList(listRef.current)
  }, [])

  // One page: the index list, then the peeks that verify it. Returns null
  // when superseded, { unsupported }, { error, down } or { value, rows,
  // unavailable, peeked }.
  const readPage = useCallback(async (cursor, alive) => {
    const res = await fetchFollows(author, kind, cursor)
    if (!alive()) return null
    if (!res.ok) return { error: errorFor(res.reason), down: false }
    const value = res.value
    const items = withoutBlockedKeys(value.items, blocks.has)
    const refs = items.map((item) => refOf(kind, author, item)).filter((r) => r !== null)
    const peeked = new Map()
    // One diary at a time: a diary that throws only leaves its own rows
    // unconfirmed (counted as unavailable); the page fails only when no
    // diary answered at all.
    let answered = 0
    let failure = null
    for (const chunk of planPeeks({ refs, authors: value.authors })) {
      try {
        await peekAll(request, [chunk], peeked, alive)
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
    const { rows, unavailable } = confirmFollows({ kind, author, items, peeked })
    // Names only, after the proofs: a failed one leaves the row to the names
    // cache and never fails the page.
    for (const chunk of namePeeks(kind, author, own, rows, value.authors)) {
      try {
        await peekAll(request, [chunk], peeked, alive)
      } catch {}
      if (!alive()) return null
    }
    return { value, rows: decorate(rows, peeked), unavailable, peeked }
  }, [author, kind, own, request, blocks.has])

  const load = useCallback(async (refreshing) => {
    if (!hosted || author === null) return
    const mine = ++gen.current
    const alive = () => gen.current === mine
    patch(refreshing
      ? { refreshing: true, loadingMore: false }
      : { phase: 'loading', refreshing: false, loadingMore: false, error: '' })
    const page = await readPage(null, alive)
    if (page === null) return
    if (!page.value) {
      const fail = page.unsupported ? { unsupported: true } : { error: page.error }
      if (listRef.current.rows.length > 0) patch({ ...fail, phase: 'ready', refreshing: false })
      else patch({ ...fail, phase: 'error', refreshing: false })
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
    // The names cache carries the seeder's page hint for MemberRow's badge.
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

  // Also covers the connection coming back.
  useEffect(() => {
    if (!hosted || !active || online === false || phase !== 'idle') return
    load(false)
  }, [hosted, active, online, phase, load])

  // The pills: the own follow set, read once and after a follow change.
  const { follows, load: loadFollows, mark: markFollow } = useFollowSet(request)
  const followsRef = useRef(follows)
  followsRef.current = follows
  const markKnown = (key, on) => { if (followsRef.current !== null) markFollow(key, on) }
  const followsVersion = typeof node.followsVersion === 'number' ? node.followsVersion : 0
  useEffect(() => {
    if (hosted && active) loadFollows()
  }, [hosted, active, followsVersion, loadFollows])

  const follow = useAction()
  const remove = useAction()
  const [pendingKey, setPendingKey] = useState(null)
  // Set synchronously: a second press in the same frame must neither send,
  // toast nor clear the row still in flight.
  const followBusy = useRef(false)

  // One attempt each; never retried automatically.
  const doFollow = async (hit) => {
    if (hit.author === own || followBusy.current) return
    followBusy.current = true
    setDone('')
    setPendingKey(hit.author)
    try {
      const r = await follow.run(() => request('follow.add', { key: hit.author }))
      if (r.ok) {
        markKnown(hit.author, true)
        const title = displayText(whoOf({ name: hit.name, username: hit.username }).title)
        notify(r.value.changed ? 'Agora você segue ' + title + '.' : 'Você já segue esta pessoa.')
        if (r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
        else loadFollows()
      } else {
        // A failed or uncertain answer: the set says what really happened.
        notify(FOLLOW_FAILED(r))
        loadFollows()
      }
    } finally {
      followBusy.current = false
      setPendingKey(null)
    }
  }

  const doUnfollow = async (hit) => {
    setDone('')
    setPendingKey(hit.author)
    try {
      const r = await remove.run(() => request('follow.remove', { key: hit.author }))
      if (r.ok) {
        markKnown(hit.author, false)
        notify(r.value.changed ? 'Você deixou de seguir.' : 'Você já não seguia esta pessoa.')
        if (r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
      } else {
        // A failed or uncertain answer: the set says what really happened.
        loadFollows()
      }
    } finally {
      setPendingKey(null)
    }
  }

  const refresh = () => {
    load(true)
    loadFollows()
  }

  // The names cache first (what the filter matches), then what the peek said.
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])
  const personOf = useCallback((key) => {
    const cached = profileOf(key)
    if (cached && (cached.name || cached.username)) return cached
    const row = byKey.get(key)
    if (row && (row.name || row.username)) return { name: row.name, username: row.username }
    return cached
  }, [profileOf, byKey])

  const filtering = text.trim() !== ''
  const rowKeys = useMemo(() => rows.map((r) => r.key), [rows])
  const shownKeys = useMemo(() => filterPeople(rowKeys, personOf, text), [rowKeys, personOf, text])
  const shownRows = useMemo(() => {
    if (!filtering) return rows
    const keep = new Set(shownKeys)
    return rows.filter((r) => keep.has(r.key))
  }, [filtering, rows, shownKeys])

  const unresolvedKeys = useMemo(() => rowKeys.filter((k) => personOf(k) === undefined), [rowKeys, personOf])
  const unresolved = unresolvedKeys.length
  const unresolvedTag = unresolvedKeys.join(',')

  // A failed profile read is never cached and the names cache retries only on
  // its own events, so while the filter needs names it asks again.
  useEffect(() => {
    if (!filtering || unresolved === 0 || !isTop || !active) return
    const timer = setInterval(() => resolveMany(unresolvedKeys), NAMES_RETRY_MS)
    return () => clearInterval(timer)
  }, [filtering, unresolvedTag, resolveMany, isTop, active])

  const title = PESSOAS_TITLE[kind]
  const top = <TopBar title={title} onBack={onBack} right={<HelpButton doc={HELP.diario} />} />

  if (!hosted) {
    return (
      <View style={styles.flex}>
        {top}
        <OfflineNote />
        <EmptyState icon='gente' title={title} body={NOT_HOSTED} />
      </View>
    )
  }

  const ready = phase === 'ready'
  const atEnd = next === null
  const count = ready ? countLabel(total) : ''
  const notes = ready ? notesOf({ ...meta, unavailable }) : []
  const changing = follow.pending || remove.pending

  const header = (
    <View style={styles.head}>
      <SearchField
        label={FILTER_LABEL}
        placeholder={FILTER_PLACEHOLDER}
        value={text}
        onChangeText={setText}
        maxLength={80}
        right={<HelpButton doc={FILTER_HELP} />}
      />
      {count ? <Text style={styles.count}>{count}</Text> : null}
      {notes.map((line) => <Soft key={line}>{line}</Soft>)}
      {rows.length > 0 && error ? <ErrorState message={displayText(error)} onRetry={() => load(true)} pending={refreshing} /> : null}
      <Notice>{done}</Notice>
      <ErrorText>{follow.error || remove.error}</ErrorText>
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
      // While a page loads or failed, the footer owns the spinner and the retry.
      const onAction = loadingMore || moreError ? undefined : loadMore
      empty = <EmptyState icon='gente' title='Ninguém conferido até aqui' body='A lista continua.' actionLabel={onAction ? 'mostrar mais' : undefined} onAction={onAction} />
    } else if (total === 0 && meta.indexing !== true && meta.complete !== false) {
      empty = (
        <EmptyState
          icon='gente'
          title={kind === 'seguidores' ? 'Ninguém segue ainda' : 'Não segue ninguém ainda'}
          body={kind === 'seguidores' ? 'Quando alguém seguir, aparece aqui.' : 'Quando seguir alguém, aparece aqui.'}
        />
      )
    } else if (unavailable === 0 && (meta.indexing === true || meta.complete === false)) {
      // Nothing was refused: the seeder has not finished, not a failed check.
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
      empty = <EmptyState icon='gente' title='Ninguém pôde ser conferido agora' body='Tente de novo em instantes.' actionLabel='tentar de novo' onAction={() => load(false)} />
    }
  } else if (filtering && shownRows.length === 0) {
    empty = (
      <View style={styles.note}>
        <Soft>
          {unresolved > 0
            ? 'Carregando nomes…'
            : atEnd ? FILTER_EMPTY : 'Ninguém com esse nome entre os já carregados.'}
        </Soft>
      </View>
    )
  }

  // No automatic continuation over an empty list: there the 'mostrar mais'
  // of the empty view is the only way forward.
  const canLoadMore = online !== false && ready && next !== null && !moreError && rows.length > 0

  const renderItem = ({ item }) => {
    const profile = personOf(item.key) || { name: null, username: null }
    if (item.key === own) return <OwnRow row={item} own={own} profile={profile} onOpen={onOpenMember} />
    const hit = { author: item.key, name: profile.name || null, username: profile.username || null }
    return (
      <MemberRow
        hit={hit}
        hint={profileOf(item.key)}
        avatar={pickAvatar(profileOf(item.key), item)}
        following={follows === null ? null : follows.has(item.key)}
        onOpen={onOpenMember}
        onFollow={doFollow}
        onUnfollow={doUnfollow}
        pending={pendingKey === item.key}
        disabled={changing}
      />
    )
  }

  return (
    <View style={styles.flex}>
      {top}
      <OfflineNote />
      <RefreshableList
        data={shownRows}
        extraData={[personOf, follows, pendingKey, changing]}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={ready
          ? (
            <ListFooter
              loading={loadingMore}
              atEnd={atEnd && rows.length > 0}
              endText={END_TEXT}
              error={moreError}
              onRetry={loadMore}
              pending={loadingMore}
            />
            )
          : null}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={refresh}
        refreshing={refreshing}
        // Each page costs seeder reads and peeks: only while this screen is seen.
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
  head: { paddingHorizontal: 16, paddingVertical: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
  count: { ...type.postName, color: colors.ink },
  note: { paddingHorizontal: 16, paddingVertical: 12 },
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
