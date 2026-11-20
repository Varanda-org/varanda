import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { TOPIC_TREND_EMPTY, TOPIC_TREND_INDEXING, TOPIC_TREND_ORDER_TEXT, TOPIC_TREND_TITLE } from '../topicTrend'
import { HelpButton } from './Help'
import { PressScale } from './PressScale'
import { useStyles } from './ThemeProvider'
import { radius, space, type } from './theme'

export function TrendingTopics ({ rows, indexing, complete, onOpen }) {
  const styles = useStyles(makeStyles)
  const empty = indexing ? TOPIC_TREND_INDEXING : TOPIC_TREND_EMPTY
  const note = complete === false ? 'Ainda montando a lista; algum assunto pode faltar.' : rows.length === 0 ? empty : null
  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole='header'>{TOPIC_TREND_TITLE}</Text>
        <HelpButton doc={{ title: 'Ordem de ' + TOPIC_TREND_TITLE, paragraphs: [TOPIC_TREND_ORDER_TEXT] }} size={18} />
      </View>
      {rows.length > 0
        ? (
          <View style={styles.chips}>
            {rows.slice(0, 10).map(({ tag, label, meta }) => {
              const text = displayText(label)
              return (
                <PressScale
                  key={tag}
                  accessibilityRole='button'
                  accessibilityLabel={text + ', ' + meta}
                  onPress={() => onOpen(tag)}
                  style={styles.chip}
                >
                  <Text style={styles.label}>{text}</Text>
                  <Text style={styles.chipMeta}>{meta}</Text>
                </PressScale>
              )
            })}
          </View>
          )
        : null}
      {note !== null ? <Text style={styles.soft}>{note}</Text> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  section: { gap: space.xs, paddingVertical: space.sm },
  heading: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  title: { ...type.section, color: colors.soft, flexShrink: 1 },
  soft: { ...type.meta, color: colors.soft },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 40,
    maxWidth: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.xs,
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card
  },
  label: { ...type.pill, color: colors.ink, flexShrink: 1 },
  chipMeta: { ...type.meta, color: colors.soft, flexShrink: 1 }
})
