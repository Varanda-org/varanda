// Ajustes > Pessoas bloqueadas: the member's own block list, with Desbloquear.
// `active`: this screen is showing, so its names are read. A name is raw peer
// text and goes through displayText. No avatar picture: nothing here reads a
// blocked person's media.

import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { readBlockedPeek, useBlocks } from '../blocksProvider'
import { BLOCK_TEXTS } from '../memberBlocks'
import { useNames } from '../names'
import { useNode } from '../node'
import { whoOf } from '../who'
import { Avatar } from '../ui/Avatar'
import { ErrorText, Page, Soft, useAction } from '../ui'
import { Pill } from '../ui/Pill'
import { EmptyState } from '../ui/States'
import { useStyles } from '../ui/ThemeProvider'
import { space, type } from '../ui/theme'

function BlockedRow ({ blockedKey, profile, pending, disabled, onUnblock }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile || {})
  const named = !!profile && (typeof profile.name === 'string' || typeof profile.username === 'string')
  const title = named ? displayText(who.title) : BLOCK_TEXTS.unnamed
  return (
    <View style={styles.row}>
      <Avatar name={named ? who.avatarName : null} publicKey={blockedKey} size={44} picture={null} persist={false} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {named && who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
      </View>
      <Pill label={BLOCK_TEXTS.unblock} pending={pending} disabled={disabled} onPress={onUnblock} />
    </View>
  )
}

export default function Bloqueados ({ active }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const names = useNames()
  const blocks = useBlocks()
  const act = useAction()
  const [peeked, setPeeked] = useState(() => new Map())
  const [unblocking, setUnblocking] = useState(null)
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const keys = [...blocks.keys]
  const list = keys.join(',')

  // One at a time: the node allows few peeks in flight. A name not read leaves
  // the row as 'Alguém sem nome', and Desbloquear still works.
  useEffect(() => {
    if (!active || list === '') return
    let live = true
    const read = async () => {
      for (const key of list.split(',')) {
        if (!live) return
        let peek = null
        try { peek = await readBlockedPeek(requestRef.current, key) } catch {}
        if (!live) return
        if (peek === null) continue
        const name = peek.profile && typeof peek.profile.name === 'string' ? peek.profile.name : null
        const username = typeof peek.username === 'string' ? peek.username : null
        if (name !== null || username !== null) setPeeked((m) => new Map(m).set(key, { name, username }))
      }
    }
    read()
    return () => { live = false }
  }, [active, list])

  const unblock = async (key) => {
    setUnblocking(key)
    await act.run(() => blocks.setBlock(key, false))
    setUnblocking(null)
  }

  return (
    <Page>
      <View style={styles.note}><Soft>{BLOCK_TEXTS.listNote}</Soft></View>
      <ErrorText>{act.error}</ErrorText>
      {keys.length === 0
        ? <EmptyState icon='bloquear' title={BLOCK_TEXTS.emptyTitle} body={BLOCK_TEXTS.emptyBody} />
        : keys.map((key) => (
          <BlockedRow
            key={key}
            blockedKey={key}
            profile={peeked.get(key) || names.profileOf(key) || null}
            pending={unblocking === key}
            disabled={unblocking !== null || node.online === false}
            onUnblock={() => unblock(key)}
          />
        ))}
    </Page>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  note: { marginBottom: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56, paddingVertical: space.sm },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  handle: { ...type.postMeta, color: colors.soft }
})
