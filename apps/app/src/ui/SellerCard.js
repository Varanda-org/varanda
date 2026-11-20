import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { PressScale } from './PressScale'
import { useStyles } from './ThemeProvider'
import { layout, space, type } from './theme'

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
  card: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line },
  author: { minHeight: layout.hit, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  details: { flex: 1, gap: space.xs },
  name: { ...type.postName, color: colors.ink },
  line: { ...type.postMeta, color: colors.soft },
  listings: { minHeight: layout.hit, justifyContent: 'center', paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.line },
  link: { ...type.pill, color: colors.accent }
})
