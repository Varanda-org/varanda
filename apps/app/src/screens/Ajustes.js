/* global navigator */

// Ajustes: the cog area, a sheet with a grouped list over sub-screens that
// render embedded inside the sheet. The main list is for people: Editar
// perfil, Conta e @nome, Termos e privacidade, Guardar dados neste aparelho,
// Instalar o app and, apart, Sair. Everything technical sits behind a
// collapsed 'Avançado' row: Conexão, Sincronização (state, log and the old
// top-bar chip text), Identidade técnica (public key behind a reveal,
// association, certificate) and Recomeçar. Rows that only exist on a
// passkey node (the browser node, and the app's in-app web node, whose Sair
// and Recomeçar go through src/identity.native.js) hide when
// `node.passkey === null`. Termos e
// privacidade stays in every mode and shows the record in `termsInfo`. Sair
// drops the key derived from the passkey from memory (signOut, or lock on a
// provider without it) and the shell returns to Entrar; it does not touch
// that record. Recomeçar, once the account is actually gone, calls
// onTermsReset with the old key so the shell can drop its acceptance too.
// Instalar o app shows an 'Instalar' button that opens the browser's install
// dialog whenever the browser offers installation, above a short instruction
// whose info sheet holds the per-browser facts. The button never appears in Samsung Internet, because
// Play Protect blocks the app that browser builds.
// Avisos no aparelho (hosted web only, src/pushClient.web.js): the browser
// state, the worker ping and the VAPID key are read through the shared store
// (src/push-offer.js via src/usePush) when the shell arms the member and when
// the sheet opens, and the shell's 'Receber avisos neste aparelho' note drives
// the same store, so a tap on the row or on the note reaches
// pushManager.subscribe() with nothing awaited first (Safari's user
// activation). Sair and Recomeçar still switch this browser off first, while
// the key can still sign; a failure there never stops them.
// Passkeys e recuperação (hosted passkey node, unlocked) opens the extra
// passkeys and the recovery code of the account (./Passkeys.js).
// Excluir conta (hosted passkey node, unlocked), under Sair, opens
// ./ExcluirConta.js: App Store guideline 5.1.1(v), deletion starts in the app.
// The footer under the list shows the build and the commit the installation
// serves, only through the src/version.js formatters, and a tap copies them.
// Prévia de links (src/previewPref.js): off, the composers never look up a
// pasted link; cards other people send still show. The choice lives in the
// same previewPrefStore() (../previewBuild) the composers read, so it reaches
// them and survives a restart on every platform.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useNode } from '../node'
import { invitePolicy } from '../account'
import { useNames } from '../names'
import { useOutbox } from '../outboxProvider'
import { askPersist } from '../persist'
import { useInstall } from '../install'
import { LEGAL_VERSION } from '../legal'
import { PUSH_LABEL, PUSH_UNKNOWN, PUSH_UNSUPPORTED, pushUiState } from '../push-state'
import { usePush } from '../usePush'
import { HELP, SHORT } from '../help'
import { HelpNote } from '../ui/Help'
import { Icon } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { MODES, MODE_LABELS } from '../appearance'
import { Btn, ErrorText, Notice, Page, Row, Soft, useAction } from '../ui'
import { pagesOn } from '../pageGate'
import { PREVIEW_PREF_LABEL, previewsEnabled, setPreviewsEnabled } from '../previewPref'
import { previewPrefStore } from '../previewBuild'
import { buildInfo, fetchDeployedCommit, versionDetails, versionLines } from '../version'
import { runningRelease } from '../runningRelease'
import { installationOrigin } from '../installation'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import Conexao from './Conexao'
import ExcluirConta from './ExcluirConta'
import Convites from './Convites'
import Identidade from './Identidade'
import Passkeys from './Passkeys'
import Perfil from './Perfil'
import Sincronizar from './Sincronizar'
import Termos from './Termos'

// The kind of build is the binary itself (web bundle, Android app, iOS app):
// Platform.OS is the only source, there is no capability to test. Metro
// inlines the two EXPO_PUBLIC_* member expressions at bundle time
// (apps/app/metro.config.js sets them; see configStore.native.js
// loadInstallation).
const BUILD = buildInfo({ kind: Platform.OS, commit: process.env.EXPO_PUBLIC_VARANDA_COMMIT, builtAt: process.env.EXPO_PUBLIC_VARANDA_BUILD_DATE, release: runningRelease() })

const TITLES = {
  lista: 'Ajustes',
  perfil: 'Editar perfil',
  conta: 'Conta e @nome',
  passkeys: 'Passkeys e recuperação',
  termos: 'Termos e privacidade',
  aparencia: 'Aparência',
  instalar: 'Instalar o app',
  conexao: 'Conexão',
  sincronizar: 'Sincronização',
  identidade: 'Identidade técnica',
  convites: 'Convidar pessoas',
  excluir: 'Excluir conta'
}

const PREVIEW_PREF_NOTE = 'Desligada, o app nunca consulta os links que você cola. Prévias que outras pessoas enviam continuam aparecendo.'

// Decided by what exists, not by the platform: a store from the shell, the
// browser's storage, or memory for this session.
const SIGN_OUT_TEXT = 'Sair desta conta neste aparelho? Para voltar, use qualquer passkey cadastrada nesta conta ou o código de recuperação.'
const RESET_TEXT = 'Isto apaga a conta guardada neste aparelho e as publicações que ainda aguardam envio. Para voltar à mesma conta, entre com qualquer passkey cadastrada nela ou com o código de recuperação. Sem passkey e sem código, a conta antiga não pode ser reconstruída: será preciso entrar de novo e vincular outra vez.'

function Item ({ icon, label, onPress, first = false, trailing = 'seta', trailingText = null, pending = false, disabled = false, expanded, checked, toggle = false }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const state = { disabled: disabled || pending }
  if (expanded !== undefined) state.expanded = expanded
  if (checked !== undefined) state.checked = checked
  const radio = checked !== undefined
  // react-native-web drops accessibilityState (aria-checked carries it) and
  // presses only buttons on Space, so a radio row handles Space itself.
  const radioKeys = radio && !(disabled || pending)
    ? (e) => {
        if (e.key !== ' ' && e.key !== 'Spacebar') return
        e.preventDefault()
        onPress()
      }
    : undefined
  return (
    <Pressable
      style={[styles.row, !first && styles.rowDivider]}
      accessibilityRole={radio ? (toggle ? 'switch' : 'radio') : 'button'}
      accessibilityLabel={label}
      accessibilityState={state}
      aria-checked={radio ? checked : undefined}
      disabled={disabled || pending}
      onPress={onPress}
      onKeyDown={radioKeys}
    >
      <Icon name={icon} size={22} color={colors.soft} />
      <Text style={styles.label}>{pending ? label + '…' : label}</Text>
      {trailingText !== null
        ? <Text style={styles.trailing}>{trailingText}</Text>
        : (trailing ? <Icon name={trailing} size={20} color={colors.soft} /> : null)}
    </Pressable>
  )
}

export default function Ajustes ({ screen, onNavigate, onClose, onInfo, termsInfo = null, onTermsReset, onOpenPaginas, inviteNudge = 0 }) {
  const styles = useStyles(makeStyles)
  const { colors, mode, setMode } = useTheme()
  const node = useNode()
  const names = useNames()
  const outbox = useOutbox()
  // The embedded screens reload when the node becomes ready again.
  const ready = node.phase === 'ready'
  const passkey = node.passkey
  const hasPasskey = passkey !== null && passkey !== undefined
  const unlocked = hasPasskey && passkey.status !== null && passkey.status.unlocked === true
  const install = useInstall()

  const [advanced, setAdvanced] = useState(false)
  const prefStore = previewPrefStore()
  const [previews, setPreviews] = useState(() => previewsEnabled(prefStore))
  const togglePreviews = () => {
    const next = !previews
    if (setPreviewsEnabled(prefStore, next)) setPreviews(next)
  }
  const [confirm, setConfirm] = useState(null) // null | 'sair' | 'recomecar'
  const exit = useAction()
  const reset = useAction()
  // Result of asking the browser to keep this origin's data (null: not asked yet).
  const [persisted, setPersisted] = useState(null)
  const [persistPending, setPersistPending] = useState(false)
  // The own key and profile for the editor (read when it opens).
  const [own, setOwn] = useState({ key: null })
  // node.info failed for Convidar pessoas; infoTick re-asks it.
  const [ownFailed, setOwnFailed] = useState(false)
  const [infoTick, setInfoTick] = useState(0)
  const [saved, setSaved] = useState('')
  // The signup invite policy, read once per opening of the sheet (null: not
  // answered yet, so the Convidar pessoas row hides). A convite push can open
  // the screen before this answer; required false means there is nothing to show.
  const [policy, setPolicy] = useState(null)
  const sheetOpen = screen !== null
  const policySeq = useRef(0)
  const member = unlocked && typeof passkey.status.publicKey === 'string' ? passkey.status.publicKey : null
  // A core node registers its delegate and accepts the Terms on the page
  // screens' first use (Paginas.js usePageMember); this row only opens them.
  const openPaginas = () => {
    onClose()
    onOpenPaginas()
  }
  const pushEligible = node.hosted === true && member !== null
  // Avisos no aparelho, from the store the shell's note shares (null: not
  // read yet, or this node is not the hosted one for this member any more).
  const pushStore = usePush()
  const push = pushEligible && pushStore.member === member ? pushStore.state : null
  const pushPending = pushStore.pending
  const pushError = pushStore.error
  const [server, setServer] = useState({ status: 'loading', commit: null })
  const [versionNote, setVersionNote] = useState('')
  const noteTimer = useRef(null)
  // Bumped on every tap and when the sheet closes: only the latest tap, in the
  // still-open sheet, may show its copy result.
  const copyTurn = useRef(0)

  // A closed sheet forgets the open confirmations.
  useEffect(() => {
    if (screen === null) {
      setConfirm(null)
      setSaved('')
      setVersionNote('')
      clearTimeout(noteTimer.current)
      copyTurn.current++
    }
  }, [screen])

  useEffect(() => () => {
    clearTimeout(noteTimer.current)
    copyTurn.current++
  }, [])

  // On the web the page origin is the installation and the request is
  // relative, so a null installation still asks; a native build without one
  // has nowhere to ask.
  useEffect(() => {
    if (screen !== 'lista') return
    const installation = installationOrigin()
    if (installation === null && Platform.OS !== 'web') {
      setServer({ status: 'unconfigured', commit: null })
      return
    }
    let alive = true
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    setServer({ status: 'loading', commit: null })
    fetchDeployedCommit({ installation, fetch: globalThis.fetch, signal: ctrl.signal }).then((r) => { if (alive) setServer(r) })
    return () => {
      alive = false
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [screen])

  const copyVersion = async () => {
    const turn = ++copyTurn.current
    const ok = await copyText(shareNav(), versionDetails({ app: BUILD, server }))
    if (turn !== copyTurn.current) return
    setVersionNote(ok ? 'Detalhes copiados.' : 'Não foi possível copiar.')
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setVersionNote(''), 2000)
  }

  // A fresh read on every opening. Closing keeps the state because the shell
  // needs the registration; a lock clears it through the shell's readPush.
  useEffect(() => {
    if (sheetOpen && pushEligible) pushStore.readPush(member)
  }, [sheetOpen, pushEligible, member, pushStore.readPush])

  // Only the hosted web node has an account service on its own origin.
  const hosted = node.hosted === true
  // A 404 (null) is "not required", so a screen opened by a convite push
  // never waits forever. A failed read keeps the row hidden (policy stays
  // null) and the convite screen offers a retry instead of leaving.
  const [policyFailed, setPolicyFailed] = useState(false)
  const askPolicy = useCallback(() => {
    const mine = ++policySeq.current
    setPolicyFailed(false)
    invitePolicy().then((p) => { if (mine === policySeq.current) setPolicy(p === null ? { required: false } : p) }, () => { if (mine === policySeq.current) setPolicyFailed(true) })
  }, [])
  useEffect(() => {
    ++policySeq.current
    setPolicy(null)
    if (!sheetOpen || !hosted) return
    askPolicy()
  }, [sheetOpen, hosted, askPolicy])

  // The push opens Convidar pessoas before the policy is known. A service
  // that does not require invites has no such screen.
  useEffect(() => {
    if (screen === 'convites' && policy !== null && policy.required === false) onNavigate('lista')
  }, [screen, policy, onNavigate])

  useEffect(() => {
    if ((screen !== 'perfil' && screen !== 'convites') || !ready) return
    let alive = true
    setOwnFailed(false)
    node.request('node.info', {}).then((i) => {
      if (!alive) return
      if (typeof i.publicKey === 'string') {
        setOwn({ key: i.publicKey })
        names.resolve(i.publicKey)
      } else {
        setOwnFailed(true)
      }
    }, () => { if (alive) setOwnFailed(true) })
    return () => { alive = false }
  }, [screen, ready, node.request, infoTick])

  const doExit = async () => {
    const out = typeof passkey.signOut === 'function' ? passkey.signOut : passkey.lock
    const r = await exit.run(async () => {
      await pushStore.turnOffPush({ node, member })
      return out()
    })
    if (r.ok) {
      setConfirm(null)
      onClose()
    }
  }

  const doReset = async () => {
    const oldKey = passkey.status ? passkey.status.publicKey : null
    if (typeof oldKey === 'string' && !outbox.forgetAuthor(oldKey)) {
      return reset.run(() => { throw new Error('não foi possível apagar as publicações que aguardam envio neste aparelho') })
    }
    const r = await reset.run(async () => {
      await pushStore.turnOffPush({ node, member })
      return passkey.reset()
    })
    if (r.ok) {
      // The old key is gone from this device. Sair does not come through here.
      if (typeof oldKey === 'string' && typeof onTermsReset === 'function') onTermsReset(oldKey)
      setConfirm(null)
      onClose()
    }
  }

  const doPersist = async () => {
    setPersistPending(true)
    try {
      setPersisted(await askPersist(typeof navigator === 'object' && navigator !== null ? navigator.storage : null))
    } finally {
      setPersistPending(false)
    }
  }

  const left = screen === 'lista'
    ? (
      <Pressable accessibilityRole='button' accessibilityLabel='Fechar' onPress={onClose} hitSlop={8}>
        <Text style={styles.cancel}>Fechar</Text>
      </Pressable>
      )
    : (
      <Pressable
        style={styles.back}
        accessibilityRole='button'
        accessibilityLabel='voltar para Ajustes'
        onPress={() => onNavigate('lista')}
        hitSlop={8}
      >
        <Icon name='voltar' size={22} color={colors.ink} />
        <Text style={styles.cancel}>Ajustes</Text>
      </Pressable>
      )

  const profile = own.key ? names.profileOf(own.key) : undefined
  const current = { name: (profile && profile.name) || '', bio: (profile && profile.bio) || '', avatar: profile ? profile.avatar : undefined }
  const account = node.hosted === true && hasPasskey
  const pushUi = push === null
    ? null
    : pushUiState({
      support: push.support,
      keyAvailable: push.key !== null,
      permission: push.permission,
      subscribed: push.subscribed,
      registered: push.registered,
      pending: pushPending,
      swUpToDate: push.swUpToDate
    })
  // A key the service did not hand over hides the row: push is off here.
  const pushRow = pushUi !== null && push.support === 'ok' && push.key !== null
  // A state that could not be confirmed is never labelled "Desligados".
  const pushTrailing = pushUi === null ? null : (pushUi.on ? 'Ligados' : (pushUi.note === PUSH_UNKNOWN ? null : 'Desligados'))
  const inviting = account && policy !== null && policy.required === true
  const lines = versionLines({ app: BUILD, server })

  // While the sheet is open every sub-screen stays mounted (drafts typed in
  // Conexão or Identidade survive going back to the list); the inactive ones
  // are hidden. Closing the whole sheet discards them.
  const shown = (id) => (screen === id ? styles.flex : styles.hidden)
  const body = screen === null
    ? null
    : (
      <>
        <View style={shown('lista')}>
          <Page>
            <Notice>{saved}</Notice>
            <View style={styles.group}>
              <Item first icon='user' label='Editar perfil' onPress={() => { setSaved(''); onNavigate('perfil') }} />
              {account ? <Item icon='at-sign' label='Conta e @nome' onPress={() => onNavigate('conta')} /> : null}
              {account && unlocked ? <Item icon='shield' label='Passkeys e recuperação' onPress={() => onNavigate('passkeys')} /> : null}
              {inviting ? <Item icon='link' label='Convidar pessoas' onPress={() => onNavigate('convites')} /> : null}
              {pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) && typeof onOpenPaginas === 'function'
                ? <Item icon='gente' label='Páginas' onPress={openPaginas} />
                : null}
              <Item icon='file-text' label='Termos e privacidade' onPress={() => onNavigate('termos')} />
              <Item icon='sun' label='Aparência' trailingText={MODE_LABELS[mode]} onPress={() => onNavigate('aparencia')} />
              <Item icon='link' label={PREVIEW_PREF_LABEL} toggle checked={previews} trailingText={previews ? 'Ligada' : 'Desligada'} onPress={togglePreviews} />
              {pushRow
                ? (
                  <Item
                    icon='bell'
                    label={PUSH_LABEL}
                    trailingText={pushTrailing}
                    trailing={null}
                    pending={pushPending}
                    disabled={pushUi.disabled}
                    onPress={() => { pushStore.togglePush({ node, member }) }}
                  />
                  )
                : null}
              {hasPasskey && Platform.OS === 'web'
                ? <Item icon='download' label='Guardar dados neste aparelho' trailing={null} pending={persistPending} onPress={doPersist} />
                : null}
              {hasPasskey && Platform.OS === 'web' ? <Item icon='smartphone' label='Instalar o app' onPress={() => onNavigate('instalar')} /> : null}
            </View>
            <Soft>{PREVIEW_PREF_NOTE}</Soft>
            {pushRow && pushUi.note && pushUi.note !== pushError ? <Soft>{pushUi.note}</Soft> : null}
            {pushRow ? <ErrorText>{pushError}</ErrorText> : null}
            {pushUi !== null && push.support === 'unsupported' ? <Soft>{PUSH_UNSUPPORTED}</Soft> : null}
            {persisted === null
              ? null
              : <Soft>{persisted ? 'Pronto: seus dados ficam guardados neste aparelho.' : 'O navegador não garantiu guardar seus dados: ele pode apagá-los se faltar espaço.'}</Soft>}
            {unlocked
              ? (
                <>
                  <View style={styles.group}>
                    <Item first icon='log-out' label='Sair' trailing={null} onPress={() => { exit.clearError(); setConfirm(confirm === 'sair' ? null : 'sair') }} />
                    {account ? <Item icon='lixeira' label='Excluir conta' onPress={() => { setConfirm(null); onNavigate('excluir') }} /> : null}
                  </View>
                  {confirm === 'sair'
                    ? (
                      <View style={styles.confirm}>
                        <Soft>{SIGN_OUT_TEXT}</Soft>
                        <Row>
                          <Btn label='Sair' danger onPress={doExit} pending={exit.pending} />
                          <Btn label='Cancelar' secondary onPress={() => setConfirm(null)} disabled={exit.pending} />
                        </Row>
                      </View>
                      )
                    : null}
                  <ErrorText>{exit.error}</ErrorText>
                </>
                )
              : null}

            <View style={styles.group}>
              <Item
                first
                icon='sliders'
                label='Avançado'
                trailing={advanced ? 'chevron-up' : 'chevron-down'}
                expanded={advanced}
                onPress={() => setAdvanced((v) => !v)}
              />
              {advanced
                ? (
                  <>
                    <Item icon='wifi' label='Conexão' onPress={() => onNavigate('conexao')} />
                    <Item icon='refresh-cw' label='Sincronização' onPress={() => onNavigate('sincronizar')} />
                    <Item icon='key' label='Identidade técnica' onPress={() => onNavigate('identidade')} />
                    {hasPasskey
                      ? <Item icon='rotate-ccw' label='Recomeçar' trailing={null} onPress={() => { reset.clearError(); setConfirm(confirm === 'recomecar' ? null : 'recomecar') }} />
                      : null}
                  </>
                  )
                : null}
            </View>
            {advanced && confirm === 'recomecar'
              ? (
                <View style={styles.confirm}>
                  <Soft>{RESET_TEXT}</Soft>
                  <Row>
                    <Btn label='Apagar e recomeçar' danger onPress={doReset} pending={reset.pending} />
                    <Btn label='Cancelar' secondary onPress={() => setConfirm(null)} disabled={reset.pending} />
                  </Row>
                  <ErrorText>{reset.error}</ErrorText>
                </View>
                )
              : null}
            <Pressable
              style={styles.version}
              accessibilityRole='button'
              accessibilityLabel={[lines.appLine, lines.serverLine, versionNote].filter(Boolean).join('. ')}
              accessibilityHint='copia os detalhes da versão'
              onPress={copyVersion}
            >
              <Text style={styles.versionText}>{lines.appLine}</Text>
              {lines.serverLine !== null ? <Text style={styles.versionText}>{lines.serverLine}</Text> : null}
              {versionNote ? <Text style={styles.versionText}>{versionNote}</Text> : null}
            </Pressable>
          </Page>
        </View>
        <View style={shown('perfil')}>
          {/* Mounted only once the own profile is known: the form starts from
              `current` and never sees a later update, so an early mount would
              show (and save) empty fields over an existing profile. */}
          {own.key && profile !== undefined
            ? (
              <Perfil
                embedded
                open={screen === 'perfil'}
                ownKey={own.key}
                current={current}
                onClose={() => onNavigate('lista')}
                onSaved={(values) => {
                  names.learn(own.key, values)
                  // The authoritative answer also replaces a cleared bio.
                  names.invalidate([own.key])
                  setSaved('Perfil salvo.')
                  onNavigate('lista')
                }}
              />
              )
            : <Page><Soft>carregando…</Soft></Page>}
        </View>
        <View style={shown('conta')}>
          <Identidade active={ready && screen === 'conta'} embedded view='conta' onInfo={onInfo} />
        </View>
        {/* Kept mounted like the others; it drops a shown recovery code as
            soon as it is not the active screen. */}
        {account
          ? (
            <View style={shown('passkeys')}>
              <Passkeys active={ready && screen === 'passkeys'} embedded />
            </View>
            )
          : null}
        {account && unlocked
          ? (
            <View style={shown('excluir')}>
              <ExcluirConta
                active={ready && screen === 'excluir'}
                member={member}
                onOpenPaginas={pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) && typeof onOpenPaginas === 'function' ? openPaginas : undefined}
                onTermsReset={onTermsReset}
                onDone={onClose}
              />
            </View>
            )
          : null}
        {screen === 'convites' && hosted && policy === null
          ? (
            <View style={shown('convites')}>
              {policyFailed
                ? <Page><Soft>serviço indisponível</Soft><Btn label='tentar de novo' onPress={askPolicy} /></Page>
                : <Page><Soft>carregando…</Soft></Page>}
            </View>
            )
          : null}
        {inviting
          ? (
            <View style={shown('convites')}>
              <Convites
                open={screen === 'convites'}
                active={ready && screen === 'convites'}
                ownKey={own.key}
                perWeek={policy.perWeek}
                keyFailed={ownFailed}
                onRetryKey={() => setInfoTick((n) => n + 1)}
                inviteNudge={inviteNudge}
              />
            </View>
            )
          : null}
        <View style={shown('termos')}>
          <Termos
            version={termsInfo ? termsInfo.version : LEGAL_VERSION}
            acceptedAt={termsInfo ? termsInfo.acceptedAt : null}
            saved={termsInfo ? termsInfo.saved : true}
            syncState={termsInfo ? termsInfo.syncState : null}
          />
        </View>
        <View style={shown('aparencia')}>
          <Page>
            <View style={styles.group} accessibilityRole='radiogroup' accessibilityLabel='Aparência'>
              {MODES.map((m, i) => (
                <Item
                  key={m}
                  first={i === 0}
                  icon={m === 'dark' ? 'moon' : m === 'light' ? 'sun' : 'smartphone'}
                  label={MODE_LABELS[m]}
                  checked={mode === m}
                  trailing={mode === m ? 'ok' : null}
                  onPress={() => setMode(m)}
                />
              ))}
            </View>
            <Soft>Sistema segue o modo claro ou escuro do aparelho.</Soft>
          </Page>
        </View>
        <View style={shown('instalar')}>
          <Page>
            {install.canPrompt ? <Btn label='Instalar' onPress={() => { install.promptInstall() }} /> : null}
            <HelpNote doc={HELP.instalar}><Soft>{SHORT.install}</Soft></HelpNote>
          </Page>
        </View>
        <View style={shown('conexao')}>
          <Conexao active={ready && screen === 'conexao'} embedded />
        </View>
        <View style={shown('sincronizar')}>
          <Sincronizar embedded onOpenConnection={() => onNavigate('conexao')} />
        </View>
        <View style={shown('identidade')}>
          <Identidade active={ready && screen === 'identidade'} embedded view='tecnica' onInfo={onInfo} />
        </View>
      </>
      )

  return (
    <Sheet open={screen !== null} onClose={onClose} title={TITLES[screen]} left={left} background={colors.bg}>
      {body}
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1 },
  hidden: { display: 'none' },
  cancel: { ...type.cancel, color: colors.ink },
  back: { flexDirection: 'row', alignItems: 'center', marginLeft: -6 },
  group: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
    marginBottom: 12
  },
  confirm: { gap: 8, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  label: { flex: 1, fontSize: 16, color: colors.ink },
  trailing: { fontSize: 15, color: colors.soft },
  version: { alignItems: 'center', justifyContent: 'center', minHeight: 48, paddingVertical: 12, gap: 2 },
  versionText: { fontSize: 12, lineHeight: 16, color: colors.soft, textAlign: 'center' }
})
