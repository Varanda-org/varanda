/* global navigator */

// Ajustes: the cog area, a sheet with a grouped list over sub-screens that
// render embedded inside the sheet. The main list is for people: Editar
// perfil, Conta e @nome, Termos e privacidade, Guardar dados neste aparelho,
// Instalar o app and, apart, Sair. Everything technical sits behind a
// collapsed 'Avançado' row: Conexão, Sincronização (state, log and the old
// top-bar chip text), Identidade técnica (public key behind a reveal,
// association, certificate) and Recomeçar. Rows that only exist on the
// browser node (passkey) hide when `node.passkey === null`. Termos e
// privacidade stays in every mode and shows the record in `termsInfo`. Sair
// drops the key derived from the passkey from memory (signOut, or lock on a
// provider without it) and the shell returns to Entrar; it does not touch
// that record. Recomeçar, once the account is actually gone, calls
// onTermsReset with the old key so the shell can drop its acceptance too.
// Instalar o app shows an 'Instalar' button that opens the browser's install
// dialog whenever the browser offers installation, above a short instruction
// whose Saiba mais sheet holds the per-browser facts. The button never appears in Samsung Internet, because
// Play Protect blocks the app that browser builds.
// Avisos no aparelho (hosted web only, src/pushClient.web.js): the browser
// state, the worker ping and the VAPID key are read once when the sheet
// opens, so a tap reaches pushManager.subscribe() with nothing awaited first
// (Safari's user activation). Sair and Recomeçar switch this browser off
// first, while the key can still sign; a failure there never stops them.

import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNode } from '../node'
import { invitePolicy, pushCheck, pushKey } from '../account'
import { useNames } from '../names'
import { useOutbox } from '../outboxProvider'
import { askPersist } from '../persist'
import { useInstall } from '../install'
import { LEGAL_VERSION } from '../legal'
import { disablePush, enablePush, getPushState, pushSupportNow } from '../pushClient'
import { PUSH_DENIED, PUSH_FAILED, PUSH_LABEL, PUSH_UNCERTAIN, PUSH_UNKNOWN, PUSH_UNSUPPORTED, pushStateAfter, pushUiState } from '../push-state'
import { HELP, SHORT } from '../help'
import { HelpLink } from '../ui/Help'
import { Icon } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { colors, type } from '../ui/theme'
import { Btn, ErrorText, Notice, Page, Row, Soft, useAction } from '../ui'
import Conexao from './Conexao'
import Convites from './Convites'
import Identidade from './Identidade'
import Perfil from './Perfil'
import Sincronizar from './Sincronizar'
import Termos from './Termos'

const TITLES = {
  lista: 'Ajustes',
  perfil: 'Editar perfil',
  conta: 'Conta e @nome',
  termos: 'Termos e privacidade',
  instalar: 'Instalar o app',
  conexao: 'Conexão',
  sincronizar: 'Sincronização',
  identidade: 'Identidade técnica',
  convites: 'Convidar pessoas'
}

const SIGN_OUT_TEXT = 'Sair desta conta neste aparelho? Para voltar, use sua passkey.'
const RESET_TEXT = 'Isto apaga a conta guardada neste aparelho e as publicações que ainda aguardam envio. A conta antiga não pode ser reconstruída: será preciso entrar de novo e vincular outra vez. Para voltar à mesma conta, use a mesma passkey.'

const PUSH_ERRORS = { denied: PUSH_DENIED, failed: PUSH_FAILED, uncertain: PUSH_UNCERTAIN }

function Item ({ icon, label, onPress, first = false, trailing = 'seta', trailingText = null, pending = false, disabled = false, expanded }) {
  const state = { disabled: disabled || pending }
  if (expanded !== undefined) state.expanded = expanded
  return (
    <Pressable
      style={[styles.row, !first && styles.rowDivider]}
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={state}
      disabled={disabled || pending}
      onPress={onPress}
    >
      <Icon name={icon} size={22} color={colors.soft} />
      <Text style={styles.label}>{pending ? label + '…' : label}</Text>
      {trailingText !== null
        ? <Text style={styles.trailing}>{trailingText}</Text>
        : (trailing ? <Icon name={trailing} size={20} color={colors.soft} /> : null)}
    </Pressable>
  )
}

export default function Ajustes ({ screen, onNavigate, onClose, onInfo, termsInfo = null, onTermsReset }) {
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
  // The signup invite policy, read once per opening of the sheet (null: off,
  // unknown or unreadable, so the Convidar pessoas row hides).
  const [policy, setPolicy] = useState(null)
  const sheetOpen = screen !== null
  const policySeq = useRef(0)
  // Avisos no aparelho, read when the sheet opens (null: not read yet).
  const [push, setPush] = useState(null)
  const [pushPending, setPushPending] = useState(false)
  const [pushError, setPushError] = useState('')
  const pushBusy = useRef(false)
  const member = unlocked && typeof passkey.status.publicKey === 'string' ? passkey.status.publicKey : null
  const pushEligible = node.hosted === true && member !== null

  // A closed sheet forgets the open confirmations.
  useEffect(() => {
    if (screen === null) {
      setConfirm(null)
      setSaved('')
    }
  }, [screen])

  // The operation in flight outlives a close and reopen of the sheet (this
  // component stays mounted): a reopen waits for it instead of racing it.
  // Every read or result is applied only while it is the newest one.
  const pushOp = useRef(null) // null | { member, promise }
  const pushSeq = useRef(0)

  const readPush = async (who) => {
    const state = await getPushState()
    if (state.support !== 'ok') return { ...state, key: null, registered: null }
    const [key, check] = await Promise.all([
      pushKey(),
      state.endpoint ? pushCheck({ member: who, endpoint: state.endpoint, p256dh: state.p256dh, auth: state.auth }) : null
    ])
    return { ...state, key, registered: check ? check.registered : null }
  }

  useEffect(() => {
    const seq = ++pushSeq.current
    setPushError('')
    if (!sheetOpen || !pushEligible) {
      setPush(null)
      return
    }
    ;(async () => {
      const op = pushOp.current
      if (op !== null && op.member === member) {
        const view = await op.promise
        if (seq !== pushSeq.current) return
        setPush(view.push)
        setPushError(view.error)
        return
      }
      const state = await readPush(member)
      if (seq === pushSeq.current) setPush(state)
    })().catch(() => {})
  }, [sheetOpen, pushEligible, member])

  // Called straight from the press: enablePush awaits nothing before
  // subscribe(), and neither may this handler. The outcome shown is a fresh
  // read made after the step, never what the step was meant to do.
  const togglePush = () => {
    if (pushBusy.current || push === null || member === null) return
    pushBusy.current = true
    setPushPending(true)
    setPushError('')
    const before = push
    const who = member
    const seq = pushSeq.current
    const turnOff = before.subscribed === true && before.registered === true
    const step = turnOff
      ? disablePush({ node, member: who, registration: before.registration, subscription: before.subscription })
      : enablePush({ node, member: who, key: before.key, registration: before.registration, subscription: before.subscription, subscriptionKnown: before.subscribed !== null })
    const promise = Promise.resolve(step).catch(() => ({ ok: false, reason: 'failed' })).then(async (result) => {
      let after = null
      try { after = await readPush(who) } catch {}
      const { error, ...next } = pushStateAfter({ action: turnOff ? 'off' : 'on', result, before, after })
      return { push: next, error: error === null ? '' : (PUSH_ERRORS[error] || PUSH_FAILED) }
    })
    const op = { member: who, promise }
    pushOp.current = op
    promise.then((view) => {
      if (seq !== pushSeq.current) return
      setPush(view.push)
      setPushError(view.error)
    }).finally(() => {
      if (pushOp.current === op) pushOp.current = null
      pushBusy.current = false
      setPushPending(false)
    })
  }

  // Before signing out or erasing, while push.sign still works. Its outcome
  // never blocks Sair or Recomeçar.
  const pushOffHere = async () => {
    if (member === null || pushSupportNow() !== 'ok') return
    try {
      await disablePush({ node, member, registration: push ? push.registration : null, subscription: push ? push.subscription : null })
    } catch {}
  }

  // Only the hosted web node has an account service on its own origin.
  const hosted = node.hosted === true
  useEffect(() => {
    const mine = ++policySeq.current
    setPolicy(null)
    if (!sheetOpen || !hosted) return
    invitePolicy().then((p) => { if (mine === policySeq.current) setPolicy(p) }, () => {})
  }, [sheetOpen, hosted])

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
      await pushOffHere()
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
      await pushOffHere()
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
              {inviting ? <Item icon='link' label='Convidar pessoas' onPress={() => onNavigate('convites')} /> : null}
              <Item icon='file-text' label='Termos e privacidade' onPress={() => onNavigate('termos')} />
              {pushRow
                ? (
                  <Item
                    icon='bell'
                    label={PUSH_LABEL}
                    trailingText={pushTrailing}
                    trailing={null}
                    pending={pushPending}
                    disabled={pushUi.disabled}
                    onPress={togglePush}
                  />
                  )
                : null}
              {hasPasskey
                ? <Item icon='download' label='Guardar dados neste aparelho' trailing={null} pending={persistPending} onPress={doPersist} />
                : null}
              {hasPasskey ? <Item icon='smartphone' label='Instalar o app' onPress={() => onNavigate('instalar')} /> : null}
            </View>
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
        <View style={shown('instalar')}>
          <Page>
            {install.canPrompt ? <Btn label='Instalar' onPress={() => { install.promptInstall() }} /> : null}
            <Soft>{SHORT.install}</Soft>
            <HelpLink doc={HELP.instalar} />
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

const styles = StyleSheet.create({
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
  trailing: { fontSize: 15, color: colors.soft }
})
