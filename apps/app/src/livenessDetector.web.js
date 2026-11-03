// The only module that loads the face liveness detector and its styles, so the
// web bundle pulls them (tensorflow and the streaming client included) only
// when livenessCapture.web.js asks for this file with a dynamic import.
// Credentials come from the caller through config.credentialProvider: no
// global Amplify setup and no global fetch override, so nothing here touches
// the rest of the app.

import { createElement as h, useEffect, useRef, useState } from 'react'
import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness'
import { Spinner } from './ui'

// The package stylesheet is not imported: Metro web would hoist it into the
// global stylesheet every page loads, and its global rules (html font, smooth
// scrolling, box-sizing on *) would restyle the whole app. scripts/copy-liveness-css.js
// copies it here (into dist for the export, into public for `npm run web`),
// same origin and precached, and it is linked only while a detector is mounted.
export const LIVENESS_STYLESHEET = '/liveness/amplify-ui.css'
const LINK_SELECTOR = 'link[data-varanda-liveness]'

// One link shared by every mounted detector. status: idle | loading | loaded | error.
const sheet = { link: null, users: 0, status: 'idle', listeners: new Set() }

function setStatus (status) {
  sheet.status = status
  for (const listener of [...sheet.listeners]) listener(status)
}

// Adds the link on the first user and removes it after the last; listener
// gets the current status now and every change after. Returns the release.
export function acquireStylesheet (listener) {
  if (sheet.users === 0) {
    const head = globalThis.document.head
    let link = head.querySelector(LINK_SELECTOR)
    // A link already in the page (left by an earlier copy of this module) is
    // adopted; a stylesheet that has loaded exposes its sheet.
    const loaded = !!(link && link.sheet)
    if (!link) {
      link = globalThis.document.createElement('link')
      link.rel = 'stylesheet'
      link.href = LIVENESS_STYLESHEET
      link.setAttribute('data-varanda-liveness', '')
    }
    sheet.link = link
    sheet.status = loaded ? 'loaded' : 'loading'
    if (!loaded) {
      link.addEventListener('load', () => { if (sheet.link === link) setStatus('loaded') })
      link.addEventListener('error', () => { if (sheet.link === link) setStatus('error') })
    }
    if (!link.parentNode) head.appendChild(link)
  }
  sheet.users++
  sheet.listeners.add(listener)
  listener(sheet.status)
  let released = false
  return () => {
    if (released) return
    released = true
    sheet.listeners.delete(listener)
    sheet.users--
    if (sheet.users > 0) return
    const link = sheet.link
    sheet.link = null
    sheet.status = 'idle'
    if (link && link.parentNode) link.parentNode.removeChild(link)
  }
}

// What a mounted detector does with the stylesheet: ready once it loads, and
// a stylesheet that cannot load fails the capture like any other error.
export function watchStylesheet (setReady, onError) {
  return acquireStylesheet((status) => {
    setReady(status === 'loaded')
    if (status === 'error') onError('FAILED')
  })
}

export const DISPLAY_TEXT = Object.freeze({
  hintMoveFaceFrontOfCameraText: 'Coloque o rosto na frente da câmera',
  hintTooManyFacesText: 'Deixe só um rosto na frente da câmera',
  hintFaceDetectedText: 'Rosto encontrado',
  hintCanNotIdentifyText: 'Coloque o rosto na frente da câmera',
  hintTooCloseText: 'Afaste um pouco',
  hintTooFarText: 'Chegue mais perto',
  hintConnectingText: 'Conectando...',
  hintVerifyingText: 'Verificando...',
  hintCheckCompleteText: 'Verificação concluída',
  hintIlluminationTooBrightText: 'Vá para um lugar com menos luz',
  hintIlluminationTooDarkText: 'Vá para um lugar com mais luz',
  hintIlluminationNormalText: 'Iluminação boa',
  hintHoldFaceForFreshnessText: 'Fique parado',
  hintCenterFaceText: 'Centralize o rosto',
  hintCenterFaceInstructionText: 'Antes de começar, deixe a câmera no alto, no meio da tela, e olhe para ela. Quando a verificação começar, um oval aparece no centro: aproxime o rosto até ele preencher o oval e fique parado por alguns segundos, até aparecer que terminou.',
  hintFaceOffCenterText: 'O rosto saiu do oval. Centralize o rosto na câmera.',
  hintMatchIndicatorText: 'Metade feita. Continue se aproximando.',
  cameraMinSpecificationsHeadingText: 'A câmera não atende ao mínimo',
  cameraMinSpecificationsMessageText: 'A câmera precisa de pelo menos 320x240 de resolução e 15 quadros por segundo.',
  cameraNotFoundHeadingText: 'Não foi possível usar a câmera.',
  cameraNotFoundMessageText: 'Confira se há uma câmera conectada e se nenhum outro aplicativo está usando. Talvez seja preciso liberar a câmera nos ajustes do navegador, fechar todas as janelas dele e tentar de novo.',
  retryCameraPermissionsText: 'Tentar de novo',
  waitingCameraPermissionText: 'Esperando você liberar a câmera.',
  a11yVideoLabelText: 'Câmera da verificação de rosto',
  goodFitCaptionText: 'Bom enquadramento',
  goodFitAltText: 'Ilustração de um rosto que preenche o oval por inteiro.',
  photosensitivityWarningBodyText: 'Esta verificação pisca cores diferentes. Tenha cuidado se você tem sensibilidade à luz.',
  photosensitivityWarningHeadingText: 'Aviso de sensibilidade à luz',
  photosensitivityWarningInfoText: 'Algumas pessoas podem ter crises epilépticas com luzes coloridas. Tenha cuidado se você ou alguém da sua família tem epilepsia.',
  photosensitivityWarningLabelText: 'Mais informações sobre sensibilidade à luz',
  startScreenBeginCheckText: 'Começar a verificação',
  tooFarCaptionText: 'Muito longe',
  tooFarAltText: 'Ilustração de um rosto dentro do oval, com espaço sobrando entre o rosto e a borda.',
  recordingIndicatorText: 'Gravando',
  cancelLivenessCheckText: 'Cancelar a verificação',
  errorLabelText: 'Erro',
  connectionTimeoutHeaderText: 'A conexão caiu',
  connectionTimeoutMessageText: 'A conexão demorou demais.',
  timeoutHeaderText: 'O tempo acabou',
  timeoutMessageText: 'O rosto não coube no oval a tempo. Tente de novo, preenchendo o oval com o rosto.',
  faceDistanceHeaderText: 'Você se aproximou cedo demais',
  faceDistanceMessageText: 'Não se aproxime enquanto a verificação conecta.',
  multipleFacesHeaderText: 'Mais de um rosto',
  multipleFacesMessageText: 'Deixe só um rosto na frente da câmera enquanto a verificação conecta.',
  clientHeaderText: 'Algo deu errado',
  clientMessageText: 'A verificação falhou neste aparelho.',
  serverHeaderText: 'Algo deu errado',
  serverMessageText: 'Não foi possível concluir a verificação agora.',
  landscapeHeaderText: 'Use o aparelho na vertical',
  landscapeMessageText: 'Gire o aparelho para a posição vertical.',
  portraitMessageText: 'Mantenha o aparelho na vertical até a verificação terminar.',
  tryAgainText: 'Tentar de novo'
})

// The caller only learns which kind of failure happened: the detector's error
// carries AWS messages and request details that must not reach the screen.
const CAMERA = new Set(['CAMERA_ACCESS_ERROR', 'DEFAULT_CAMERA_NOT_FOUND_ERROR'])
// A stream validation error for a valid session id and region means the
// session ran out or was already used; the service has to start a new one.
const EXPIRED = new Set(['SessionNotFoundException', 'ValidationException'])

export function errorCode (livenessError) {
  const state = livenessError && typeof livenessError === 'object' ? livenessError.state : undefined
  if (CAMERA.has(state)) return 'CAMERA_DENIED'
  if (state === 'CAMERA_FRAMERATE_ERROR') return 'UNSUPPORTED'
  if (state === 'SERVER_ERROR') {
    const err = livenessError.error
    const name = err && typeof err === 'object' ? err.name : undefined
    if (EXPIRED.has(name)) return 'SESSION_EXPIRED'
  }
  return 'FAILED'
}

export function LivenessDetector ({ sessionId, region, credentialProvider, onComplete, onError, onCancel }) {
  // The detector waits for the stylesheet so it is never shown unstyled; the
  // Spinner keeps the card from going blank once the chunk Spinner is gone.
  // A mount that finds the stylesheet loaded renders the detector at once.
  const [ready, setReady] = useState(() => sheet.status === 'loaded')
  const errorRef = useRef(onError)
  errorRef.current = onError
  useEffect(() => watchStylesheet(setReady, (code) => errorRef.current(code)), [])
  if (!ready) return h(Spinner, { size: 'large' })
  return h(FaceLivenessDetectorCore, {
    sessionId,
    region,
    config: { credentialProvider },
    displayText: DISPLAY_TEXT,
    onAnalysisComplete: async () => { onComplete() },
    onError: (livenessError) => { onError(errorCode(livenessError)) },
    onUserCancel: () => { onCancel() }
  })
}

export default LivenessDetector
