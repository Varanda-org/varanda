// 'Confirme sua idade' (hosted web and the app's web node): the setup step between the
// recovery and the @nome. Presentational: the shell reads the state from the
// account service and starts the verification; nothing here comes from the
// URL, and the state is never stored on the device.

import { useState } from 'react'
import { Platform } from 'react-native'
import { AGE_TEXTS } from '../age'
import { INVITE_NEEDED_TEXT } from '../signupInvite'
import { captureSignupInvite } from '../signupInviteStore'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { Body, Btn, Card, ErrorText, Field, Notice, Page, Row, Soft, Spinner } from '../ui'
import { Stepper } from '../ui/Stepper'

const WHO_TEXT = 'A verificação é feita por um serviço parceiro, a Didit, em geral com uma selfie e às vezes com um documento.'
// The step hint already says that only the age band is kept.
const KEPT_TEXT = 'A foto e o documento não chegam à Varanda.'
const OFFLINE_TEXT = 'Sem conexão. A verificação precisa de internet.'
const START_LABEL = 'Verificar minha idade'
const DOCUMENT_LABEL = 'Tentar com um documento'
const CHECK_LABEL = 'Conferir de novo'
// 'pendente' also covers a verification left half way at the partner: the
// service hands back the same session for an hour, so it can be resumed.
const RESUME_LABEL = 'Continuar a verificação'
const RESUME_TEXT = 'Se você saiu antes de terminar, continue de onde parou.'
// The app opens the partner in the system browser and is not reloaded on the
// way back, so it says how to return and that the result is asked again.
const NATIVE = Platform.OS !== 'web'
const APP_BROWSER_TEXT = 'A verificação abre no navegador. Ao terminar, volte para a Varanda: o resultado é conferido de novo.'
export const AGE_APP_NOTE = 'Abrimos a verificação no navegador. Quando terminar, volte para a Varanda.'

// The app has no App Links: an invite opened in the browser never reaches it,
// so the steps that need one take the link (or the bare code) pasted by hand.
const PASTE_LABEL = 'Cole o link de convite'
const PASTE_BUTTON = 'usar este convite'
const PASTE_INVALID = 'Esse link de convite não serve. Confira se copiou o link inteiro.'

// The paste field shared by this step and Identidade's link step. The code is
// held in memory for the session (signupInviteStore.native.js) and goes only
// to the account service; onPasted runs once it is held.
export function InvitePaste ({ onPasted, disabled = false }) {
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
      <Btn label={PASTE_BUTTON} onPress={use} disabled={disabled || text.trim() === ''} />
      <ErrorText>{error}</ErrorText>
    </>
  )
}

// The states that offer a (new) verification.
const STARTABLE = new Set(['nenhum', 'inconclusivo', 'expirado', 'recusado'])

// invitePaste: show the paste field (src/linkReturn.js invitePasteShown).
export default function Idade ({ state, busy = false, error = '', note = '', offline = false, onStart, onCheck, index = 1, total = 3, invitePaste = false, onInvitePasted }) {
  const known = typeof state === 'string' && Object.hasOwn(AGE_TEXTS, state)
  const stateText = known && state !== 'nenhum' ? AGE_TEXTS[state] : ''
  const showStart = state === undefined || STARTABLE.has(state)
  const showResume = state === 'pendente'
  const showCheck = state === 'pendente' || (state === undefined && !!error)
  return (
    <Page flush padBottom={16}>
      <Stepper index={index} total={total} title={STEP_TITLES.idade} hint={STEP_HINTS.idade}>
        <Body>{WHO_TEXT}</Body>
        <Soft>{KEPT_TEXT}</Soft>
        {NATIVE ? <Soft>{APP_BROWSER_TEXT}</Soft> : null}
        <Card>
          {stateText ? <Body>{stateText}</Body> : null}
          {showResume ? <Soft>{RESUME_TEXT}</Soft> : null}
          {busy ? <Spinner /> : null}
          {/* No code held: the service would refuse the start, so the field comes first. */}
          {invitePaste
            ? (
              <>
                {error ? null : <Body>{INVITE_NEEDED_TEXT}</Body>}
                <InvitePaste onPasted={onInvitePasted} disabled={busy} />
              </>
              )
            : null}
          <Row>
            {showStart && !invitePaste
              ? <Btn label={state === 'inconclusivo' ? DOCUMENT_LABEL : START_LABEL} onPress={onStart} disabled={busy || offline} />
              : null}
            {showResume
              ? <Btn label={RESUME_LABEL} onPress={onStart} disabled={busy || offline} />
              : null}
            {showCheck
              ? <Btn label={CHECK_LABEL} secondary onPress={onCheck} disabled={busy} />
              : null}
          </Row>
          <ErrorText>{error}</ErrorText>
          <Notice>{note}</Notice>
          {offline ? <Soft>{OFFLINE_TEXT}</Soft> : null}
        </Card>
      </Stepper>
    </Page>
  )
}
