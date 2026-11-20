'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const src = readFileSync(join(__dirname, '..', 'src', 'ui', 'DateTimeField.js'), 'utf8')

test('date and time keep five labeled numeric cells and the time separator', (t) => {
  const cells = Array.from(src.matchAll(/\{ key: '(\w)', label: '([^']+)', max: (\d+), width: (\d+) \}/g), (match) => match.slice(1))
  t.alike(cells, [
    ['d', 'dia', '2', '52'],
    ['m', 'mês', '2', '52'],
    ['y', 'ano', '4', '72'],
    ['h', 'hora', '2', '52'],
    ['i', 'min', '2', '52']
  ])
  t.ok(/FIELD_ROW\.map[\s\S]*?<TextInput/.test(src), 'all five cells use the same input')
  t.ok(src.includes("index === 3 ? <Text style={styles.sep} importantForAccessibility='no'>às</Text>"))
  t.ok(src.includes("keyboardType='number-pad'") && src.includes("inputMode='numeric'"))
  t.ok(src.includes('maxLength={spec.max}') && src.includes('placeholder={spec.label}') && src.includes("accessibilityLabel={label + ', ' + spec.label}"))
})

test('each date and time cell uses a themed underline with focus and invalid states', (t) => {
  const input = /\binput: \{([^}]*)\}/.exec(src)[1]
  t.ok(input.includes('minHeight: 56') && input.includes('borderBottomWidth: 1') && input.includes('borderBottomColor: colors.controlOff'))
  t.absent(/\b(?:borderWidth|borderColor|borderRadius|backgroundColor):/.test(input))
  t.ok(/inputFocused: \{[^}]*borderBottomWidth: 2, borderBottomColor: colors\.accent/.test(src))
  t.ok(src.includes('onFocus={() => setFocused(spec.key)}') && src.includes('onBlur={() => setFocused('))
  t.ok(src.includes('const real = fieldsToMs(f) !== null') && src.includes('inputOff: { borderBottomColor: colors.danger }'))
  t.ok(src.includes('style={[styles.input, { width: spec.width }, !disabled && focused === spec.key && styles.inputFocused, !real && styles.inputOff]}'), 'invalid color takes precedence over focus')
})
