import { Pressable, StyleSheet, Text, View } from 'react-native'
import { DESIGN_LABELS, REGIONS, REGION_LABELS } from '../inviteCardCopy'
import { counterText } from '../inviteCardCompose'
import { Body, Field, Soft } from './index'
import { FilterChips } from './FilterChips'
import { InviteCard } from './InviteCard'
import { InviteCardFrame } from './InviteCardFrame'
import { useStyles } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

const OPTIONS = REGIONS.map(({ id }) => ({ id, label: REGION_LABELS[id] }))

export function InviteCardButton ({ label, onPress, disabled, pending, secondary, expanded }) {
  const styles = useStyles(makeStyles)
  const off = disabled === true || pending === true
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: off, expanded }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondary, off && styles.off, pressed && styles.pressed]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{pending ? label + '…' : label}</Text>
    </Pressable>
  )
}

export function InviteCardCompose ({ draft, origin, onChange, disabled = false }) {
  const styles = useStyles(makeStyles)
  const select = (type, value) => { if (!disabled) onChange({ type, value }) }
  const region = REGIONS.find(({ id }) => id === draft.region)
  const fields = { ...draft, origin }
  return (
    <View style={styles.wrap}>
      <Field label='Pra quem?' value={draft.name} onChangeText={(value) => select('name', value)} editable={!disabled} />
      <Body>De onde vocês são?</Body>
      <FilterChips options={OPTIONS} selected={draft.region} onSelect={(value) => select('region', value)} />
      <View style={styles.choices}>
        {region.designs.map((design) => (
          <Pressable
            key={design}
            accessibilityRole='button'
            accessibilityLabel={DESIGN_LABELS[design]}
            accessibilityState={{ selected: draft.design === design, disabled }}
            disabled={disabled}
            onPress={() => select('design', design)}
            style={({ pressed }) => [styles.choice, draft.design === design && styles.selected, pressed && styles.pressed]}
          >
            <InviteCardFrame design={design}><Body>{DESIGN_LABELS[design]}</Body></InviteCardFrame>
          </Pressable>
        ))}
      </View>
      <InviteCard design={draft.design} name={draft.name} message={draft.message} />
      <Soft>A prévia do link mostra o desenho e o seu @nome.</Soft>
      <Field label='Sua mensagem' value={draft.message} onChangeText={(value) => select('message', value)} multiline editable={!disabled} />
      <Soft>{counterText(fields)}</Soft>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { gap: space.md },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  choice: { minHeight: layout.hit, minWidth: layout.hit, flexBasis: 140, flexGrow: 1, borderWidth: 2, borderColor: colors.line, borderRadius: radius.lg },
  selected: { borderColor: colors.accent },
  button: { minHeight: layout.hit, minWidth: layout.hit, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: colors.accent },
  secondary: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: colors.outline },
  buttonText: { ...type.pill, color: colors.accentInk },
  secondaryText: { color: colors.ink },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.6 }
})
