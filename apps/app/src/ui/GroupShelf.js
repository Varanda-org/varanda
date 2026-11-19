import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

export function GroupShelf ({ title, orderText, note, items, onOpen }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { width } = useWindowDimensions()
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return null

  const cardWidth = Math.min(240, Math.max(layout.hit, width - 2 * space.lg))
  return (
    <View style={styles.wrap}>
      <Text style={styles.title} accessibilityRole='header'>{title}</Text>
      <Text style={styles.description}>{orderText}</Text>
      {note ? <Text style={styles.description}>{note}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps='handled'>
        {list.map((item) => {
          const name = displayText(item.name)
          const communityName = displayText(item.communityName)
          const { meta, reason } = item
          return (
            <PressScale
              key={item.group}
              accessibilityRole='button'
              accessibilityLabel={[name, communityName, meta, reason].filter(Boolean).join(', ')}
              onPress={() => { if (typeof onOpen === 'function') onOpen(item.group) }}
              style={[styles.card, { width: cardWidth }]}
            >
              <View style={styles.cardHeader}>
                <Icon name='gente' size={18} color={colors.soft} />
                <View style={styles.names}>
                  <Text style={styles.name} numberOfLines={2}>{name}</Text>
                  <Text style={styles.detail} numberOfLines={1}>{communityName}</Text>
                </View>
              </View>
              {meta ? <Text style={styles.detail}>{meta}</Text> : null}
              {reason ? <Text style={styles.detail}>{reason}</Text> : null}
            </PressScale>
          )
        })}
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { paddingTop: space.md, paddingBottom: space.sm, gap: space.xs },
  title: { ...type.section, color: colors.soft, paddingHorizontal: space.lg },
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
