// 'Confirme seu celular' (hosted): the setup step after the age check, and
// the same form for changing the number later (mode 'trocar'). The number and
// the code go only to the account service, beside the node's signature
// (src/usePhoneVerify.js); the screen shows what the person typed and never a
// number from the service. Nothing comes from the URL, and the code field
// asks for no SMS autofill. The explanations live in HELP.telefone, behind
// the (i) of the step bar. The code is one input under six drawn cells; a
// completed code is checked once from the edit (src/phoneEntry.js).

import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useNode } from '../node'
import { codeDigits, isCode } from '../phone'
import { cellsOf, shouldAutoSubmit } from '../phoneEntry'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { usePhoneVerify } from '../usePhoneVerify'
import { Btn, ErrorText, Label, Notice, Page, Soft } from '../ui'
import { Stepper, StepLink, StepNotice } from '../ui/Stepper'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { radius, type, webInputReset } from '../ui/theme'
import { KeyboardForm } from './Perfil'

const OFFLINE_TEXT = 'Sem conexão. A confirmação precisa de internet.'
const CHECKING_TEXT = 'Conferindo seu celular…'
const NUMBER_LABEL = 'Seu celular com DDD'
const CODE_LABEL = 'Código de 6 números'
const SEND_LABEL = 'Enviar código'
const CONFIRM_LABEL = 'Confirmar'
const RESEND_LABEL = 'Reenviar código'
const CHANGE_LABEL = 'Trocar número'
const RECHECK_LABEL = 'Conferir de novo'
const TROCAR_TITLE = 'Trocar o celular'

const makeStyles = (colors) => StyleSheet.create({
  center: { textAlign: 'center' },
  field: { gap: 4 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink
  },
  off: { backgroundColor: colors.inputOff, color: colors.soft },
  codeBox: { position: 'relative' },
  cells: { flexDirection: 'row', gap: 8 },
  cell: {
    flex: 1,
    minHeight: 52,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md
  },
  cellOn: { borderColor: colors.accent, borderWidth: 2 },
  cellText: { ...type.threadTitle, color: colors.ink },
  // The digits are drawn by the cells; the input stays on top, invisible, so
  // typing, pasting and the keyboard all go to one field.
  codeInput: { ...StyleSheet.absoluteFillObject, color: 'transparent', backgroundColor: 'transparent', fontSize: 16, ...webInputReset },
  plain: { gap: 12 }
})

const NO_AUTOFILL = { autoComplete: 'off', autoCorrect: false, autoCapitalize: 'none', spellCheck: false, importantForAutofill: 'no', textContentType: 'none' }

function Input ({ label, value, onChangeText, keyboardType, maxLength, editable, onSubmitEditing }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        style={[styles.input, !editable && styles.off]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        maxLength={maxLength}
        editable={editable}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={label}
        onSubmitEditing={onSubmitEditing}
        returnKeyType='done'
        {...NO_AUTOFILL}
      />
    </View>
  )
}

// The cells are hidden from accessibility: a screen reader reaches the input,
// which carries the label and the digits typed. The caret stays at the end,
// so a tap on a middle cell never edits a digit the person cannot see.
function CodeInput ({ label, value, onChangeText, editable, onSubmitEditing }) {
  const styles = useStyles(makeStyles)
  const [focused, setFocused] = useState(false)
  // Moving the caret causes no render, and the web applies `selection` only
  // on a render: a caret left away from the end forces one.
  const [, setCaretPin] = useState(0)
  const pinCaret = (e) => {
    const sel = e && e.nativeEvent ? e.nativeEvent.selection : null
    if (sel && (sel.start !== value.length || sel.end !== value.length)) setCaretPin((n) => n + 1)
  }
  const cells = cellsOf(value)
  const at = Math.min(value.length, cells.length - 1)
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <View style={styles.codeBox}>
        <View style={styles.cells} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
          {cells.map((digit, i) => (
            <View key={i} style={[styles.cell, editable && focused && i === at && styles.cellOn, !editable && styles.off]}>
              <Text style={styles.cellText}>{digit}</Text>
            </View>
          ))}
        </View>
        <TextInput
          style={styles.codeInput}
          value={value}
          onChangeText={onChangeText}
          keyboardType='number-pad'
          maxLength={12}
          editable={editable}
          caretHidden
          selectionColor='transparent'
          selection={{ start: value.length, end: value.length }}
          onSelectionChange={pinCaret}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label}
          onSubmitEditing={onSubmitEditing}
          returnKeyType='done'
          {...NO_AUTOFILL}
        />
      </View>
    </View>
  )
}

// checking: the shell's status read for this member has not answered yet.
// checkError: that read failed (text), with onRecheck to ask again.
// gateKey: the phone gate's key; onVerified(proof, key) gets the key the
// request started under, so the shell applies it to that session only.
// onVerified: the service answered 'verificado' to a send or a check.
// onUncertain: a check whose outcome is unknown; onDropped: an answer
// dropped by this screen. The shell asks the status for both.
// statusBusy / statusVerified: the shell's status read is in flight / last
// answered 'verificado'. After an uncertain check the screen holds Confirmar
// until that read answers, and a 'verificado' then takes the onVerified path
// (proofless, under the key the check started with).
export default function Telefone ({ mode = 'setup', member, gateKey, onVerified, onUncertain, onDropped, offline = false, checking = false, checkError = '', onRecheck, statusBusy = false, statusVerified = false, index = 1, total = 3 }) {
  const node = useNode()
  const verify = usePhoneVerify({ node, member, gateKey, onDropped })
  const styles = useStyles(makeStyles)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  // The gate key an uncertain check started under, until the recheck answers.
  const [awaiting, setAwaiting] = useState(null)
  const sawBusy = useRef(false)
  // The code checked last, by an edit or by Confirmar: an edit never sends it
  // again by itself.
  const lastChecked = useRef(null)
  // A send or check this screen started and that has not answered: an edit
  // can land before the render that shows verify.busy.
  const inFlight = useRef(null)
  const holding = awaiting !== null && awaiting === gateKey && !checkError
  const waiting = (checking && !checkError) || holding
  const locked = verify.busy || waiting || offline
  const codeLocked = locked || awaiting !== null
  // The Confirmar rule; Enter in the code field follows it too, because the
  // browser fires onSubmitEditing even on a read-only field.
  const canConfirm = !codeLocked && code.trim().length === 6

  // The recheck starts in the same render that sets awaiting (onUncertain is
  // called in the same batch), so a read not busy then never started.
  useEffect(() => {
    if (awaiting === null) return
    if (awaiting !== gateKey || checkError) {
      sawBusy.current = false
      setAwaiting(null)
      return
    }
    if (statusBusy) {
      sawBusy.current = true
      return
    }
    const answered = sawBusy.current
    sawBusy.current = false
    setAwaiting(null)
    if (answered && statusVerified && onVerified) onVerified(undefined, awaiting)
  }, [awaiting, gateKey, checkError, statusBusy, statusVerified])
  // A new gate drops every answer started before (usePhoneVerify), so no
  // request or code from the old one holds the new one.
  useEffect(() => {
    inFlight.current = null
    lastChecked.current = null
  }, [gateKey])

  const finish = (r) => {
    if (r === null) return
    if (r.state === 'verificado') {
      if (onVerified) onVerified(r.proof, r.key)
    } else if (r.uncertain === true && onUncertain) {
      onUncertain()
    }
  }
  const send = async () => {
    const mine = {}
    if (inFlight.current === null) inFlight.current = mine
    try {
      const r = await verify.send(phone)
      if (r !== null && (r.state === 'enviado' || r.state === 'verificado')) setCode('')
      finish(r)
    } finally {
      if (inFlight.current === mine) inFlight.current = null
    }
  }
  // The candidate is passed in: an edit checks before `code` holds it. Only a
  // code that is handed to verify.check counts as checked.
  const checkCode = async (candidate) => {
    if (!isCode(candidate) || inFlight.current !== null) return
    const mine = {}
    inFlight.current = mine
    lastChecked.current = candidate
    try {
      const r = await verify.check(candidate)
      if (r !== null && r.uncertain === true) setAwaiting(r.key)
      finish(r)
    } finally {
      if (inFlight.current === mine) inFlight.current = null
    }
  }
  const confirm = () => {
    if (!canConfirm) return
    checkCode(code.trim())
  }
  const editCode = (text) => {
    const next = codeDigits(text)
    setCode(next)
    if (shouldAutoSubmit({ code: next, last: lastChecked.current, locked: codeLocked || inFlight.current !== null })) checkCode(next)
  }
  // A new number gets new codes; a resend keeps lastChecked.
  const change = () => {
    lastChecked.current = null
    inFlight.current = null
    setAwaiting(null)
    setCode('')
    verify.reset()
  }

  const resendLabel = verify.resendIn > 0 ? RESEND_LABEL + ' em ' + verify.resendIn + ' s' : RESEND_LABEL
  const actions = verify.sent
    ? (
      <>
        <Btn label={CONFIRM_LABEL} onPress={confirm} disabled={!canConfirm} pending={verify.busy} block large />
        <StepLink label={resendLabel} onPress={send} disabled={locked || verify.resendIn > 0} />
        <StepLink label={CHANGE_LABEL} onPress={change} disabled={(checking && !checkError) || verify.busy} />
      </>
      )
    : <Btn label={SEND_LABEL} onPress={send} disabled={locked || phone.trim() === ''} pending={verify.busy} block large />

  const body = (
    <>
      {waiting ? <Soft style={styles.center}>{CHECKING_TEXT}</Soft> : null}
      {checkError
        ? (
          <StepNotice>
            <ErrorText>{checkError}</ErrorText>
            {onRecheck ? <Btn label={RECHECK_LABEL} secondary onPress={onRecheck} disabled={offline} block /> : null}
          </StepNotice>
          )
        : null}
      <Input label={NUMBER_LABEL} value={phone} onChangeText={setPhone} keyboardType='phone-pad' maxLength={20} editable={!verify.sent && !locked} onSubmitEditing={verify.sent ? undefined : send} />
      {verify.note ? <StepNotice><Notice>{verify.note}</Notice></StepNotice> : null}
      {verify.sent
        ? <CodeInput label={CODE_LABEL} value={code} onChangeText={editCode} editable={!locked} onSubmitEditing={confirm} />
        : null}
      <ErrorText>{verify.error}</ErrorText>
      {offline ? <StepNotice><Soft>{OFFLINE_TEXT}</Soft></StepNotice> : null}
    </>
  )

  if (mode === 'trocar') {
    return (
      <View style={styles.plain}>
        <Label>{TROCAR_TITLE}</Label>
        <Soft>{STEP_HINTS.telefone}</Soft>
        {body}
        {actions}
      </View>
    )
  }
  return (
    <KeyboardForm>
      <Page flush grow padBottom={16}>
        <Stepper index={index} total={total} title={STEP_TITLES.telefone} hint={STEP_HINTS.telefone} icon='mensagem' busy={verify.busy || waiting} actions={actions}>
          {body}
        </Stepper>
      </Page>
    </KeyboardForm>
  )
}
