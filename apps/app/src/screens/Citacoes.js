// Citações: the posts that quote a post, pushed above the tabs (App.js screen
// stack, entry { screen: 'citacoes', key: ref }). The seeder's post index
// (src/indexClient.js fetchPost) only says where to look and lists at most the
// newest 50 quotes in one page; each row is verified with diary.peek (the
// author's own signed post quoting this one, src/quotes.js), so the index can
// hide a quote but never add one. It requests only when the node is hosted
// (node.hosted === true); a manual configuration or varanda-serve requests
// nothing. Nothing is persisted. A row opens the quoting post's conversation.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useBlocks } from '../blocksProvider'
import { withoutBlockedRefs } from '../memberBlocks'
import { useNames } from '../names'
import { fetchPost } from '../indexClient'
import { planPeeks } from '../thread'
import { SEEDER_DOWN, errorFor } from '../engagers'
import { relativeTime } from '../format'
import { END_TEXT, QUOTES_TITLE, confirmQuotes, countLabel, listView, notesOf } from '../quotes'
import { whoOf } from '../who'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { OfflineNote } from '../ui/OfflineNote'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { isSeederDown, learnPeeked, peekAll } from './Conversa'

// diary.peek refused by a node that cannot read on demand (native,
// varanda-serve, or an older node): the web-only view, not an error.
const isUnsupported = (err) => !!err && err.code === 'USAGE' &&
  (err.message === 'leitura sob demanda só na versão web' || err.message === 'método desconhecido')

function QuoteRow ({ row, now, onOpen }) {
  const styles = useStyles(makeStyles)
  const who = whoOf({ name: row.name, username: row.username })
  const title = displayText(who.title)
  const time = relativeTime(row.at, now) ?? displayText(row.at)
  const body = row.text !== '' ? displayText(row.text) : 'Publicação com foto ou vídeo'
  const open = typeof onOpen === 'function' ? () => onOpen({ ref: row.ref }) : undefined
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && open && styles.pressed]}
      accessibilityRole='link'
      accessibilityLabel={'ver a citação de ' + title + ', ' + time + '. ' + body}
      disabled={!open}
      onPress={open}
    >
      <Avatar name={who.avatarName} publicKey={row.author} size={48} picture={row.avatar} persist={false} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1} maxFontSizeMultiplier={2}>{title + ' · ' + time}</Text>
        {who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
        <Text style={styles.text} numberOfLines={5}>{body}</Text>
      </View>
    </Pressable>
  )
}

export default function Citacoes ({ entry, onBack, onOpenThread }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const blocks = useBlocks()
  const names = useNames()
  const bottomPad = useBottomPad()
  const now = useNow(60000)
  const focal = entry.key
  const hosted = node.hosted === true
  const online = node.online
  const { request } = node
  const { learnMany } = names
  const [state, setState] = useState({ phase: 'idle', rows: [], unconfirmed: 0, total: null, meta: { indexing: false, complete: true }, unsupported: false, refreshing: false, error: '' })
  const stateRef = useRef(state)
  // Only the latest read may commit.
  const gen = useRef(0)

  useEffect(() => () => { gen.current++ }, [])

  const patch = useCallback((p) => {
    stateRef.current = { ...stateRef.current, ...p }
    setState(stateRef.current)
  }, [])

  const load = useCallback(async (refreshing) => {
    if (!hosted) return
    const mine = ++gen.current
    const alive = () => gen.current === mine
    patch(refreshing ? { refreshing: true } : { phase: 'loading', refreshing: false, error: '' })
    const fail = (p) => patch({ ...p, phase: stateRef.current.rows.length > 0 ? 'ready' : 'error', refreshing: false })
    const res = await fetchPost(focal)
    if (!alive()) return
    if (!res.ok) return fail({ error: errorFor(res.reason) })
    const value = res.value
    const items = withoutBlockedRefs(value.quotes, blocks.has)
    const peeked = new Map()
    try {
      await peekAll(request, planPeeks({ refs: items, authors: value.authors }), peeked, alive)
    } catch (err) {
      if (!alive()) return
      if (isUnsupported(err)) return fail({ unsupported: true })
      return fail({ error: isSeederDown(err) ? SEEDER_DOWN : errorText(err) })
    }
    if (!alive()) return
    const { rows, unconfirmed } = confirmQuotes({ focal, items, peeked })
    patch({
      phase: 'ready',
      unsupported: false,
      rows,
      unconfirmed,
      total: value.quotesTotal,
      meta: { indexing: value.indexing, complete: value.complete },
      refreshing: false,
      error: ''
    })
    learnPeeked(learnMany, peeked)
  }, [hosted, focal, request, blocks.has, patch, learnMany])

  const { phase, rows, unconfirmed, total, meta, unsupported, refreshing, error } = state

  // Also covers the connection coming back.
  useEffect(() => {
    if (!hosted || online === false || phase !== 'idle') return
    load(false)
  }, [hosted, online, phase, load])

  const v = listView({ hosted, online, unsupported, phase, rows, unconfirmed, error, total, indexing: meta.indexing, complete: meta.complete })

  let empty = null
  if (v.view === 'loading') {
    empty = <Skeleton />
  } else if (v.view === 'error') {
    empty = <ErrorState message={displayText(v.message)} onRetry={() => load(false)} />
  } else if (v.view !== 'ready') {
    const retry = v.view === 'offline' || v.view === 'unchecked' || v.view === 'hidden'
    empty = (
      <EmptyState
        icon='republicar'
        title={v.title}
        body={v.body}
        actionLabel={retry ? v.action : undefined}
        onAction={retry ? () => load(false) : undefined}
      />
    )
  }

  const ready = phase === 'ready'
  const notes = ready && v.view !== 'hidden' ? notesOf({ ...meta, unconfirmed, total, listed: rows.length }) : []
  const listError = rows.length > 0 && error ? error : ''
  const header = notes.length > 0 || listError || (ready && rows.length > 0 && countLabel(total) !== '')
    ? (
      <View style={styles.head}>
        {ready && rows.length > 0 && countLabel(total) !== '' ? <Soft>{countLabel(total)}</Soft> : null}
        {notes.map((line) => <Soft key={line}>{line}</Soft>)}
        {listError ? <ErrorState message={displayText(listError)} onRetry={() => load(true)} pending={refreshing} /> : null}
      </View>
      )
    : null

  return (
    <View style={styles.flex}>
      <TopBar title={QUOTES_TITLE} onBack={onBack} />
      <OfflineNote />
      <View style={styles.flex}>
        <RefreshableList
          data={rows}
          keyExtractor={(row) => row.ref}
          renderItem={({ item }) => <QuoteRow row={item} now={now} onOpen={onOpenThread} />}
          extraData={now}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          ListFooterComponent={ready ? <ListFooter loading={false} atEnd={rows.length > 0} endText={END_TEXT} /> : null}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          onRefresh={hosted ? () => load(true) : undefined}
          refreshing={refreshing}
          atEnd
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
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16
  },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...type.rowName, color: colors.ink },
  handle: { ...type.meta, color: colors.soft },
  text: { ...type.postText, color: colors.ink }
})
