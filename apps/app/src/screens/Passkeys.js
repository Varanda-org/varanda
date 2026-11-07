// Ajustes › Passkeys e recuperação (docs/rpc.md 5.90 to 5.94): the extra
// passkeys and the recovery code that open this same account. One shared
// screen for the phone, the web and the PWA: it decides by capability (a
// hosted, unlocked passkey node), never by platform, and calls no browser API.
//
// Every passkey ceremony (addPasskey, complete) is called synchronously in
// the press handler, so the WebAuthn sheet keeps the press's activation:
// nothing is awaited before it. Nothing here repeats a call that failed: an
// unknown outcome shows UNCERTAIN and a 'conferir' that re-reads the list.
// A passkey created in the manager but not registered stays in memory (this
// module, for this session) so 'registrar de novo' can register it without
// a new ceremony; Identidade puts a passkey it created at the end of a code
// recovery here too (holdUnregistered).
//
// The recovery code is shown once. A successful put already made the
// previous code stop working, so the new one is kept in this module's memory
// (like the held passkey) from its creation until the person pressed 'pronto'
// with 'Anotei o código' ticked, or until its put definitively failed: a
// screen that became inactive or unmounted while the put was in flight shows
// it when it is active again. A code whose registration has an unknown
// outcome stays shown too, with 'conferir': it may open the account, so it is
// never dropped just because the answer was lost. It never goes to a log, a
// navigation param or an error text. Server answers only reach the screen as
// the fixed sentences of ../account.js (errorText).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNode } from '../node'
import { recoveryList, recoveryPut, recoveryRemove, recoveryStart } from '../account'
import { CHANGE_TEXT, CODE_ONCE_TEXT, LOSS_TEXT, listEntries, registerEntry, removeEntry } from '../recovery'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import { Body, Btn, Card, ConfirmStack, ErrorText, Label, Mono, Notice, Page, Soft, Title, UNCERTAIN, errorText } from '../ui'
import { Icon } from '../ui/Icon'
import { useStyles, useTheme } from '../ui/ThemeProvider'

const ACCOUNT = { recoveryStart, recoveryPut, recoveryRemove, recoveryList }

export const INTRO_TEXT = 'Cadastre outra passkey ou um código de recuperação: eles abrem esta mesma conta se você perder a passkey.'
export const LIST_NOTE = 'A passkey com que a conta foi criada não aparece na lista e continua abrindo a conta.'
export const EMPTY_TEXT = 'Nenhuma passkey extra e nenhum código de recuperação cadastrados.'
export const ADDED_TEXT = 'Passkey adicionada: ela também abre esta conta.'
export const CHANGED_TEXT = 'Pronto: este aparelho passou a usar a passkey nova. Confira que ela entra na conta e só depois apague a antiga no gerenciador de senhas.'
export const NOT_REGISTERED_TEXT = 'A passkey foi criada no gerenciador de senhas, mas não foi cadastrada na conta, então ainda não abre a conta. Toque em registrar de novo. Se desistir, apague essa passkey no gerenciador de senhas.'
export const CREATED_LEFT_TEXT = 'A passkey foi criada no gerenciador de senhas, mas não foi cadastrada na conta, então não abre a conta. Se desistir, apague essa passkey no gerenciador de senhas.'
export const BIND_FAILED_TEXT = 'A passkey nova foi cadastrada, mas este aparelho continua usando a antiga. Toque em Usar a passkey nova.'
export const NEW_CODE_TEXT = 'Um código novo substitui o anterior no serviço de conta: o anterior deixa de entrar num aparelho que ainda não o usou. Quem já entrou com o código anterior continua com acesso, porque a chave da conta não pode ser trocada. Se o código pode ter vazado, o caminho seguro é criar uma conta nova.'
export const CODE_ACK_LABEL = 'Anotei o código'
export const PENDING_TEXT = 'A passkey foi criada. Toque abaixo para concluir.'
export const CODE_UNKNOWN_TEXT = 'Não sabemos se este código foi cadastrado. Anote-o mesmo assim e toque em conferir.'
export const CODE_NOT_SAVED_TEXT = 'O código não foi cadastrado, então não abre a conta. Crie outro.'
export const CODE_NOTED_NOT_SAVED_TEXT = 'O código anotado não foi cadastrado e não abre a conta. Crie outro.'
const REMOVE_PASSKEY_TEXT = 'Remover esta passkey? Daqui em diante ela não serve mais para entrar na conta, inclusive num aparelho que entra com ela. Mas quem já entrou com ela, ou um aparelho ainda aberto com ela, continua com acesso, porque a chave da conta não pode ser trocada. Depois, apague-a também no gerenciador de senhas. Se ela pode ter vazado, o caminho seguro é criar uma conta nova.'
const REMOVE_CODE_TEXT = 'Remover o código de recuperação? Daqui em diante ele não serve mais para entrar na conta. Mas quem já entrou com ele continua com acesso, porque a chave da conta não pode ser trocada. Se ele pode ter vazado, o caminho seguro é criar uma conta nova.'
const CREATE_FAILED = 'não foi possível criar a passkey'
const CODE_FAILED = 'não foi possível criar o código de recuperação'

// A passkey created by Identidade at the end of a code recovery whose
// registration failed, or one created here: { member, kind, lookupId, blob,
// credentialId, userId, change }. Memory only, never stored.
let unregistered = null
const heldListeners = new Set()
function setHeld (entry) {
  unregistered = entry
  for (const fn of heldListeners) fn()
}
export function holdUnregistered (entry) {
  setHeld(entry && typeof entry === 'object' ? { ...entry } : null)
}
export function releaseUnregistered () {
  setHeld(null)
}

// The recovery code being made or waiting for 'pronto': { member, code,
// lookupId, settled, unknown }. settled: its put answered (or the outcome is
// unknown); before that it is never shown, since a refused put drops it.
// Memory only, never stored.
let heldCode = null
function setHeldCode (value) {
  heldCode = value
  for (const fn of heldListeners) fn()
}

// Which kind of creation the handle's pending passkey belongs to ({ member,
// change }), so 'concluir' still binds a replacement after this screen
// unmounted. Whether a creation is pending at all comes from the handle's
// status().pending, never from here. Memory only.
let pendingAdd = null

// A registered replacement ('Trocar') this device could not bind yet:
// { member, credentialId, userId }. Kept here so 'Usar a passkey nova'
// survives leaving Ajustes. Memory only.
let pendingBind = null
function setPendingBind (value) {
  pendingBind = value
  for (const fn of heldListeners) fn()
}

// The member whose code put succeeded while the list could not confirm it:
// a second code still asks for the replacement confirmation until a
// successful list says there is no code. Memory only.
let codeRegisteredFor = null

// A code put whose outcome is unknown, until a 'conferir' answers it:
// { member, lookupId }. Outlives 'pronto', which drops the code text: a put
// that did not apply leaves a noted code that opens nothing, one that did
// apply already buried the previous code. Only the lookup id, never the code.
// Memory only.
let uncertainCode = null
function setUncertainCode (value) {
  uncertainCode = value
  for (const fn of heldListeners) fn()
}

function createdEntry (r) {
  return !!r && typeof r === 'object' && typeof r.lookupId === 'string' && !!r.blob && typeof r.blob === 'object'
}

function dateText (iso) {
  const d = new Date(String(iso))
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleDateString('pt-BR', { dateStyle: 'short' })
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

function Check ({ checked, label, onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <Pressable
      style={styles.check}
      accessibilityRole='checkbox'
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      aria-checked={checked}
      onPress={onPress}
      hitSlop={8}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked ? <Icon name='ok' size={16} color={colors.bg} /> : null}
      </View>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  )
}

export default function Passkeys ({ active, embedded = false }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const passkey = node.passkey
  const status = passkey ? passkey.status : null
  const unlocked = status !== null && status.unlocked === true
  const member = passkey && node.hosted === true && unlocked && typeof status.publicKey === 'string' ? status.publicKey : null

  const [entries, setEntries] = useState(null)
  const [listError, setListError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  // null, or { uncertain } after a put or remove that failed.
  const [failure, setFailure] = useState(null)
  const [confirmChange, setConfirmChange] = useState(false)
  const [confirmNewCode, setConfirmNewCode] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(null)
  // The handle keeps a pending creation across this screen's unmounts, so
  // 'concluir' follows its status, re-read whenever the screen is shown.
  const awaiting = status !== null && status.pending === true
  const [codeAck, setCodeAck] = useState(false)
  const [copyNote, setCopyNote] = useState('')
  const [, setHeldTick] = useState(0)
  const activeRef = useRef(active)
  activeRef.current = active
  const memberRef = useRef(member)
  memberRef.current = member

  useEffect(() => {
    const fn = () => setHeldTick((n) => n + 1)
    heldListeners.add(fn)
    return () => { heldListeners.delete(fn) }
  }, [])
  const held = unregistered !== null && unregistered.member === member ? unregistered : null
  const bindPending = pendingBind !== null && pendingBind.member === member ? pendingBind : null
  const myCode = heldCode !== null && member !== null && heldCode.member === member ? heldCode : null
  const shownCode = active && myCode !== null && myCode.settled ? myCode.code : null
  // null, or { lookupId } while the shown code's registration is unknown.
  const codeUnknown = shownCode !== null && myCode.unknown ? { lookupId: myCode.lookupId } : null
  // A put still in flight from an earlier visit: a second code now would
  // race it.
  const codeInFlight = myCode !== null && !myCode.settled
  const codeDoubt = uncertainCode !== null && uncertainCode.member === member ? uncertainCode : null

  // The tick resets once this screen is not the one shown, or the unlocked
  // member changes; the held code itself waits for 'pronto'.
  useEffect(() => {
    if (member === null) return
    if (pendingBind !== null && pendingBind.member !== member) setPendingBind(null)
    if (codeRegisteredFor !== null && codeRegisteredFor !== member) codeRegisteredFor = null
    if (uncertainCode !== null && uncertainCode.member !== member) setUncertainCode(null)
  }, [member])

  useEffect(() => {
    if (active && member !== null) return
    setCodeAck(false)
    setCopyNote('')
    setConfirmChange(false)
    setConfirmNewCode(false)
    setConfirmRemove(null)
  }, [active, member])

  const seq = useRef(0)
  const load = useCallback(async () => {
    const who = memberRef.current
    if (who === null) return null
    const mine = ++seq.current
    setListError('')
    try {
      const list = await listEntries({ request: node.request, account: ACCOUNT, member: who })
      if (mine !== seq.current || memberRef.current !== who) return null
      // A held passkey that is listed was registered after all (an unknown
      // outcome that did apply): nothing is put again.
      if (unregistered !== null && unregistered.member === who && unregistered.change !== true && list.some((e) => e.lookupId === unregistered.lookupId)) releaseUnregistered()
      if (codeRegisteredFor === who && !list.some((e) => e.kind === 'code')) codeRegisteredFor = null
      setEntries(list)
      return list
    } catch (err) {
      if (mine === seq.current) setListError(errorText(err))
      return null
    }
  }, [node.request])

  useEffect(() => {
    setEntries(null)
    if (!active || member === null) return
    load()
  }, [active, member, load])

  const passkeyRef = useRef(passkey)
  passkeyRef.current = passkey
  useEffect(() => {
    const pk = passkeyRef.current
    if (!active || !pk || typeof pk.refresh !== 'function') return
    Promise.resolve(pk.refresh()).catch(() => {})
  }, [active])

  const begin = () => {
    if (busyRef.current || memberRef.current === null) return false
    busyRef.current = true
    setBusy(true)
    setNote('')
    setError('')
    setCopyNote('')
    return true
  }
  const end = () => {
    busyRef.current = false
    setBusy(false)
  }

  const bind = async (entry) => {
    try {
      await passkey.bindPasskey({ credentialId: entry.credentialId, userId: entry.userId })
      if (pendingBind !== null && pendingBind.credentialId === entry.credentialId) setPendingBind(null)
      setNote(CHANGED_TEXT)
    } catch (err) {
      setPendingBind({ member: entry.member, credentialId: entry.credentialId, userId: entry.userId })
      setError(errorText(err))
    }
  }

  const register = async (entry) => {
    try {
      await registerEntry({ request: node.request, account: ACCOUNT, member: entry.member, kind: entry.kind, lookupId: entry.lookupId, blob: entry.blob })
    } catch (err) {
      holdUnregistered(entry)
      setFailure({ uncertain: err && err.uncertain === true })
      if (!(err && err.uncertain === true)) setError(errorText(err))
      return
    }
    releaseUnregistered()
    setFailure(null)
    if (entry.change === true) await bind(entry)
    else setNote(ADDED_TEXT)
    await load()
  }

  const afterCreate = (pending, change) => {
    const who = memberRef.current
    Promise.resolve(pending).then(async (r) => {
      if (r && r.pending === true) {
        pendingAdd = { member: who, change }
        return
      }
      pendingAdd = null
      if (!createdEntry(r)) {
        const err = new Error(CREATE_FAILED)
        if (r && typeof r.credentialId === 'string') err.credentialId = r.credentialId
        throw err
      }
      await register({ member: who, kind: 'passkey', lookupId: r.lookupId, blob: r.blob, credentialId: r.credentialId, userId: r.userId, change })
    }).catch((err) => {
      setError(errorText(err))
      // The manager already stores it: the person must know it opens
      // nothing and can be deleted there. created false: the authenticator
      // returned a passkey this request did not make; cleaned: the handle
      // already asked the manager to drop it.
      if (err && typeof err.credentialId === 'string' && err.created !== false && err.cleaned !== true) setNote(CREATED_LEFT_TEXT)
    }).finally(end)
  }

  // WebAuthn inside the press: addPasskey is the first call, nothing awaited.
  const onAdd = (change = false) => {
    if (!begin()) return
    let pending
    try { pending = passkey.addPasskey() } catch (err) { pending = Promise.reject(err) }
    setConfirmChange(false)
    setFailure(null)
    afterCreate(pending, change === true)
  }

  const onComplete = () => {
    if (!awaiting || !begin()) return
    const change = pendingAdd !== null && pendingAdd.member === memberRef.current && pendingAdd.change === true
    let pending
    try { pending = passkey.complete() } catch (err) { pending = Promise.reject(err) }
    afterCreate(pending, change)
  }

  const onRetry = () => {
    if (held === null || !begin()) return
    register(held).finally(end)
  }

  const onBind = () => {
    if (bindPending === null || !begin()) return
    bind(bindPending).finally(end)
  }

  // 'conferir': re-reads the list after an unknown outcome. A held passkey
  // that is listed was registered after all. A code whose put had an unknown
  // outcome is answered by its lookup id: listed, the noted code works;
  // absent, it opens nothing, even if its text already left the screen.
  const onCheck = () => {
    if (!begin()) return
    const entry = held
    const doubt = codeDoubt
    load().then(async (list) => {
      if (list === null) return
      setFailure(null)
      if (doubt !== null && uncertainCode === doubt) {
        setUncertainCode(null)
        if (!list.some((e) => e.kind === 'code' && e.lookupId === doubt.lookupId)) setError(CODE_NOTED_NOT_SAVED_TEXT)
      }
      if (entry !== null) {
        if (list.some((e) => e.lookupId === entry.lookupId)) {
          releaseUnregistered()
          if (entry.change === true) await bind(entry)
          else setNote(ADDED_TEXT)
        } else {
          setFailure({ uncertain: false })
        }
      }
    }).finally(end)
  }

  const onRemove = (e) => {
    if (!begin()) return
    setConfirmRemove(null)
    removeEntry({ request: node.request, account: ACCOUNT, member: memberRef.current, kind: e.kind, lookupId: e.lookupId }).then(
      () => load(),
      (err) => {
        if (err && err.uncertain === true) setFailure({ uncertain: true })
        else setError(errorText(err))
      }
    ).finally(end)
  }

  const hasCode = (entries !== null && entries.some((e) => e.kind === 'code')) || codeRegisteredFor === member
  const onCode = () => {
    if (codeInFlight) return
    if (hasCode && !confirmNewCode) return setConfirmNewCode(true)
    if (!begin()) return
    setConfirmNewCode(false)
    setFailure(null)
    const who = memberRef.current
    ;(async () => {
      const r = await passkey.makeRecoveryCode()
      if (!r || typeof r.code !== 'string' || !createdEntry(r)) throw new Error(CODE_FAILED)
      const mine = { member: who, code: r.code, lookupId: r.lookupId, settled: false, unknown: false }
      setHeldCode(mine)
      let unknown = false
      try {
        await registerEntry({ request: node.request, account: ACCOUNT, member: who, kind: 'code', lookupId: r.lookupId, blob: r.blob })
      } catch (err) {
        // A refused code opens nothing: it is dropped, never held. An unknown
        // outcome may have registered it, so it stays shown with 'conferir'.
        if (!(err && err.uncertain === true)) {
          if (heldCode === mine) setHeldCode(null)
          throw err
        }
        unknown = true
        setUncertainCode({ member: who, lookupId: r.lookupId })
        setFailure({ uncertain: true })
      }
      if (!unknown) {
        codeRegisteredFor = who
        // A newer code was registered: the doubtful one is buried either way.
        if (uncertainCode !== null && uncertainCode.member === who) setUncertainCode(null)
      }
      if (heldCode === mine) setHeldCode({ ...mine, settled: true, unknown })
      setCodeAck(false)
      if (!unknown && activeRef.current && memberRef.current === who) await load()
    })().catch((err) => setError(errorText(err))).finally(end)
  }

  // With an unknown outcome the failure stays, so the list's 'conferir' is
  // still offered after the person noted the code.
  const onCodeDone = () => {
    if (!codeAck || myCode === null) return
    setHeldCode(null)
    setCodeAck(false)
    setCopyNote('')
  }

  // 'conferir' on the shown code: only a listed code entry with this attempt's
  // lookup id clears the doubt; a list without it means the code opens
  // nothing, so it leaves the screen with a fixed sentence.
  const onCheckCode = () => {
    const unknown = codeUnknown
    if (unknown === null || !begin()) return
    load().then((list) => {
      if (list === null) return
      setFailure(null)
      if (uncertainCode !== null && uncertainCode.lookupId === unknown.lookupId) setUncertainCode(null)
      const same = heldCode !== null && heldCode.lookupId === unknown.lookupId
      if (list.some((e) => e.kind === 'code' && e.lookupId === unknown.lookupId)) {
        if (same) setHeldCode({ ...heldCode, unknown: false })
        return
      }
      if (same) setHeldCode(null)
      setCodeAck(false)
      setCopyNote('')
      setError(CODE_NOT_SAVED_TEXT)
    }).finally(end)
  }

  const onCopy = async () => {
    const code = shownCode
    if (code === null) return
    const ok = await copyText(shareNav(), code)
    setCopyNote(ok ? 'Código copiado.' : 'Não foi possível copiar.')
  }

  const title = embedded ? null : <Title>Passkeys e recuperação</Title>
  if (member === null) {
    return (
      <Page>
        {title}
        <Soft>Entre com a passkey para ver esta tela.</Soft>
      </Page>
    )
  }

  if (shownCode !== null) {
    return (
      <Page>
        {title}
        <Card>
          <Label>Código de recuperação</Label>
          <Mono>{shownCode}</Mono>
          <Btn label='Copiar o código' secondary onPress={onCopy} />
          {copyNote ? <Soft>{copyNote}</Soft> : null}
          <Notice>{CODE_ONCE_TEXT}</Notice>
          {codeUnknown !== null
            ? (
              <>
                <Notice>{UNCERTAIN}</Notice>
                <Notice>{CODE_UNKNOWN_TEXT}</Notice>
                <Btn label='Conferir' secondary onPress={onCheckCode} pending={busy} />
                <ErrorText>{listError}</ErrorText>
              </>
              )
            : null}
          <Check checked={codeAck} label={CODE_ACK_LABEL} onPress={() => setCodeAck((v) => !v)} />
          <Btn label='Pronto' onPress={onCodeDone} disabled={!codeAck} />
        </Card>
      </Page>
    )
  }

  return (
    <Page>
      {title}
      <Body>{INTRO_TEXT}</Body>
      <Soft>{LOSS_TEXT}</Soft>
      <Card>
        {entries === null && !listError ? <Soft>carregando…</Soft> : null}
        <ErrorText>{listError}</ErrorText>
        {listError ? <Btn label='Tentar de novo' secondary onPress={() => load()} disabled={busy} block /> : null}
        {entries !== null && entries.length === 0 ? <Soft>{EMPTY_TEXT}</Soft> : null}
        {(entries || []).map((e) => (
          <View key={e.lookupId} style={styles.entry}>
            <View style={styles.entryText}>
              <Body>{e.kind === 'code' ? 'Código de recuperação' : 'Passkey'}</Body>
              <Soft>{'cadastrado em ' + dateText(e.createdAt)}</Soft>
            </View>
            {confirmRemove === e.lookupId
              ? null
              : <Btn label='Remover' secondary onPress={() => setConfirmRemove(e.lookupId)} disabled={busy} />}
            {confirmRemove === e.lookupId
              ? (
                <View style={styles.confirm}>
                  <Soft>{e.kind === 'code' ? REMOVE_CODE_TEXT : REMOVE_PASSKEY_TEXT}</Soft>
                  <ConfirmStack
                    confirm={<Btn label='Remover' danger onPress={() => onRemove(e)} pending={busy} />}
                    cancel={<Btn label='Cancelar' secondary onPress={() => setConfirmRemove(null)} disabled={busy} />}
                  />
                </View>
                )
              : null}
          </View>
        ))}
        <Soft>{LIST_NOTE}</Soft>
      </Card>

      {(failure !== null && failure.uncertain) || codeDoubt !== null
        ? (
          <>
            <Notice>{UNCERTAIN}</Notice>
            <Btn label='Conferir' secondary onPress={onCheck} pending={busy} block />
          </>
          )
        : null}
      {held !== null && !(failure !== null && failure.uncertain)
        ? (
          <>
            <Notice>{NOT_REGISTERED_TEXT}</Notice>
            <Btn label='Registrar de novo' onPress={onRetry} pending={busy} block />
          </>
          )
        : null}
      {bindPending !== null
        ? (
          <>
            <Notice>{BIND_FAILED_TEXT}</Notice>
            <Btn label='Usar a passkey nova' onPress={onBind} pending={busy} block />
            <Soft>Este aparelho passará a usar a passkey nova.</Soft>
          </>
          )
        : null}
      {awaiting
        ? (
          <>
            <Body>{PENDING_TEXT}</Body>
            <Btn label='Concluir a criação da passkey' onPress={onComplete} pending={busy} block />
          </>
          )
        : null}

      {/* While the change confirmation is open, its own button adds the passkey. */}
      {confirmChange ? null : <Btn label='Adicionar passkey' onPress={() => onAdd(false)} disabled={busy || held !== null} block />}
      {confirmChange
        ? (
          <Card>
            <Notice>{CHANGE_TEXT}</Notice>
            <ConfirmStack
              confirm={<Btn label='Adicionar a nova passkey' onPress={() => onAdd(true)} disabled={busy} />}
              cancel={<Btn label='Cancelar' secondary onPress={() => setConfirmChange(false)} disabled={busy} />}
            />
          </Card>
          )
        : <Btn label='Trocar passkey' secondary onPress={() => setConfirmChange(true)} disabled={busy || held !== null} block />}
      {confirmNewCode
        ? (
          <Card>
            <Notice>{NEW_CODE_TEXT}</Notice>
            <ConfirmStack
              confirm={<Btn label='Criar código novo' onPress={onCode} disabled={busy} />}
              cancel={<Btn label='Cancelar' secondary onPress={() => setConfirmNewCode(false)} disabled={busy} />}
            />
          </Card>
          )
        : <Btn label='Criar código de recuperação' secondary onPress={onCode} disabled={busy || entries === null || codeInFlight} block />}
      <ErrorText>{error}</ErrorText>
      <Notice>{note}</Notice>
    </Page>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  entry: { gap: 6, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  entryText: { gap: 2 },
  confirm: { gap: 8 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkLabel: { fontSize: 16, color: colors.ink }
})
