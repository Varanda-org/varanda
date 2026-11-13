// Chips under a message, and the quick row for an actions sheet header.
// ReactionChips: { reactions, onToggle, onShowWho, disabled }
// QuickReactions: { mine, onPick, onMore }
// The row does not close the sheet. The header slot's closeThen has to run
// first, or a sheet opened from here would stack on the one still leaving.

import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { QUICK, reactionChips, reactionName } from '../reactions'
import { PressScale } from './PressScale'
import { useStyles } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

const CHIP_MIN = 32
// The pressable is layout.hit tall because the web ignores hitSlop, so a
// 32 pt chip cannot grow to the 44 pt target that way. The slop only fills
// the gap beside a short chip and stays off the line above it.
const CHIP_SLOP = { top: 0, bottom: 0, left: space.xs, right: space.xs }

export function ReactionChips ({ reactions, onToggle, onShowWho, disabled }) {
  const styles = useStyles(makeStyles)
  const chips = reactionChips(reactions)
  if (chips.length === 0) return null
  const off = disabled === true
  return (
    <View style={styles.row}>
      {chips.map((chip) => (
        <PressScale
          key={chip.emoji}
          disabled={off}
          hitSlop={CHIP_SLOP}
          accessibilityLabel={displayText(chip.label)}
          accessibilityState={{ selected: chip.mine === true }}
          onPress={() => {
            if (off || typeof onToggle !== 'function') return
            onToggle(chip.emoji)
          }}
          onLongPress={() => {
            if (off || typeof onShowWho !== 'function') return
            onShowWho(chip.emoji)
          }}
          style={[styles.hit, off && styles.dim]}
        >
          <View style={[styles.chip, chip.mine ? styles.mine : styles.other]}>
            <Text style={[styles.emoji, chip.mine ? styles.mineText : styles.otherText]}>{displayText(chip.emoji)}</Text>
            <Text style={[styles.count, chip.mine ? styles.mineText : styles.otherText]}>{chip.count}</Text>
          </View>
        </PressScale>
      ))}
    </View>
  )
}

export function QuickReactions ({ mine, onPick, onMore }) {
  const styles = useStyles(makeStyles)
  const pick = (emoji) => {
    if (typeof onPick === 'function') onPick(emoji)
  }
  const more = () => {
    if (typeof onMore === 'function') onMore()
  }
  return (
    <View style={styles.quick}>
      {QUICK.map((emoji) => {
        const on = mine === emoji
        return (
          <PressScale
            key={emoji}
            accessibilityLabel={reactionName(emoji)}
            accessibilityState={{ selected: on }}
            onPress={() => pick(emoji)}
            style={[styles.quickHit, on && styles.quickOn]}
          >
            <Text style={styles.quickEmoji}>{emoji}</Text>
          </PressScale>
        )
      })}
      <PressScale accessibilityLabel='mais reações' onPress={more} style={styles.quickHit}>
        <Text style={styles.more}>+</Text>
      </PressScale>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm
  },
  hit: { minHeight: layout.hit, justifyContent: 'center' },
  dim: { opacity: 0.45 },
  chip: {
    minHeight: CHIP_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  mine: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoft },
  other: { backgroundColor: colors.inputOff, borderColor: colors.line },
  emoji: { fontSize: 16, lineHeight: 20 },
  count: { ...type.chip },
  mineText: { color: colors.accent },
  otherText: { color: colors.ink },
  // space.sm (8 on each side) leaves each of seven targets at 43.4 pt on a
  // 320 pt screen, under 44. space.xs keeps 7 x 44 (308) inside 320.
  quick: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.xs,
    paddingBottom: space.sm
  },
  quickHit: {
    flex: 1,
    minHeight: layout.hit,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill
  },
  quickOn: { backgroundColor: colors.accentSoft },
  quickEmoji: { fontSize: 26, lineHeight: 32 },
  more: { fontSize: 24, lineHeight: 32, fontWeight: '600', color: colors.ink }
})
