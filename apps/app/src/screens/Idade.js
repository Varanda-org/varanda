// 'Confirme sua idade' (hosted web and the app's web node): the setup step between the
// recovery and the @nome. Presentational: the shell reads the state from the
// account service and starts the verification; nothing here comes from the
// URL. The age band is never stored: the device remembers only a refusal, per
// account and installation (src/ageMemory.js); a pass is proved by the
// issuer-signed attestations the node checks. The explanations (who verifies,
// what is kept, the browser round trip) live in HELP.idade, behind the (i).

import { useState } from 'react'
import { StyleSheet } from 'react-native'
import { AGE_TEXTS } from '../age'
import { ENTRY_TEXT, ENTRY_TITLE } from '../feiraEntry'
import { INVITE_NEEDED_TEXT } from '../signupInvite'
import { captureSignupInvite } from '../signupInviteStore'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { Body, Btn, ErrorText, Field, Label, Notice, Page, Soft } from '../ui'
import { Stepper, StepNotice } from '../ui/Stepper'
import { useStyles } from '../ui/ThemeProvider'
import { KeyboardForm } from './Perfil'

const OFFLINE_TEXT = 'Sem conexão. A verificação precisa de internet.'
const START_LABEL = 'Verificar minha idade'
const DOCUMENT_LABEL = 'Tentar com um documento'
const CHECK_LABEL = 'Conferir de novo'
// 'pendente' also covers a verification left half way at the partner: the
// service hands back the same session for an hour, so it can be resumed.
const RESUME_LABEL = 'Continuar a verificação'
const RESUME_TEXT = 'Se você saiu antes de terminar, continue de onde parou.'
export const AGE_APP_NOTE = 'Abrimos a verificação no navegador. Quando terminar, volte para a Varanda.'
// The first answer is still on its way: say so, so the disabled button does
// not look broken.
export const AGE_CHECKING_TEXT = 'Conferindo sua idade…'

// The app has no App Links: an invite opened in the browser never reaches it,
// so the steps that need one take the link (or the bare code) pasted by hand.
const PASTE_LABEL = 'Cole o link de convite'
const PASTE_BUTTON = 'Usar este convite'
const PASTE_INVALID = 'Esse link de convite não serve. Confira se copiou o link inteiro.'

// The paste field shared by this step and Identidade's link step. The code is
// held in memory for the session (signupInviteStore.native.js) and goes only
// to the account service; onPasted runs once it is held.
export function InvitePaste ({ onPasted, disabled = false, setup = false }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const use = () => {
    if (captureSignupInvite(text, { paste: true }) === null) return setError(PASTE_INVALID)
    setError('')
    setText('')
    if (onPasted) onPasted()
  }
  return (
    <>
      <Field label={PASTE_LABEL} placeholder='link ou código do convite' value={text} onChangeText={setText} mono />
      <Btn label={PASTE_BUTTON} onPress={use} disabled={disabled || text.trim() === ''} block={setup} large={setup} />
      <ErrorText>{error}</ErrorText>
    </>
  )
}

const makeStyles = () => StyleSheet.create({
  center: { textAlign: 'center' }
})

// The states that offer a (new) verification.
const STARTABLE = new Set(['nenhum', 'inconclusivo', 'expirado', 'recusado'])

// invitePaste: show the paste field (src/linkReturn.js invitePasteShown).
// feiraEntry: a visitor from a Feira listing link (src/useFeiraEntryStart.js),
// { offer, busy, tried, onPress, note } or null. While the offer stands the
// age start waits: the service refuses it without a code, and the press is
// what asks for one.
export default function Idade ({ state, busy = false, error = '', note = '', offline = false, onStart, onCheck, index = 1, total = 3, invitePaste = false, onInvitePasted, feiraEntry = null }) {
  const feiraOffer = !!feiraEntry && feiraEntry.offer === true
  const onFeiraPress = feiraOffer ? feiraEntry.onPress : undefined
  const known = typeof state === 'string' && Object.hasOwn(AGE_TEXTS, state)
  const stateText = known && state !== 'nenhum' ? AGE_TEXTS[state] : ''
  const showStart = state === undefined || STARTABLE.has(state)
  const showResume = state === 'pendente'
  // No answer and nothing in flight (an error, an invite just pasted, the
  // browser left without a return): offer to ask again.
  const showCheck = state === 'pendente' || (state === undefined && (!!error || !busy))
  const checking = state === undefined && busy && !error
  const styles = useStyles(makeStyles)
  const anyButton = (showStart && !invitePaste && !feiraOffer) || showResume || showCheck
  const buttons = anyButton
    ? (
      <>
        {showStart && !invitePaste && !feiraOffer
          ? <Btn label={state === 'inconclusivo' ? DOCUMENT_LABEL : START_LABEL} onPress={onStart} disabled={busy || offline} block large />
          : null}
        {showResume ? <Btn label={RESUME_LABEL} onPress={onStart} disabled={busy || offline} block large /> : null}
        {showCheck ? <Btn label={CHECK_LABEL} secondary onPress={onCheck} disabled={busy} block large /> : null}
      </>
      )
    : null
  return (
    <KeyboardForm>
      <Page flush grow padBottom={16}>
        <Stepper index={index} total={total} title={STEP_TITLES.idade} hint={STEP_HINTS.idade} icon='shield' busy={busy} actions={invitePaste ? null : buttons}>
          {checking ? <Soft style={styles.center}>{AGE_CHECKING_TEXT}</Soft> : null}
          {stateText
            ? (
              <StepNotice>
                <Body>{stateText}</Body>
                {showResume ? <Soft>{RESUME_TEXT}</Soft> : null}
              </StepNotice>
              )
            : null}
          {feiraOffer
            ? (
              <StepNotice>
                <Label>{ENTRY_TITLE}</Label>
                <Soft>{ENTRY_TEXT}</Soft>
                <Btn label={feiraEntry.tried && !feiraEntry.busy ? 'Tentar de novo' : 'Pedir entrada'} onPress={onFeiraPress} pending={!!feiraEntry.busy} block large />
              </StepNotice>
              )
            : null}
          {/* Also after the offer ends: a refusal or the seller's limit. */}
          {feiraEntry && feiraEntry.note ? <StepNotice><Notice>{feiraEntry.note}</Notice></StepNotice> : null}
          {/* No code held: the service would refuse the start, so the field comes first. */}
          {invitePaste
            ? (
              <>
                <StepNotice>
                  {error || feiraOffer ? null : <Body>{INVITE_NEEDED_TEXT}</Body>}
                  <InvitePaste onPasted={onInvitePasted} disabled={busy} setup />
                </StepNotice>
                {buttons}
              </>
              )
            : null}
          <ErrorText>{error}</ErrorText>
          {note ? <StepNotice><Notice>{note}</Notice></StepNotice> : null}
          {offline ? <StepNotice><Soft>{OFFLINE_TEXT}</Soft></StepNotice> : null}
        </Stepper>
      </Page>
    </KeyboardForm>
  )
}
