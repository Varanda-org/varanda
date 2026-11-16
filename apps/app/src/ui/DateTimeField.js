// A date and time field for the event editor, with no picker dependency: five
// numeric fields (dia, mês, ano, hora, minuto) in the device's local time and
// quick chips for the common choices (Hoje, Amanhã, os próximos sábado e
// domingo; 09:00, 12:00, 19:00, 20:00). The value is the plain fields object
// { d, m, y, h, i } of strings, so a half-typed value is kept as typed;
// fieldsToMs answers the instant or null when it is not a real date. Every
// control is a 44 pt target and nothing here moves.

import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { layout, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

const pad = (n) => String(n).padStart(2, '0')
const DAY_MS = 24 * 60 * 60 * 1000

// The fields of an instant (ms) in local time.
export function fieldsOf (ms) {
  const d = new Date(ms)
  return { d: pad(d.getDate()), m: pad(d.getMonth() + 1), y: String(d.getFullYear()), h: pad(d.getHours()), i: pad(d.getMinutes()) }
}

const whole = (s) => (typeof s === 'string' && /^\d{1,4}$/.test(s.trim()) ? Number(s) : null)

// The instant of the fields in local time, or null when a field is empty, not
// a number or the date does not exist (31 of April, 25 o'clock).
export function fieldsToMs (f) {
  if (!f || typeof f !== 'object') return null
  const day = whole(f.d)
  const month = whole(f.m)
  const year = whole(f.y)
  const hour = whole(f.h)
  const minute = whole(f.i)
  if ([day, month, year, hour, minute].some((n) => n === null)) return null
  if (String(f.y).trim().length !== 4) return null
  const date = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) return null
  return date.getTime()
}

// The next local day (0 = today) whose weekday is `weekday` (0 = domingo);
// today itself counts only when it is that weekday.
function nextWeekday (from, weekday) {
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const ahead = (weekday - base.getDay() + 7) % 7
  return new Date(base.getTime() + ahead * DAY_MS + 12 * 60 * 60 * 1000)
}

// The day chips: [{ label, date }] where date holds the local day.
export function dayChips (now = Date.now()) {
  const n = new Date(now)
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12)
  return [
    { label: 'Hoje', date: today },
    { label: 'Amanhã', date: new Date(today.getTime() + DAY_MS) },
    { label: 'Sábado', date: nextWeekday(n, 6) },
    { label: 'Domingo', date: nextWeekday(n, 0) }
  ]
}

export const TIME_CHIPS = Object.freeze([[9, 0], [12, 0], [19, 0], [20, 0]])

const FIELD_ROW = [
  { key: 'd', label: 'dia', max: 2, width: 52 },
  { key: 'm', label: 'mês', max: 2, width: 52 },
  { key: 'y', label: 'ano', max: 4, width: 72 },
  { key: 'h', label: 'hora', max: 2, width: 52 },
  { key: 'i', label: 'min', max: 2, width: 52 }
]

// label: 'Começa' or 'Termina'; value: fields; onChange(fields); disabled while
// a send runs. `now` only feeds the chips (a test passes one).
export function DateTimeField ({ label, value, onChange, disabled = false, now }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const change = typeof onChange === 'function' ? onChange : () => {}
  const f = value && typeof value === 'object' ? value : { d: '', m: '', y: '', h: '', i: '' }
  const chips = dayChips(now === undefined ? Date.now() : now)
  const dayMatches = (date) => f.d === pad(date.getDate()) && f.m === pad(date.getMonth() + 1) && f.y === String(date.getFullYear())
  const timeMatches = (h, i) => f.h === pad(h) && f.i === pad(i)
  const setDay = (date) => change({ ...f, d: pad(date.getDate()), m: pad(date.getMonth() + 1), y: String(date.getFullYear()) })
  const setTime = (h, i) => change({ ...f, h: pad(h), i: pad(i) })
  const real = fieldsToMs(f) !== null
  const chip = (text, on, press, spoken) => (
    <Pressable
      key={text}
      accessibilityRole='button'
      accessibilityLabel={spoken}
      accessibilityState={{ selected: on, disabled: !!disabled }}
      disabled={disabled}
      onPress={press}
      style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{text}</Text>
    </Pressable>
  )
  return (
    <View style={styles.box} accessibilityLabel={label}>
      <Text style={styles.label} accessibilityRole='header'>{label}</Text>
      <View style={styles.chips}>
        {chips.map((c) => chip(c.label, dayMatches(c.date), () => setDay(c.date), label + ': ' + c.label.toLowerCase()))}
      </View>
      <View style={styles.chips}>
        {TIME_CHIPS.map(([h, i]) => chip(pad(h) + ':' + pad(i), timeMatches(h, i), () => setTime(h, i), label + ' às ' + pad(h) + ':' + pad(i)))}
      </View>
      <View style={styles.fields}>
        {FIELD_ROW.map((spec, index) => (
          <View key={spec.key} style={styles.fieldGroup}>
            {index === 3 ? <Text style={styles.sep} importantForAccessibility='no'>às</Text> : null}
            <TextInput
              style={[styles.input, { width: spec.width }, !real && styles.inputOff]}
              value={f[spec.key]}
              editable={!disabled}
              maxLength={spec.max}
              keyboardType='number-pad'
              inputMode='numeric'
              placeholder={spec.label}
              placeholderTextColor={colors.placeholder}
              accessibilityLabel={label + ', ' + spec.label}
              onChangeText={(text) => change({ ...f, [spec.key]: text.replace(/\D/g, '') })}
            />
          </View>
        ))}
      </View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  box: { gap: 6 },
  label: { ...type.postName, color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: layout.hit, minWidth: layout.hit, paddingHorizontal: 14, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { ...type.pill, color: colors.ink },
  chipTextOn: { color: colors.accent },
  fields: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  fieldGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sep: { ...type.meta, color: colors.soft },
  input: { ...type.postText, minHeight: layout.hit, color: colors.ink, textAlign: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 6 },
  inputOff: { borderColor: colors.danger },
  pressed: { opacity: 0.6 }
})
