'use strict'

// Screen reader semantics of Publicar, Denunciar and the emoji panel (#153),
// pinned on the sources like the other composer tests.
const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const read = (name) => readFileSync(join(__dirname, '../src', name), 'utf8')

test('Pill announces `selected` only for a pill that is one choice of a few', (t) => {
  const src = read('ui/Pill.js')
  t.ok(src.includes('selected, small }) {'), 'the prop is taken')
  t.ok(src.includes('accessibilityState={selected === undefined ? { disabled: off } : { disabled: off, selected: selected === true }}'), 'no selected state unless asked')
})

test('Denunciar: the target choice is announced by the pill, not by a wrapper', (t) => {
  const src = read('screens/Denunciar.js')
  const choice = src.slice(src.indexOf('function ChoicePill'), src.indexOf('// react-native-web drops accessibilityState'))
  t.ok(choice.includes('<Pill label={label} filled={selected} selected={selected} onPress={onPress} />'), 'the Pill carries the state')
  t.absent(choice.includes('<View'), 'no wrapping View holds it')
})

test('Publicar: the acting-as radios are one named group and web reads their state', (t) => {
  const src = read('screens/Publicar.js')
  t.ok(src.includes("<View style={styles.asRow} accessibilityRole='radiogroup' accessibilityLabel='Publicar como'>"), 'the group has a name')
  const chip = src.slice(src.indexOf('function Chip ('), src.indexOf('// One attached item'))
  t.ok(chip.includes('accessibilityState={{ checked: on, disabled }}') && chip.includes('aria-checked={on}'), 'native and web checked state')
})

test('EmojiPicker: the group tabs sit in a tablist, web reads the selected one and an empty search is announced', (t) => {
  const src = read('ui/EmojiPicker.js')
  t.ok(src.includes("keyboardShouldPersistTaps='handled' accessibilityRole='tablist'>"), 'the tab row is a tablist')
  t.ok(src.includes('accessibilityState={{ selected: i === group }}\n              aria-selected={i === group}'), 'native and web selected state')
  t.ok(src.includes("<Text style={styles.empty} accessibilityLiveRegion='polite' aria-live='polite'>Nenhum emoji encontrado</Text>"), 'the empty result is a live region')
})
