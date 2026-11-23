import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { HelpButton } from './Help'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

// The community twin of GroupShelf: a card per community, with its member
// count and join mode in `meta`, opening the community screen.
export function CommunityShelf ({ title, orderText, note, items, onOpen }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { width } = useWindowDimensions()
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return null

  const cardWidth = Math.min(240, Math.max(layout.hit, width - 2 * space.lg))
  return (
    <View style={styles.wrap}>
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole='header'>{title}</Text>
        {orderText ? <HelpButton doc={{ title: 'Ordem de ' + title, paragraphs: [orderText] }} size={18} /> : null}
      </View>
      {note ? <Text style={styles.description}>{note}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps='handled'>
        {list.map((item) => {
          const name = displayText(item.name)
          const { meta } = item
          return (
            <PressScale
              key={item.community}
              accessibilityRole='button'
              accessibilityLabel={[name, meta].filter(Boolean).join(', ')}
              onPress={() => { if (typeof onOpen === 'function') onOpen(item.community) }}
              style={[styles.card, { width: cardWidth }]}
            >
              <View style={styles.cardHeader}>
                <Icon name='casa' size={18} color={colors.soft} />
                <View style={styles.names}>
                  <Text style={styles.name} numberOfLines={2}>{name}</Text>
                </View>
              </View>
              {meta ? <Text style={styles.detail}>{meta}</Text> : null}
            </PressScale>
          )
        })}
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { paddingTop: space.md, paddingBottom: space.sm, gap: space.xs },
  heading: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.lg },
  title: { ...type.section, color: colors.soft, flexShrink: 1 },
  description: { ...type.meta, color: colors.soft, paddingHorizontal: space.lg },
  row: { paddingHorizontal: space.lg, gap: space.sm },
  card: {
    minHeight: layout.hit,
    padding: space.md,
    gap: space.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  names: { flex: 1 },
  name: { ...type.postName, color: colors.ink },
  detail: { ...type.caption, color: colors.soft }
})
