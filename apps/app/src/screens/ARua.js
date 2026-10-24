// A Rua: the timeline of the followed diaries (feed.read, newest page only),
// newest first, one PostRow per publication (no cards).
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Platform, RefreshControl, StyleSheet, View } from 'react-native'
import { FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { atHandle, handleOf } from '../format'
import { ErrorText, Soft, colors, errorText, useAction, useBottomPad, useNow } from '../ui'
import { Pill } from '../ui/Pill'
import { PostRow } from '../ui/PostRow'

const STEP = 5

// A stop with one of these reasons may have brought new blocks. A
// 'preempted' stop is caused by our own reads (docs/rpc.md 6.1) and must
// never trigger a reload, or the screen would loop.
const RELOAD_REASONS = ['done', 'timeout', 'stopped']

// Feed skip reasons that come from the association's signed blocklist.
const MODERATION_REASONS = ['blocked', 'revoked-issuer']

export default function ARua ({ active, refresh, onReply }) {
  const node = useNode()
  const names = useNames()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const [limit, setLimit] = useState(FEED_LIMIT_DEFAULT)
  const [feed, setFeed] = useState(null)
  const [loadError, setLoadError] = useState('')
  const pull = useAction()
  // Only the answer of the latest read is applied.
  const seqRef = useRef(0)
  const limitRef = useRef(limit)
  limitRef.current = limit

  const { learnMany, resolve } = names
  const load = useCallback(async (n) => {
    const mine = ++seqRef.current
    try {
      const res = await node.request('feed.read', { limit: n })
      if (mine !== seqRef.current) return
      setFeed(res)
      setLoadError('')
      learnMany(res.items.map((i) => [i.author, i.name]))
      // resolve() skips the keys whose name is already known.
      for (const item of res.items) {
        if (item.replyTo) resolve(item.replyTo.author)
      }
    } catch (err) {
      if (mine === seqRef.current) setLoadError(errorText(err))
    }
  }, [node.request, learnMany, resolve])

  useEffect(() => { if (active) load(limit) }, [active, load, limit, refresh])

  // Reload after a sync run that ended on its own or was stopped.
  const stopped = node.sync.stopped
  const prevStoppedRef = useRef(stopped)
  useEffect(() => {
    if (stopped === prevStoppedRef.current) return
    prevStoppedRef.current = stopped
    if (active && stopped && RELOAD_REASONS.includes(stopped.reason)) load(limitRef.current)
  }, [stopped, active, load])

  const reload = () => pull.run(() => load(limitRef.current))

  const items = feed === null ? [] : feed.items.slice().reverse()
  const atEnd = feed !== null && feed.items.length >= limit && limit >= FEED_LIMIT_MAX
  // Diaries skipped by the association's moderation (B2: a blocked author,
  // or a certificate from a revoked issuer, member.js feedRead) get their own
  // sentence, without the key; every other reason, and the truncated rest,
  // keep the generic one.
  const blocked = feed === null ? 0 : feed.skipped.filter((s) => MODERATION_REASONS.includes(s.reason)).length
  const skipped = feed === null ? 0 : feed.skipped.length + feed.skippedTruncated - blocked
  const future = feed === null ? 0 : feed.future.length + feed.futureTruncated

  const onEndReached = () => {
    if (feed !== null && feed.items.length >= limit && limit < FEED_LIMIT_MAX) {
      setLimit((n) => Math.min(FEED_LIMIT_MAX, n + STEP))
    }
  }

  const header = (
    <View>
      {loadError ? <View style={styles.pad}><ErrorText>{loadError}</ErrorText></View> : null}
      {feed === null && !loadError ? <View style={styles.pad}><Soft>carregando…</Soft></View> : null}
      {feed !== null && items.length === 0 ? <View style={styles.pad}><Soft>Nada por aqui ainda. Siga alguém e sincronize.</Soft></View> : null}
      {Platform.OS === 'web'
        ? <View style={styles.webBar}><Pill label='atualizar' onPress={reload} pending={pull.pending} /></View>
        : null}
    </View>
  )

  const footer = (
    <View style={styles.footer}>
      {atEnd ? <Soft>As publicações mais antigas não estão disponíveis nesta versão.</Soft> : null}
      {blocked > 0 ? <Soft>{String(blocked) + (blocked === 1 ? ' diário seguido não aparece (bloqueado pela associação)' : ' diários seguidos não aparecem (bloqueados pela associação)')}</Soft> : null}
      {skipped > 0 ? <Soft>{String(skipped) + (skipped === 1 ? ' diário seguido não aparece (sem certificado válido ou com dados inválidos)' : ' diários seguidos não aparecem (sem certificado válido ou com dados inválidos)')}</Soft> : null}
      {future > 0 ? <Soft>{String(future) + (future === 1 ? ' publicação com data futura foi ignorada' : ' publicações com data futura foram ignoradas')}</Soft> : null}
    </View>
  )

  // Rows re-render when a name is learned or the clock ticks.
  const extra = useMemo(() => ({ nameOf: names.nameOf, now }), [names.nameOf, now])

  const renderItem = ({ item }) => (
    <PostRow
      author={item.author}
      name={item.name}
      username={item.username}
      at={item.at}
      text={item.text}
      replyToName={item.replyTo ? (names.nameOf(item.replyTo.author) || handleOf(item.replyTo.author)) : null}
      now={now}
      onReply={() => onReply({ ref: item.author + ':' + item.seq, name: item.name || atHandle(item.username, item.author), text: item.text })}
    />
  )

  return (
    <FlatList
      style={styles.list}
      data={items}
      keyExtractor={(item) => item.author + ':' + item.seq}
      renderItem={renderItem}
      extraData={extra}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      contentContainerStyle={{ paddingBottom: bottomPad }}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      keyboardShouldPersistTaps='handled'
      refreshControl={Platform.OS === 'web'
        ? undefined
        : <RefreshControl refreshing={pull.pending} onRefresh={reload} tintColor={colors.accent} colors={[colors.accent]} />}
    />
  )
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 16 },
  webBar: { paddingHorizontal: 16, paddingVertical: 8, alignItems: 'flex-end' },
  footer: { padding: 16, gap: 8 }
})
