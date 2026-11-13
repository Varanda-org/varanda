// Excluir conta (Ajustes > Excluir conta), the notice for a key the account
// service already deleted, and the receipt shown at Entrar after the device
// was wiped. One code for Android, iOS and the web: the behaviour comes from
// the node (hosted, unlocked) and the account service, never from
// Platform.OS. The request sequence and texts are in src/accountDeletion.js.
//
// The screen asks the account service for a nonce, the current @nome and
// the passkeys it holds when it opens (a member who still owns a live page
// learns it here), then the person types the @nome and taps Excluir conta:
// the fresh passkey check (node.passkey.confirm, over the nonce) runs first,
// inside the tap; account.sign signs the 'delete' statement. With a passkey
// the service holds, push is switched off while the key can still sign, the
// service verifies the assertion and deletes, and only then the device keeps
// the receipt (public key and date) and is wiped as Recomeçar does. Without
// one (an account from before that registration, or another passkey) the
// deletion is scheduled WAIT_DAYS ahead: nothing is wiped, every device shows
// the date (CancelarExclusao) and any of them can cancel.

import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { useNode } from '../node'
import { useOutbox } from '../outboxProvider'
import { usePush } from '../usePush'
import { accountStatus, deleteCancelFinish, deleteCancelStart, deleteFinish, deleteStart, formatNextChange } from '../account'
import { DELETE_DAYS, DELETED_TEXT, DONE_TEXT, PASSKEY_TEXT, PENDING_TEXT, WAIT_TEXT, cancelDeletion, deletedOf, deletionMode, newReceipt, requestDeletion, scheduledText, typedMatches } from '../accountDeletion'
import { clearDeletionReceipt, loadDeletionReceipt, saveDeletionReceipt } from '../deletionReceiptStore'
import { Body, Btn, ErrorText, Field, Page, Row, Soft, errorText, useAction } from '../ui'

const WHAT_GOES = 'Excluir a conta apaga, no serviço de conta da associação, o vínculo com a conta Google, se houver, o registro de idade, os aceites dos Termos, os avisos no aparelho, as marcações de visto, os convites, as passkeys extras e o código de recuperação. O número do celular, se houver, fica lacrado por até 180 dias e então é apagado. O seu @nome fica reservado e nunca vai para outra pessoa.'
const DIARY = 'O diário (publicações, perfil, fotos, quem você segue, curtidas e republicações) sai dos semeadores da associação em até ' + DELETE_DAYS + ' dias. Apps e semeadores modificados, cópias que outras pessoas já baixaram, mensagens já entregues e capturas de tela podem manter o conteúdo.'
const GROUPS = 'As comunidades e os grupos que você criou deixam de existir para todos os participantes.'
const KEPT = 'Ficam guardadas as denúncias feitas por você ou contra você e as decisões dos moderadores, para moderação e pedidos legais.'
const DEVICE = 'Neste aparelho, a conta e os dados são apagados logo depois do pedido. Não dá para desfazer.'
const PAGES_TEXT = 'Você ainda é dono de uma página. Encerre ou transfira suas páginas antes de excluir a conta.'
// Without Páginas on screen (the phone check holds the app), the way forward.
const PAGES_LATER = 'Confirme o seu celular primeiro. Depois, encerre ou transfira a página em Páginas.'

// Ajustes > Excluir conta. `active`: the sub-screen is on screen and the node
// is ready; `member`: the unlocked key; onDone closes the sheet.
// `scheduledDeletion`: the date the shell read from /account/status, so the
// cancel stays reachable even when start refuses (a page owned meanwhile).
export default function ExcluirConta ({ active, member, onOpenPaginas, onTermsReset, scheduledDeletion = null, onDeletionChanged, onDone }) {
  const node = useNode()
  const outbox = useOutbox()
  const pushStore = usePush()
  const [prepared, setPrepared] = useState(null)
  const [problem, setProblem] = useState(null) // null | { code, text }
  const [loading, setLoading] = useState(false)
  const [typed, setTyped] = useState('')
  const [wipeFailed, setWipeFailed] = useState(false)
  // The date of a deletion this screen just scheduled.
  const [scheduled, setScheduled] = useState(null)
  const action = useAction()
  const turn = useRef(0)

  const prepare = useCallback(() => {
    if (typeof member !== 'string') return
    const mine = ++turn.current
    setLoading(true)
    setProblem(null)
    deleteStart({ member }).then((p) => {
      if (mine !== turn.current) return
      setPrepared(p)
      setLoading(false)
    }, (err) => {
      if (mine !== turn.current) return
      setPrepared(null)
      setProblem({ code: err && err.code, text: errorText(err) })
      setLoading(false)
    })
  }, [member])

  // A fresh nonce every time the screen opens; leaving forgets the typed name.
  useEffect(() => {
    if (!active) {
      ++turn.current
      setTyped('')
      setPrepared(null)
      setScheduled(null)
      setProblem(null)
      action.clearError()
      return
    }
    prepare()
  }, [active, prepare])

  const wipe = useCallback(async () => {
    if (!outbox.forgetAuthor(member)) throw new Error('não foi possível apagar as publicações que aguardam envio neste aparelho')
    await node.passkey.reset()
    if (typeof onTermsReset === 'function') onTermsReset(member)
  }, [member, node.passkey, outbox, onTermsReset])

  const submit = () => {
    setWipeFailed(false)
    action.run(async () => {
      let result
      try {
        result = await requestDeletion({
          prepared,
          typed,
          confirm: (args) => node.passkey.confirm(args),
          sign: ({ nonce, username }) => node.request('account.sign', { phase: 'delete', nonce, username, sub: '' }),
          finish: (args) => deleteFinish({ member, ...args }),
          status: () => accountStatus(member),
          beforeFinish: () => pushStore.turnOffPush({ node, member })
        })
      } catch (err) {
        // A spent or expired nonce: the next tap gets a new one.
        if (err && (err.code === 'expirado' || err.code === 'assinatura-invalida' || err.code === 'passkey-invalida')) prepare()
        throw err
      }
      if (result && typeof result.scheduled === 'string') {
        setTyped('')
        setScheduled(result.scheduled)
        if (typeof onDeletionChanged === 'function') onDeletionChanged()
        return
      }
      await saveDeletionReceipt(newReceipt(member, Date.now()))
      try {
        await wipe()
      } catch (err) {
        setWipeFailed(true)
        throw err
      }
      onDone()
    })
  }

  const retryWipe = () => {
    action.run(async () => {
      await wipe()
      setWipeFailed(false)
      onDone()
    })
  }

  if (wipeFailed) {
    return (
      <Page>
        <Body>{DELETED_TEXT}</Body>
        <Soft>Não foi possível apagar os dados deste aparelho. Toque em Apagar deste aparelho para tentar de novo.</Soft>
        <Btn label='Apagar deste aparelho' danger onPress={retryWipe} pending={action.pending} />
        <ErrorText>{action.error}</ErrorText>
      </Page>
    )
  }

  const cancelled = () => {
    setScheduled(null)
    prepare()
    if (typeof onDeletionChanged === 'function') onDeletionChanged()
  }

  if (problem !== null && problem.code === 'paginas-ativas') {
    return (
      <Page>
        {scheduledDeletion !== null ? <CancelarExclusao member={member} scheduled={scheduledDeletion} onCancelled={cancelled} /> : null}
        <Body>{PAGES_TEXT}</Body>
        {typeof onOpenPaginas === 'function' ? <Btn label='Abrir Páginas' onPress={onOpenPaginas} /> : <Body>{PAGES_LATER}</Body>}
      </Page>
    )
  }

  const username = prepared !== null ? prepared.username : null
  const matches = username !== null && typedMatches(typed, username)
  const mode = deletionMode(prepared)
  const waiting = scheduled !== null ? scheduled : (prepared !== null ? prepared.scheduled : null)
  if (waiting !== null && mode === 'agendada') {
    return (
      <Page>
        <CancelarExclusao member={member} scheduled={waiting} onCancelled={cancelled} />
      </Page>
    )
  }
  return (
    <Page>
      {waiting !== null ? <CancelarExclusao member={member} scheduled={waiting} onCancelled={cancelled} /> : null}
      <Body>{WHAT_GOES}</Body>
      <Soft>{DIARY}</Soft>
      <Soft>{GROUPS}</Soft>
      <Soft>{KEPT}</Soft>
      {mode === 'agendada' ? <Soft>{WAIT_TEXT}</Soft> : <Soft>{DEVICE}</Soft>}
      <Soft>{PASSKEY_TEXT}</Soft>
      {loading ? <Soft>carregando…</Soft> : null}
      {problem !== null
        ? (
          <View>
            <ErrorText>{problem.text}</ErrorText>
            <Btn label='tentar de novo' secondary onPress={prepare} />
          </View>
          )
        : null}
      {username !== null
        ? (
          <>
            <Field label={'Para confirmar, digite @' + username} value={typed} onChangeText={setTyped} mono maxLength={24} placeholder={'@' + username} />
            <Soft>Depois, confirme com a sua passkey.</Soft>
            <Row>
              <Btn label={mode === 'agendada' ? 'Agendar exclusão' : 'Excluir conta'} danger onPress={submit} disabled={!matches} pending={action.pending} />
            </Row>
          </>
          )
        : null}
      <ErrorText>{action.error}</ErrorText>
    </Page>
  )
}

// A deletion waiting for its date (asked without a passkey the account
// service could verify): the date and the way to cancel it, on this screen
// and on every signed-in device (Ajustes). Cancelling needs the diary key's
// 'cancel' statement, nothing more: whoever holds the account may keep it.
export function CancelarExclusao ({ member, scheduled, onCancelled }) {
  const node = useNode()
  const action = useAction()
  const cancel = () => action.run(async () => {
    await cancelDeletion({
      start: () => deleteCancelStart({ member }),
      sign: ({ nonce, username }) => node.request('account.sign', { phase: 'cancel', nonce, username, sub: '' }),
      finish: ({ nonce, signature }) => deleteCancelFinish({ member, nonce, signature })
    })
    if (typeof onCancelled === 'function') onCancelled()
  })
  return (
    <View>
      <Body>{scheduledText(scheduled)}</Body>
      <Soft>Se não foi você que pediu, cancele agora.</Soft>
      <Row>
        <Btn label='Cancelar exclusão' onPress={cancel} pending={action.pending} />
      </Row>
      <ErrorText>{action.error}</ErrorText>
    </View>
  )
}

// The shell's notice for an unlocked key the account service deleted (this
// device asked and could not wipe, or another device did): nothing else
// renders until the person erases the account from this device.
export function ContaExcluida ({ state, onErase }) {
  const action = useAction()
  return (
    <Page>
      <Body>{DELETED_TEXT}</Body>
      <Soft>{state === 'concluida' ? DONE_TEXT : PENDING_TEXT}</Soft>
      <Soft>Apague a conta deste aparelho para continuar. Para usar o Varanda de novo, crie uma conta nova com outra passkey.</Soft>
      <Soft>{PASSKEY_TEXT}</Soft>
      <Btn label='Apagar deste aparelho' danger onPress={() => action.run(onErase)} pending={action.pending} />
      <ErrorText>{action.error}</ErrorText>
    </Page>
  )
}

// At Entrar, after a deletion on this device: when it was asked, whether the
// diary already left the network ('concluida' is shown once, then the
// receipt is forgotten), and how to delete the passkey.
export function ExclusaoRecibo () {
  const [receipt, setReceipt] = useState(null)
  const [state, setState] = useState(null)
  useEffect(() => {
    let alive = true
    loadDeletionReceipt().then((r) => {
      if (!alive || r === null) return
      setReceipt(r)
      accountStatus(r.member).then((s) => { if (alive) setState(deletedOf(s)) }, () => {})
    })
    return () => { alive = false }
  }, [])
  if (receipt === null) return null
  const dismiss = () => {
    clearDeletionReceipt()
    setReceipt(null)
  }
  return (
    <View>
      <Body>{'Conta excluída em ' + formatNextChange(receipt.at) + '.'}</Body>
      <Soft>{state === 'concluida' ? DONE_TEXT : PENDING_TEXT}</Soft>
      {state === 'concluida' ? null : <Soft>{PASSKEY_TEXT}</Soft>}
      {state === 'concluida' ? <Btn label='Entendi' secondary onPress={dismiss} /> : null}
    </View>
  )
}
