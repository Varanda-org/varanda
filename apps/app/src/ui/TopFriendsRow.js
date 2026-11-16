// Melhores amigos on a profile: the hook that reads what the seeder points at
// and checks it, and the row that shows it.
//
// The seeder only names the owner's top-friends block and, for each friend,
// the latest follow block of that friend in their own diary. Every block is
// re-read with diary.peek and judged here (fans.js assembleTop): another
// reader sees a friend only when the friend follows the owner back, and the
// owner also sees the ones still waiting ('esperando seguir de volta'). A
// block that cannot be read shows nothing about that person, never the
// seeder's word. Hosted nodes only: elsewhere nothing is read.

import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { diaryPeekSlots } from '../engagement'
import { assembleTop, planTopPeeks } from '../fans.js'
import { TEXTS } from '../fansView.js'
import { useBlocks } from '../blocksProvider'
import { useNames } from '../names'
import { whoOf } from '../who'
import { Soft } from './index'
import { Avatar } from './Avatar'
import { Pill } from './Pill'
import { layout, radius, space, type } from './theme'
import { useStyles } from './ThemeProvider'

const ITEM_WIDTH = 88

// `index` is the answer of /index/profile/<owner> (the `top` of it is the
// pointer), `enabled` false reads nothing. Returns { view, phase }: view the
// assembleTop view, or null while nothing is known; phase 'idle', 'loading',
// 'ready' or 'failed' (a read that threw: the view then stays what it was).
export function useTopFriends ({ owner, ownKey, index, request, enabled }) {
  const blocks = useBlocks()
  const [state, setState] = useState({ view: null, phase: 'idle' })
  const tag = JSON.stringify([owner, index ? index.top : undefined, index ? index.complete : undefined, ownKey, enabled])
  useEffect(() => {
    if (!enabled || !index || typeof owner !== 'string' || owner === '') {
      setState({ view: null, phase: 'idle' })
      return undefined
    }
    let live = true
    const isBlocked = (key) => blocks.has(key)
    setState((s) => ({ view: s.view, phase: 'loading' }))
    const run = async () => {
      const peeks = new Map()
      for (const params of planTopPeeks({ owner, top: index.top, isBlocked })) {
        if (!live) return
        let got = null
        try {
          got = await diaryPeekSlots.run(() => (live ? request('diary.peek', params) : null), { front: true })
        } catch {}
        if (got && got.key === params.author) peeks.set(params.author, (peeks.get(params.author) || []).concat([got]))
      }
      if (!live) return
      setState({ view: assembleTop({ owner, self: ownKey || null, top: index.top, peeks, isBlocked, complete: index.complete }), phase: 'ready' })
    }
    run().catch(() => { if (live) setState((s) => ({ view: s.view, phase: 'failed' })) })
    return () => { live = false }
    // blocks.keys is a new Set on every change: a friend blocked or unblocked
    // now is planned and judged again at once.
  }, [tag, blocks.keys, request])
  return state
}

function Item ({ row, profile, onOpen }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  const title = displayText(who.title)
  const open = typeof onOpen === 'function'
    ? () => onOpen(row.key, { name: profile ? profile.name : null, username: profile ? profile.username : null })
    : undefined
  return (
    <Pressable
      style={({ pressed }) => [styles.item, pressed && open && styles.pressed]}
      accessibilityRole='link'
      accessibilityLabel={'ver o perfil de ' + title + (row.label ? ', ' + row.label : '')}
      disabled={!open}
      onPress={open}
    >
      <Avatar name={who.avatarName} publicKey={row.key} size={48} picture={(profile || {}).avatar} />
      <Text style={styles.name} numberOfLines={2}>{title}</Text>
      {row.label ? <Text style={styles.wait}>{row.label}</Text> : null}
    </Pressable>
  )
}

// `rows` [{ key, slot, status, label }] in the owner's order. `mine` shows the
// 'Editar' button (`onEdit`) and the empty line; for another reader an empty
// list without a `notice` renders nothing at all. `notice` the assembleTop
// view's line (unreadable, incomplete, indexing), shown under the list.
// `loading` keeps the card quiet while the first read runs.
export function TopFriendsRow ({ rows, mine = false, onEdit, onOpen, loading = false, notice = null }) {
  const styles = useStyles(makeStyles)
  const names = useNames()
  const list = Array.isArray(rows) ? rows : []
  const tag = list.map((r) => r.key).join(',')
  const { resolveMany, profileOf } = names
  useEffect(() => {
    if (list.length > 0) resolveMany(list.map((r) => r.key))
  }, [tag, resolveMany])
  const waiting = list.some((r) => r.status === 'pending')
  const line = typeof notice === 'string' && notice !== '' ? notice : null
  if (!mine && list.length === 0 && line === null) return null
  if (!mine && loading) return null
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title} accessibilityRole='header'>{TEXTS.topTitle}</Text>
        {mine && typeof onEdit === 'function'
          ? <Pill small label={list.length === 0 ? TEXTS.topChoose : TEXTS.topEdit} onPress={onEdit} />
          : null}
      </View>
      {list.length === 0
        ? (mine && line === null ? <Soft>{loading ? TEXTS.loadingMarks : TEXTS.topEmptyOwn}</Soft> : null)
        : (
          <View style={styles.items}>
            {list.map((row) => <Item key={row.key} row={row} profile={profileOf(row.key)} onOpen={onOpen} />)}
          </View>
          )}
      {line !== null ? <Soft>{line}</Soft> : null}
      {mine && waiting ? <Soft>{TEXTS.topOwnerNote}</Soft> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: space.md, gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, minHeight: layout.hit },
  title: { ...type.section, color: colors.soft, flexShrink: 1 },
  items: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  item: { width: ITEM_WIDTH, minHeight: layout.hit, alignItems: 'center', gap: space.xs, paddingVertical: space.xs },
  pressed: { opacity: 0.6 },
  name: { ...type.meta, color: colors.ink, textAlign: 'center' },
  wait: { ...type.caption, color: colors.soft, textAlign: 'center' }
})
