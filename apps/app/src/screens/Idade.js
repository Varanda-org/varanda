// 'Confirme sua idade' (hosted web only): the setup step between the
// recovery and the @nome. Presentational: the shell reads the state from the
// account service and starts the verification; nothing here comes from the
// URL, and the state is never stored on the device.

import { AGE_TEXTS } from '../age'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { Body, Btn, Card, ErrorText, Notice, Page, Row, Soft, Spinner } from '../ui'
import { Stepper } from '../ui/Stepper'

const WHO_TEXT = 'A verificação é feita por um serviço parceiro, a Didit, em geral com uma selfie e às vezes com um documento.'
const KEPT_TEXT = 'A foto e o documento não chegam à Varanda. Só a sua faixa de idade fica guardada.'
const OFFLINE_TEXT = 'Sem conexão. A verificação precisa de internet.'
const START_LABEL = 'Verificar minha idade'
const DOCUMENT_LABEL = 'Tentar com um documento'
const CHECK_LABEL = 'Conferir de novo'
// 'pendente' also covers a verification left half way at the partner: the
// service hands back the same session for an hour, so it can be resumed.
const RESUME_LABEL = 'Continuar a verificação'
const RESUME_TEXT = 'Se você saiu antes de terminar, continue de onde parou.'

// The states that offer a (new) verification.
const STARTABLE = new Set(['nenhum', 'inconclusivo', 'expirado', 'recusado'])

export default function Idade ({ state, busy = false, error = '', note = '', offline = false, onStart, onCheck, index = 1, total = 3 }) {
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
        <Card>
          {stateText ? <Body>{stateText}</Body> : null}
          {showResume ? <Soft>{RESUME_TEXT}</Soft> : null}
          {busy ? <Spinner /> : null}
          <Row>
            {showStart
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
