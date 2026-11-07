// Small UI kit (react-native primitives only) and the action hook shared by
// the screens. Every string that comes from a peer or from the node is
// rendered by the screens through displayText (docs/rpc.md section 10).
// Design: apps/site/artwork/app-design.md.

import { cloneElement, isValidElement, useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { Icon } from './Icon'
import { fonts, layout, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export { TABS, tabsFor } from '../tabs'

export const UNCERTAIN = 'incerto: pode ter sido aplicado; confira antes de repetir'

// Plain words for the technical messages the node and the app raise. Display
// only: the logic keeps matching the original messages and codes.
const PLAIN = {
  'aguardando nova chave': 'Aguarde a atualização de acesso deste grupo.',
  'grupo não encontrado': 'Não encontramos esse grupo.',
  'comunidade não encontrada': 'Não encontramos essa comunidade.',
  'só quem criou a comunidade cria grupos': 'Só quem criou a comunidade cria grupos.',
  'crie pelo aparelho que criou a comunidade': 'Crie o grupo pelo aparelho em que você criou a comunidade.',
  'entre na comunidade primeiro': 'Entre na comunidade primeiro.',
  'grupo sem comunidade': 'Este grupo não pertence a nenhuma comunidade.',
  'aguarde a sincronização da comunidade': 'Aguarde a comunidade terminar de sincronizar e tente de novo.',
  'a comunidade chegou ao limite de grupos': 'A comunidade chegou ao limite de grupos.',
  'sem permissão na comunidade': 'Você não tem permissão nesta comunidade.',
  'a pessoa precisa ser membro da comunidade': 'Essa pessoa ainda não é membro da comunidade.',
  'o grupo não é dessa comunidade': 'Este grupo não é dessa comunidade.',
  'informe a comunidade do grupo': 'Abra a comunidade do grupo para entrar nele.',
  'limite da comunidade atingido': 'A comunidade chegou ao limite de pessoas.',
  'grupo privado exige aprovação': 'Este grupo privado precisa de aprovação para entrar.',
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
  'áudio inválido': 'Não foi possível enviar este áudio.',
  'mídia disponível só na versão web': 'Fotos só podem ser publicadas na versão web.',
  'esta conta Google já está vinculada a outra chave': 'Esta conta Google já está em uso por outra conta Varanda.',
  'não foi possível provar a chave': 'Não foi possível confirmar sua conta. Tente de novo.',
  'o nó do navegador não carregou': 'Não foi possível carregar o app. Recarregue a página.',
  'não foi possível carregar o nó do navegador': 'Não foi possível carregar o app. Recarregue a página.',
  'nó local indisponível na web': 'Não foi possível carregar o app. Recarregue a página.',
  'referência inválida': 'Não encontramos essa publicação.',
  'não é possível apagar este registro': 'Este registro não pode ser apagado.',
  'o registro não é uma publicação': 'Este registro não é uma publicação.',
  'o registro não é um perfil': 'Este registro não é um perfil.'
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
  const styles = useStyles(makeStyles)
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

// `flush` drops the 16 pt sides, for a header inside an already padded Page
// (it lined up 16 pt to the right of everything else there).
export function SectionHeader ({ children, right, flush }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={[styles.section, flush && styles.sectionFlush]}>
      <Text style={styles.sectionText} accessibilityRole='header'>{children}</Text>
      {right || null}
    </View>
  )
}

export function FlushSectionHeader (props) {
  return <SectionHeader {...props} flush />
}

export function Title ({ children }) {
  const styles = useStyles(makeStyles)
  return <Text style={styles.title} accessibilityRole='header'>{children}</Text>
}

export function Label ({ children }) {
  const styles = useStyles(makeStyles)
  return <Text style={styles.label}>{children}</Text>
}

export function Body ({ children, style }) {
  const styles = useStyles(makeStyles)
  return <Text style={[styles.body, style]}>{children}</Text>
}

export function Soft ({ children, style }) {
  const styles = useStyles(makeStyles)
  return <Text style={[styles.soft, style]}>{children}</Text>
}

// Selectable text for keys and other values the person may want to copy.
export function Mono ({ children }) {
  const styles = useStyles(makeStyles)
  return <Text style={styles.mono} selectable>{children}</Text>
}

export function ErrorText ({ children }) {
  const styles = useStyles(makeStyles)
  if (!children) return null
  return <Text style={styles.error} accessibilityRole='alert'>{children}</Text>
}

export function Notice ({ children }) {
  const styles = useStyles(makeStyles)
  if (!children) return null
  return <Text style={styles.notice}>{children}</Text>
}

export function Spinner ({ size = 'small' }) {
  const { colors } = useTheme()
  return <ActivityIndicator size={size} color={colors.accent} />
}

export function Card ({ children }) {
  const styles = useStyles(makeStyles)
  return <View style={styles.card}>{children}</View>
}

export function Row ({ children }) {
  const styles = useStyles(makeStyles)
  return <View style={styles.row}>{children}</View>
}

export function Btn ({ label, icon, onPress, disabled, pending, secondary, danger, accessibilityLabel, block }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const off = disabled === true || pending === true
  const outline = secondary || danger
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: off }}
      accessibilityLabel={accessibilityLabel}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        typeof icon === 'string' && styles.btnRow,
        block && styles.btnBlock,
        outline && styles.btnOutline,
        danger && styles.btnDanger,
        off && styles.btnOff,
        pressed && styles.btnPressed
      ]}
    >
      {typeof icon === 'string' ? <Icon name={icon} size={18} color={danger ? colors.danger : outline ? colors.ink : colors.accentInk} /> : null}
      <Text style={[styles.btnText, outline && styles.btnTextOutline, danger && styles.btnTextDanger]}>
        {pending ? label + '…' : label}
      </Text>
    </Pressable>
  )
}

// Every Apagar/Cancelar pair: the filled (or danger) action on top, the
// secondary Cancelar below, so neither is squeezed beside the other. Each
// side is a Btn element or the props of one ({ label, onPress, ... }).
export function ConfirmStack ({ confirm, cancel }) {
  const styles = useStyles(makeStyles)
  // Full width, so the pair reads as one choice and a long label never wraps.
  const wide = (el) => (el.type === Btn ? cloneElement(el, { block: true }) : el)
  const top = isValidElement(confirm) ? wide(confirm) : confirm ? <Btn block {...confirm} /> : null
  const bottom = isValidElement(cancel) ? wide(cancel) : <Btn block secondary label='Cancelar' {...(cancel || {})} />
  return (
    <View style={styles.confirmStack}>
      {top}
      {bottom}
    </View>
  )
}

// Key, JSON and host fields are `mono`: no capitalisation or correction.
// Free text (name, bio) keeps the platform defaults.
export function Field ({ label, value, onChangeText, multiline, maxLength, editable = true, placeholder, mono, lines = 4, onSubmitEditing, returnKeyType, plain }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  // plain: a search, typed as is (no capitals, no autocorrect) in the normal font.
  const raw = mono || plain ? { autoCapitalize: 'none', autoCorrect: false, spellCheck: false } : {}
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

const makeStyles = (colors) => StyleSheet.create({
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
  sectionFlush: { paddingHorizontal: 0 },
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
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  confirmStack: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  btnBlock: { alignSelf: 'stretch' },
  btnOutline: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: colors.outline, paddingVertical: 8, paddingHorizontal: 15 },
  btnDanger: { borderColor: colors.danger },
  btnOff: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  // The 1 pt sides absorb Android's rounding with the 1.5 pt outline: the label got its
  // exact width, lost a pixel and wrapped its last word out of sight ("Trocar passkey").
  btnText: { ...type.pill, color: colors.accentInk, textAlign: 'center', paddingHorizontal: 1 },
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
  inputOff: { backgroundColor: colors.inputOff, color: colors.soft }
})
