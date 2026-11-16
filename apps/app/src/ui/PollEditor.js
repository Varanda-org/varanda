// The poll editor of the composer: 2 to 4 option fields of at most 60
// characters, with 'Adicionar opção' and a remove button on each field above
// two. The state and its rules live in ../polls (editor*); the screen reads
// the poll with editorPoll and checks the words with wordCheck before sending.
// Every control is a 44 pt target.

import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { editorAddOption, editorCanAdd, editorCanRemove, editorPoll, editorRemoveOption, editorSetOption, POLL_OPTION_MAX } from '../polls'
import { Icon } from './Icon'
import { layout, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

// state: { options: [string] } (../polls editorInit); onChange(next state);
// onClose removes the poll from the draft; disabled while a send runs.
export function PollEditor ({ state, onChange, onClose, disabled = false }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const options = state && Array.isArray(state.options) ? state.options : []
  const check = editorPoll(state)
  const canRemove = editorCanRemove(state)
  const change = typeof onChange === 'function' ? onChange : () => {}
  return (
    <View style={styles.box}>
      <View style={styles.head}>
        <Text style={styles.title}>Enquete</Text>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel='remover a enquete'
          accessibilityState={{ disabled: !!disabled }}
          disabled={disabled || typeof onClose !== 'function'}
          onPress={onClose}
          hitSlop={4}
          style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
        >
          <Icon name='fechar' size={20} color={colors.soft} />
        </Pressable>
      </View>
      {options.map((value, index) => (
        <View key={index} style={styles.line}>
          <TextInput
            style={styles.input}
            value={value}
            editable={!disabled}
            maxLength={POLL_OPTION_MAX}
            placeholder={'Opção ' + (index + 1)}
            placeholderTextColor={colors.placeholder}
            accessibilityLabel={'opção ' + (index + 1) + ' da enquete'}
            onChangeText={(text) => change(editorSetOption(state, index, text))}
          />
          {canRemove
            ? (
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={'remover a opção ' + (index + 1)}
                accessibilityState={{ disabled: !!disabled }}
                disabled={disabled}
                onPress={() => change(editorRemoveOption(state, index))}
                style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
              >
                <Icon name='fechar' size={18} color={colors.soft} />
              </Pressable>
              )
            : null}
        </View>
      ))}
      {editorCanAdd(state)
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='adicionar opção'
            accessibilityState={{ disabled: !!disabled }}
            disabled={disabled}
            onPress={() => change(editorAddOption(state))}
            style={({ pressed }) => [styles.add, pressed && styles.pressed]}
          >
            <Text style={styles.addText}>Adicionar opção</Text>
          </Pressable>
          )
        : null}
      {!check.ok && options.some((x) => typeof x === 'string' && x.trim() !== '')
        ? <Text style={styles.hint} accessibilityLiveRegion='polite'>{check.error}</Text>
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  box: { marginTop: 8, paddingVertical: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 12, gap: 4 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...type.postName, color: colors.ink },
  line: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: { ...type.postText, flex: 1, minHeight: layout.hit, color: colors.ink, paddingVertical: 8 },
  icon: { width: layout.hit, height: layout.hit, alignItems: 'center', justifyContent: 'center' },
  add: { minHeight: layout.hit, justifyContent: 'center' },
  addText: { ...type.more, color: colors.accent },
  hint: { ...type.meta, color: colors.soft },
  pressed: { opacity: 0.6 }
})
