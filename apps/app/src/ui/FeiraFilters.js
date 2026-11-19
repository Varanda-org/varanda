import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { parsePriceText } from '../feira'
import { PARTIAL_NOTE } from '../feiraBrowse'
import { KIND_OPTIONS } from '../feiraScreen'
import { Btn, ErrorText } from './index'
import { FilterChips } from './FilterChips'
import { Pill } from './Pill'
import { Sheet, TEXT_CAP } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, space, type, webInputReset } from './theme'

const SORT_OPTIONS = [
  { id: 'recentes', label: 'Recentes' },
  { id: 'menor', label: 'Menor preço' },
  { id: 'maior', label: 'Maior preço' }
]
const EMPTY = { sort: 'recentes', min: '', max: '', kind: 'todos' }

// Keep the typed bounds alongside cents so reopening does not reformat the draft.
export function FeiraFilters ({ open, onClose, value = EMPTY, onApply }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { sort = 'recentes', min = '', max = '', kind = 'todos' } = value
  const [draft, setDraft] = useState({ sort, min, max, kind })
  const [error, setError] = useState('')
  const [focused, setFocused] = useState(null)
  useEffect(() => { if (!open) setFocused(null) }, [open])
  useEffect(() => {
    if (!open) return
    setDraft({ sort, min, max, kind })
    setError('')
  }, [open, sort, min, max, kind])
  const change = (field, next) => {
    setDraft((current) => ({ ...current, [field]: next }))
    setError('')
  }
  const apply = () => {
    const minCents = parsePriceText(draft.min)
    const maxCents = parsePriceText(draft.max)
    if ((draft.min.trim() && minCents === null) || (draft.max.trim() && maxCents === null)) {
      setError('Confira os preços. Use, por exemplo, 10,50.')
      return
    }
    if (minCents !== null && maxCents !== null && minCents > maxCents) {
      setError('O preço de início deve ser menor ou igual ao preço final.')
      return
    }
    onApply({ ...draft, minCents, maxCents })
    onClose()
  }
  const clear = () => { setDraft({ ...EMPTY }); setError('') }
  return (
    <Sheet open={open} onClose={onClose} title='Filtros da Feira' right={<Pill label='Limpar' onPress={clear} maxFontSizeMultiplier={TEXT_CAP} />}>
      <View style={styles.fill}>
        <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.body}>
          <Text style={styles.label}>Ordenar por</Text>
          <FilterChips options={SORT_OPTIONS} selected={draft.sort} onSelect={(next) => change('sort', next)} />
          <Text style={styles.label}>Faixa de preço</Text>
          <View style={styles.range}>
            {[['min', 'De'], ['max', 'Até']].map(([field, label]) => (
              <View key={field} style={[styles.field, focused === field && styles.fieldFocused]}>
                <Text style={styles.prefix}>R$</Text>
                <TextInput
                  accessibilityLabel={label}
                  placeholder={label}
                  placeholderTextColor={colors.soft}
                  value={draft[field]}
                  onChangeText={(next) => change(field, next)}
                  onFocus={() => setFocused(field)}
                  onBlur={() => setFocused((current) => current === field ? null : current)}
                  underlineColorAndroid='transparent'
                  style={[styles.input, focused === field && webInputReset]}
                />
              </View>
            ))}
          </View>
          <Text style={styles.label}>Tipo de anúncio</Text>
          <FilterChips options={KIND_OPTIONS} selected={draft.kind} onSelect={(next) => change('kind', next)} />
          <Text style={styles.note}>{PARTIAL_NOTE}</Text>
          <ErrorText>{error}</ErrorText>
          <Btn label='Aplicar' onPress={apply} block />
        </ScrollView>
      </View>
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  fill: { flex: 1 },
  range: { flexDirection: 'row', gap: space.md },
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.controlOff, paddingHorizontal: space.md },
  fieldFocused: { borderBottomWidth: 2, borderBottomColor: colors.accent },
  prefix: { ...type.postText, color: colors.soft },
  label: { ...type.postName, color: colors.ink },
  input: { ...type.postText, flex: 1, color: colors.ink, minHeight: layout.hit },
  note: { ...type.caption, color: colors.soft }
})
