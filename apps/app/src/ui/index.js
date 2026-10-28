// Small UI kit (react-native primitives only) and the action hook shared by
// the screens. Every string that comes from a peer or from the node is
// rendered by the screens through displayText (docs/rpc.md section 10).
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { colors, fonts, layout, type } from './theme'

export { colors }

export const UNCERTAIN = 'incerto: pode ter sido aplicado; confira antes de repetir'

// Plain words for the technical messages the node and the app raise. Display
// only: the logic keeps matching the original messages and codes.
const PLAIN = {
  'sincronize com o semeador antes de publicar': 'Sem conexão com o servidor agora. Tente de novo em instantes.',
  'identidade bloqueada: entre com a passkey': 'Entre com sua passkey para continuar.',
  'grave o certificado de membro antes de publicar': 'Sua conta ainda está sendo preparada. Tente de novo em instantes.',
  'a conexão com o nó foi encerrada': 'A conexão foi interrompida. Tente de novo.',
  'sem conexão com o nó': 'A conexão foi interrompida. Tente de novo.',
  'semeador indisponível': 'Sem conexão agora. Tente de novo em instantes.',
  'sem conexão com o semeador': 'Sem conexão agora. Tente de novo em instantes.',
  'Semeador ocupado; tente novamente em instantes.': 'Muitas pessoas conectadas agora. Tente de novo em instantes.',
  'conexão com o semeador encerrada': 'A conexão foi interrompida. Tente de novo.',
  'não é possível seguir a própria chave': 'Você não pode seguir a si mesmo.',
  'mídia inválida': 'Não foi possível usar esta foto.',
  'mídia disponível só na versão web': 'Fotos só podem ser publicadas na versão web.',
  'esta conta Google já está vinculada a outra chave': 'Esta conta Google já está em uso por outra conta Varanda.',
  'não foi possível provar a chave': 'Não foi possível confirmar sua conta. Tente de novo.',
  'o nó do navegador não carregou': 'Não foi possível carregar o app. Recarregue a página.',
  'não foi possível carregar o nó do navegador': 'Não foi possível carregar o app. Recarregue a página.',
  'nó local indisponível na web': 'Não foi possível carregar o app. Recarregue a página.'
}

// The plain words for a message, or the message itself.
export function plainMessage (text) {
  return typeof text === 'string' && Object.hasOwn(PLAIN, text) ? PLAIN[text] : text
}

// The text of an error for the person: never the raw message.
export function errorText (err) {
  if (err && err.uncertain === true) return UNCERTAIN
  const message = err && typeof err.message === 'string' && err.message !== '' ? err.message : 'erro'
  return displayText(plainMessage(message))
}

// One request at a time per action: `pending` disables the button and a
// second call while pending is ignored (no double submit). run(fn) ->
// { ok: true, value } or { ok: false, uncertain }; the error text is in
// `error`. A mutation is never resent: a failure only shows the message.
export function useAction () {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const run = useCallback(async (fn) => {
    if (busy.current) return { ok: false, uncertain: false }
    busy.current = true
    setPending(true)
    setError('')
    try {
      return { ok: true, value: await fn() }
    } catch (err) {
      setError(errorText(err))
      return { ok: false, uncertain: !!(err && err.uncertain === true) }
    } finally {
      busy.current = false
      setPending(false)
    }
  }, [])
  return { run, pending, error, clearError: () => setError('') }
}

// Date.now(), refreshed every intervalMs (relative times stay current).
export function useNow (intervalMs) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

// Bottom space a scrolling screen needs to clear the tab bar and the FAB.
export function useBottomPad () {
  const insets = useSafeAreaInsets()
  return layout.tabBar + insets.bottom + 96
}

export function Page ({ children, flush, padBottom = 0, refreshControl }) {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[flush ? styles.pageFlush : styles.pageContent, { paddingBottom: (flush ? 0 : 16) + padBottom }]}
      keyboardShouldPersistTaps='handled'
      refreshControl={refreshControl}
    >
      {flush ? children : <View style={styles.column}>{children}</View>}
    </ScrollView>
  )
}

export function SectionHeader ({ children, right }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionText} accessibilityRole='header'>{children}</Text>
      {right || null}
    </View>
  )
}

export function Title ({ children }) {
  return <Text style={styles.title} accessibilityRole='header'>{children}</Text>
}

export function Label ({ children }) {
  return <Text style={styles.label}>{children}</Text>
}

export function Body ({ children, style }) {
  return <Text style={[styles.body, style]}>{children}</Text>
}

export function Soft ({ children }) {
  return <Text style={styles.soft}>{children}</Text>
}

// Selectable text for keys and other values the person may want to copy.
export function Mono ({ children }) {
  return <Text style={styles.mono} selectable>{children}</Text>
}

export function ErrorText ({ children }) {
  if (!children) return null
  return <Text style={styles.error} accessibilityRole='alert'>{children}</Text>
}

export function Notice ({ children }) {
  if (!children) return null
  return <Text style={styles.notice}>{children}</Text>
}

export function Spinner ({ size = 'small' }) {
  return <ActivityIndicator size={size} color={colors.accent} />
}

export function Card ({ children }) {
  return <View style={styles.card}>{children}</View>
}

export function Row ({ children }) {
  return <View style={styles.row}>{children}</View>
}

export function Btn ({ label, onPress, disabled, pending, secondary, danger }) {
  const off = disabled === true || pending === true
  const outline = secondary || danger
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        outline && styles.btnOutline,
        danger && styles.btnDanger,
        off && styles.btnOff,
        pressed && styles.btnPressed
      ]}
    >
      <Text style={[styles.btnText, outline && styles.btnTextOutline, danger && styles.btnTextDanger]}>
        {pending ? label + '…' : label}
      </Text>
    </Pressable>
  )
}

// Key, JSON and host fields are `mono`: no capitalisation or correction.
// Free text (name, bio) keeps the platform defaults.
export function Field ({ label, value, onChangeText, multiline, maxLength, editable = true, placeholder, mono, lines = 4, onSubmitEditing, returnKeyType }) {
  const raw = mono ? { autoCapitalize: 'none', autoCorrect: false, spellCheck: false } : {}
  // Forwarded only when passed: existing callers are unchanged.
  const submit = {}
  if (onSubmitEditing !== undefined) submit.onSubmitEditing = onSubmitEditing
  if (returnKeyType !== undefined) submit.returnKeyType = returnKeyType
  return (
    <View style={styles.field}>
      {label ? <Label>{label}</Label> : null}
      <TextInput
        style={[styles.input, multiline && { minHeight: lines * 22 + 20, textAlignVertical: 'top' }, mono && styles.inputMono, !editable && styles.inputOff]}
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        maxLength={maxLength}
        editable={editable}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={label || placeholder}
        {...raw}
        {...submit}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  pageContent: { padding: 16 },
  pageFlush: {},
  column: { width: '100%', maxWidth: layout.column, alignSelf: 'center', gap: 12 },
  section: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 6,
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  sectionText: { ...type.section, color: colors.soft },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink, fontFamily: fonts.title },
  label: { fontSize: 14, fontWeight: '600', color: colors.soft },
  body: { fontSize: 16, lineHeight: 22, color: colors.ink },
  soft: { fontSize: 14, lineHeight: 20, color: colors.soft },
  mono: { fontSize: 13, lineHeight: 19, color: colors.ink, fontFamily: fonts.mono },
  error: { fontSize: 14, lineHeight: 20, color: colors.danger },
  notice: { fontSize: 14, lineHeight: 20, color: colors.warn },
  card: { backgroundColor: colors.card, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: 12, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 17,
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center'
  },
  btnOutline: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: colors.outline, paddingVertical: 8, paddingHorizontal: 15 },
  btnDanger: { borderColor: colors.danger },
  btnOff: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnText: { ...type.pill, color: colors.accentInk },
  btnTextOutline: { color: colors.ink },
  btnTextDanger: { color: colors.danger },
  field: { gap: 4 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink
  },
  inputMono: { fontFamily: fonts.mono, fontSize: 14 },
  inputOff: { backgroundColor: '#efece5', color: colors.soft }
})
