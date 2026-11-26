// Ajustes > Pessoas silenciadas: the member's own mute list, with Deixar de
// silenciar. A muted person is not blocked, so their name and picture come
// from the shared names cache like anywhere else. A name is raw peer text and
// goes through displayText.

import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useMutes } from '../mutesProvider'
import { MUTE_HELP, MUTE_TEXTS } from '../memberMutes'
import { useNames } from '../names'
import { useNode } from '../node'
import { whoOf } from '../who'
import { Avatar } from '../ui/Avatar'
import { ErrorText, Page, Soft, useAction } from '../ui'
import { HelpNote } from '../ui/Help'
import { Pill } from '../ui/Pill'
import { EmptyState } from '../ui/States'
import { useStyles } from '../ui/ThemeProvider'
import { space, type } from '../ui/theme'

function MutedRow ({ mutedKey, profile, pending, disabled, onUnmute }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile || {})
  const named = !!profile && (typeof profile.name === 'string' || typeof profile.username === 'string')
  const title = named ? displayText(who.title) : MUTE_TEXTS.unnamed
  return (
    <View style={styles.row}>
      <Avatar name={named ? who.avatarName : null} publicKey={mutedKey} size={44} picture={null} persist={false} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {named && who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
      </View>
      <Pill label={MUTE_TEXTS.unmute} pending={pending} disabled={disabled} onPress={onUnmute} />
    </View>
  )
}

export default function Silenciados ({ active }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const names = useNames()
  const mutes = useMutes()
  const act = useAction()
  const [unmuting, setUnmuting] = useState(null)
  const keys = [...mutes.keys]
  const list = keys.join(',')

  useEffect(() => {
    if (!active || list === '' || typeof names.resolveMany !== 'function') return
    names.resolveMany(list.split(','))
  }, [active, list, names])

  const unmute = async (key) => {
    setUnmuting(key)
    await act.run(() => mutes.setMute(key, false))
    setUnmuting(null)
  }

  return (
    <Page>
      <View style={styles.note}><HelpNote doc={MUTE_HELP}><Soft>{MUTE_TEXTS.listNote}</Soft></HelpNote></View>
      <ErrorText>{act.error}</ErrorText>
      {keys.length === 0
        ? <EmptyState icon='mudo' title={MUTE_TEXTS.emptyTitle} body={MUTE_TEXTS.emptyBody} />
        : keys.map((key) => (
          <MutedRow
            key={key}
            mutedKey={key}
            profile={names.profileOf(key) || null}
            pending={unmuting === key}
            disabled={unmuting !== null || node.online === false}
            onUnmute={() => unmute(key)}
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
