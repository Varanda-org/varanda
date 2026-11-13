import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { PressScale } from './PressScale'
import { useStyles } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

export function SellerCard ({ avatar, name, lines = [], onOpenAuthor, onOpenListings }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={styles.card}>
      <PressScale disabled={typeof onOpenAuthor !== 'function'} onPress={onOpenAuthor} style={styles.author}>
        {avatar}
        <View style={styles.details}>
          <Text style={styles.name}>{displayText(name || 'Quem anunciou')}</Text>
          {lines.map((line) => <Text key={line.key} style={styles.line}>{displayText(line.text)}</Text>)}
        </View>
      </PressScale>
      {typeof onOpenListings === 'function'
        ? (
          <PressScale onPress={onOpenListings} style={styles.listings}>
            <Text style={styles.link}>Ver todos os anúncios</Text>
          </PressScale>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.card },
  author: { minHeight: layout.hit, flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  details: { flex: 1, gap: space.xs },
  name: { ...type.postName, color: colors.ink },
  line: { ...type.postMeta, color: colors.soft },
  listings: { minHeight: layout.hit, justifyContent: 'center', padding: space.md, borderTopWidth: 1, borderTopColor: colors.line },
  link: { ...type.pill, color: colors.accent }
})
