// Varandas da rua (entry { screen: 'varandinha-rua' }): the balconies of the
// people the viewer follows who play the Varandinha, in the seeder's key
// order, 20 a page. Hosted nodes only. The list is a seeder claim: a key
// shows only when the viewer's own follow.list holds it, and each balcony is
// read and verified when it is opened (Varandinha.js). A next page loads
// only on an explicit tap, never as a chain, and nothing here writes.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useBlocks } from '../blocksProvider'
import { readFollowKeys } from '../follow'
import { streetKeys } from '../garden'
import { fetchGardenStreet } from '../indexClient'
import { useNames } from '../names'
import { useNode } from '../node'
import { NOT_HOSTED } from '../pessoas'
import { whoOf } from '../who'
import { NOTICES, STREET_TITLE } from '../varandinhaView'
import { Soft, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { layout, space, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

const HEX64 = /^[0-9a-f]{64}$/
const OFFLINE = 'Sem conexão. Tente de novo quando a internet voltar.'
const UNAVAILABLE = 'Não deu para abrir as varandas da rua agora.'
const MORE = 'Carregar mais'
const EMPTY_TITLE = 'Nenhuma varanda por aqui ainda'
const EMPTY_BODY = 'Quando alguém que você segue entrar na Varandinha, a varanda aparece aqui.'
const ROW_HINT = 'ver a varanda de '

// A failed index read, as the person reads it.
function failureOf (reason) {
  if (reason === 'not-found') return NOTICES.unreachable
  if (reason === 'network' || reason === 'timeout') return OFFLINE
  return UNAVAILABLE
}

function StreetRow ({ keyHex, profile, onOpen }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  const title = displayText(who.title)
  return (
    <Pressable
      accessibilityRole='link'
      accessibilityLabel={ROW_HINT + title}
      onPress={() => onOpen(keyHex)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar name={who.avatarName} publicKey={keyHex} size={44} picture={(profile || {}).avatar} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
      </View>
    </Pressable>
  )
}

export default function VarandinhaRua ({ ownKey, onBack, onOpenBalcony }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const hosted = node.hosted === true
  const names = useNames()
  // The names cache changes as profiles arrive; the list is not read again
  // for that.
  const namesRef = useRef(names)
  namesRef.current = names
  const blocks = useBlocks()
  const bottom = useBottomPad()
  const blockedRef = useRef(blocks.has)
  blockedRef.current = blocks.has
  const blocksKnown = blocks.loadState !== 'pending'
  const self = typeof ownKey === 'string' && HEX64.test(ownKey.toLowerCase()) ? ownKey.toLowerCase() : null
  const [view, setView] = useState({ phase: 'loading', keys: [], next: null, error: null, more: false, indexing: false, complete: true })
  const [refreshing, setRefreshing] = useState(false)
  const held = useRef({ next: null, follows: null })
  const seq = useRef(0)
  const requestRef = useRef(node.request)
  requestRef.current = node.request

  const load = useCallback(async (more) => {
    if (!hosted || !blocksKnown || self === null) return
    const mine = ++seq.current
    const alive = () => mine === seq.current
    const cursor = more ? held.current.next : null
    setView((v) => ({ ...v, phase: more || v.keys.length > 0 ? v.phase : 'loading', more, error: null }))
    // The follow set is read again on every first page and kept for the next
    // ones; a failed read shows no unchecked key.
    const known = more ? held.current.follows : null
    const [res, follows] = await Promise.all([
      fetchGardenStreet(self, cursor),
      known || readFollowKeys(requestRef.current, FOLLOW_LIMIT_MAX)
    ])
    if (!alive()) return
    if (!res.ok || follows === null) {
      const error = res.ok ? UNAVAILABLE : failureOf(res.reason)
      setView((v) => ({ ...v, phase: v.keys.length > 0 ? 'ready' : 'error', more: false, error }))
      return
    }
    held.current = { next: res.value.next, follows }
    const fresh = streetKeys(res.value.items, follows)
    if (namesRef.current) namesRef.current.resolveMany(fresh)
    setView((v) => {
      const seen = new Set(more ? v.keys : [])
      const keys = more ? v.keys.slice() : []
      for (const k of fresh) {
        if (seen.has(k)) continue
        seen.add(k)
        keys.push(k)
      }
      return { phase: 'ready', keys, next: res.value.next, error: null, more: false, indexing: res.value.indexing, complete: res.value.complete }
    })
  }, [hosted, blocksKnown, self])

  useEffect(() => {
    load(false)
    return () => { seq.current += 1 }
  }, [load])

  const bar = <TopBar title={STREET_TITLE} onBack={onBack} />
  if (!hosted) {
    return (
      <View style={styles.screen}>
        {bar}
        <EmptyState icon='gente' title={STREET_TITLE} body={NOT_HOSTED} />
      </View>
    )
  }

  // The viewer and blocked people never show, whenever the block list changes.
  const rows = view.keys.filter((k) => k !== self && !blockedRef.current(k))
  let empty = null
  if (self === null) empty = <ErrorState message={UNAVAILABLE} />
  else if (view.phase === 'loading') empty = <Skeleton rows={3} />
  else if (view.phase === 'error') empty = <ErrorState message={view.error || UNAVAILABLE} onRetry={() => load(false)} />
  // While the index is still built or the answer is partial, the note says so
  // instead of an empty street.
  else if (view.next === null && !view.indexing && view.complete !== false) empty = <EmptyState icon='gente' title={EMPTY_TITLE} body={EMPTY_BODY} />

  let note = null
  if (view.phase === 'ready') {
    if (view.error) note = view.error
    else if (view.indexing) note = NOTICES.indexing
    else if (view.complete === false) note = NOTICES.incomplete
  }
  const header = note ? <View style={styles.notice}><Soft>{note}</Soft></View> : null
  const footer = view.next && view.phase === 'ready'
    ? <View style={styles.more}><Pill label={MORE} pending={view.more} onPress={() => load(true)} /></View>
    : null

  return (
    <View style={styles.screen}>
      {bar}
      <OfflineNote />
      <RefreshableList
        data={rows}
        keyExtractor={(k) => k}
        renderItem={({ item }) => <StreetRow keyHex={item} profile={names ? names.profileOf(item) : null} onOpen={onOpenBalcony} />}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingBottom: bottom }}
        onRefresh={async () => {
          setRefreshing(true)
          try { await load(false) } finally { setRefreshing(false) }
        }}
        refreshing={refreshing}
        atEnd
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  notice: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  more: { paddingHorizontal: space.lg, paddingVertical: space.md, alignItems: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit, paddingVertical: space.sm, paddingHorizontal: space.lg },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.rowName, color: colors.ink },
  handle: { ...type.caption, color: colors.soft }
})
