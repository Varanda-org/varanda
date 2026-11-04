// The profile header shared by the own Diário and another person's profile:
// sunset band (optional back button, caller's buttons), the avatar rising into
// the band, name, @nome, bio, counts, a note and the action row. Callers pass
// display-safe strings (already through displayText), except `bio`: the raw
// peer text, which MentionText passes through displayText piece by piece so
// its links stay tappable, as in a post.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { MentionText } from './MentionText'
import { SunsetBand } from './SunsetBand'
import { fonts, type } from './theme'
import { useStyles } from './ThemeProvider'

export function ProfileHeader ({ bandHeight, topInset = 0, onBack, bandButtons, avatar, title, subtitle, bio, counts, note, actions }) {
  const styles = useStyles(makeStyles)
  const shownCounts = Array.isArray(counts) ? counts.filter((c) => c && c.value !== null && c.value !== undefined) : []
  const shownActions = Array.isArray(actions) ? actions.filter(Boolean) : []
  const a = avatar || {}
  return (
    <View>
      <SunsetBand height={bandHeight}>
        {/* At the top: the avatar row below rises 44 pt into the band from
            x=16 and is drawn later, so a bottom-left control would get no touches. */}
        {typeof onBack === 'function'
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel='voltar'
              hitSlop={8}
              onPress={onBack}
              style={[styles.back, { top: topInset + 8 }]}
            >
              <Icon name='voltar' size={22} color='#ffffff' />
            </Pressable>
            )
          : null}
        {bandButtons}
      </SunsetBand>
      {/* The row rises into the band (marginTop -44) and is drawn after it,
          so its empty space would take the band buttons' touches: only the
          avatar takes touches. */}
      <View style={styles.headRow} pointerEvents='box-none'>
        <Avatar name={a.name} publicKey={a.publicKey} size={88} picture={a.picture} persist={a.persist} ring />
      </View>
      <View style={styles.data}>
        {title ? <Text style={styles.name} accessibilityRole='header'>{title}</Text> : null}
        {subtitle ? <Text style={styles.keyText}>{subtitle}</Text> : null}
        {bio ? <MentionText text={bio} style={styles.bio} /> : null}
        {shownCounts.length > 0
          ? (
            <View style={styles.countsRow}>
              {shownCounts.map((c) => {
                const body = <><Text style={styles.countsNum}>{c.value}</Text> {c.label}</>
                return typeof c.onPress === 'function'
                  ? (
                    <Pressable
                      key={c.label}
                      accessibilityRole='link'
                      accessibilityLabel={`${c.value} ${c.label}`}
                      hitSlop={8}
                      onPress={() => c.onPress()}
                    >
                      <Text style={styles.counts}>{body}</Text>
                    </Pressable>
                    )
                  : <Text key={c.label} style={styles.counts}>{body}</Text>
              })}
            </View>
            )
          : null}
        {note || null}
        {shownActions.length > 0
          ? (
            <View style={styles.actions}>
              {shownActions.map((action, i) => <View key={i} style={styles.action}>{action}</View>)}
            </View>
            )
          : null}
      </View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  back: {
    position: 'absolute',
    left: 16,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.dim,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headRow: {
    marginTop: -44,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between'
  },
  data: { paddingTop: 10, paddingHorizontal: 16, paddingBottom: 12, gap: 2 },
  name: { ...type.profileName, fontFamily: fonts.title, color: colors.ink },
  keyText: { ...type.postMeta, color: colors.soft },
  bio: { ...type.postText, color: colors.ink, marginTop: 8 },
  countsRow: { flexDirection: 'row', gap: 16, marginTop: 8 },
  counts: { fontSize: 15, color: colors.soft },
  countsNum: { color: colors.ink, fontWeight: '700' },
  // Pill sets no width, so the column has to stretch it.
  // Wraps so a third pill (Seguir, Mensagem, denunciar a conta) takes a full
  // row on a 360 pt phone instead of squeezing its label onto two lines.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  action: { flexGrow: 1, flexBasis: 120, alignItems: 'stretch' }
})
