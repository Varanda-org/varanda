// 'Confirme seu celular' (hosted): the setup step after the age check, and
// the same form for changing the number later (mode 'trocar'). The number and
// the code go only to the account service, beside the node's signature
// (src/usePhoneVerify.js); the screen shows what the person typed and never a
// number from the service. Nothing comes from the URL, and the code field
// asks for no SMS autofill. The explanations live in HELP.telefone, behind
// the (i) of the step bar.

import { useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { useNode } from '../node'
import { codeDigits } from '../phone'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { usePhoneVerify } from '../usePhoneVerify'
import { Btn, ErrorText, Label, Notice, Page, Soft } from '../ui'
import { Stepper, StepLink, StepNotice } from '../ui/Stepper'
import { useStyles, useTheme } from '../ui/ThemeProvider'
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
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink
  },
  code: { letterSpacing: 6, textAlign: 'center', fontSize: 20 },
  off: { backgroundColor: colors.inputOff, color: colors.soft },
  plain: { gap: 12 }
})

const NO_AUTOFILL = { autoComplete: 'off', autoCorrect: false, autoCapitalize: 'none', spellCheck: false, importantForAutofill: 'no', textContentType: 'none' }

function Input ({ label, value, onChangeText, keyboardType, maxLength, editable, code, onSubmitEditing }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        style={[styles.input, code && styles.code, !editable && styles.off]}
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
  const holding = awaiting !== null && awaiting === gateKey && !checkError
  const waiting = (checking && !checkError) || holding
  const locked = verify.busy || waiting || offline

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

  const finish = (r) => {
    if (r === null) return
    if (r.state === 'verificado') {
      if (onVerified) onVerified(r.proof, r.key)
    } else if (r.uncertain === true && onUncertain) {
      onUncertain()
    }
  }
  const send = async () => {
    const r = await verify.send(phone)
    if (r !== null && (r.state === 'enviado' || r.state === 'verificado')) setCode('')
    finish(r)
  }
  const confirm = async () => {
    const r = await verify.check(code)
    if (r !== null && r.uncertain === true) setAwaiting(r.key)
    finish(r)
  }
  const change = () => {
    setAwaiting(null)
    setCode('')
    verify.reset()
  }

  const resendLabel = verify.resendIn > 0 ? RESEND_LABEL + ' em ' + verify.resendIn + ' s' : RESEND_LABEL
  const actions = verify.sent
    ? (
      <>
        <Btn label={CONFIRM_LABEL} onPress={confirm} disabled={locked || code.trim().length !== 6} pending={verify.busy} block large />
        <Btn label={resendLabel} secondary onPress={send} disabled={locked || verify.resendIn > 0} block large />
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
        ? <Input label={CODE_LABEL} value={code} onChangeText={(t) => setCode(codeDigits(t))} keyboardType='number-pad' maxLength={12} editable={!locked} code onSubmitEditing={confirm} />
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
