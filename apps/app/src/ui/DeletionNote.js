// The note of a deletion waiting for its date (Excluir conta asked without a
// passkey the account service could verify), with the look and slot of
// PushNote. It has no close button: a person who did not ask must see it on
// every signed-in device until the date or a cancel. onOpen leads to Ajustes
// > Excluir conta, where CancelarExclusao cancels it. Presentational only:
// the shell reads the date from /account/status.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { scheduleDate } from '../accountDeletion'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { type } from './theme'

export function DeletionNote ({ scheduled, onOpen, inset = false }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.note, inset && { paddingTop: 6 + insets.top }]}>
      <Icon name='lixeira' size={14} color={colors.soft} />
      <Text style={[styles.text, styles.grow]} numberOfLines={2}>{'Exclusão da conta agendada para ' + scheduleDate(scheduled)}</Text>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel='Ver ou cancelar a exclusão da conta'
        hitSlop={12}
        style={styles.fixed}
        onPress={onOpen}
      >
        <Text style={styles.action}>Ver</Text>
      </Pressable>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 16,
    backgroundColor: colors.warm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  text: { ...type.chip, color: colors.soft },
  action: { ...type.chip, color: colors.accent, fontWeight: '700' },
  grow: { flexShrink: 1 },
  fixed: { flexShrink: 0 }
})
