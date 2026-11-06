// Excluir conta (Ajustes > Excluir conta), the notice for a key the account
// service already deleted, and the receipt shown at Entrar after the device
// was wiped. One code for Android, iOS and the web: the behaviour comes from
// the node (hosted, unlocked) and the account service, never from
// Platform.OS. The request sequence and texts are in src/accountDeletion.js.
//
// The screen asks the account service for a nonce and the current @nome when
// it opens (a member who still owns a live page learns it here), then the
// person types the @nome and taps Excluir conta: the fresh passkey check
// (node.passkey.confirm) runs first, inside the tap; push is switched off
// while the key can still sign; account.sign signs the 'delete' statement;
// the service deletes. Only then the device keeps the receipt (public key
// and date) and is wiped as Recomeçar does.

import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { useNode } from '../node'
import { useOutbox } from '../outboxProvider'
import { usePush } from '../usePush'
import { accountStatus, deleteFinish, deleteStart, formatNextChange } from '../account'
import { DELETE_DAYS, DELETED_TEXT, DONE_TEXT, PASSKEY_TEXT, PENDING_TEXT, deletedOf, newReceipt, requestDeletion, typedMatches } from '../accountDeletion'
import { clearDeletionReceipt, loadDeletionReceipt, saveDeletionReceipt } from '../deletionReceiptStore'
import { Body, Btn, ErrorText, Field, Page, Row, Soft, errorText, useAction } from '../ui'

const WHAT_GOES = 'Excluir a conta apaga, no serviço de conta da associação, o vínculo com o Google, o registro de idade, os aceites dos Termos, os avisos no aparelho, as marcações de visto, os convites, as passkeys extras e o código de recuperação. O seu @nome fica reservado e nunca vai para outra pessoa.'
const DIARY = 'O diário (publicações, perfil, fotos, quem você segue, curtidas e republicações) sai dos semeadores da associação em até ' + DELETE_DAYS + ' dias. Apps e semeadores modificados, cópias que outras pessoas já baixaram, mensagens já entregues e capturas de tela podem manter o conteúdo.'
const GROUPS = 'As comunidades e os grupos que você criou deixam de existir para todos os participantes.'
const KEPT = 'Ficam guardadas as denúncias feitas por você ou contra você e as decisões dos moderadores, para moderação e pedidos legais.'
const DEVICE = 'Neste aparelho, a conta e os dados são apagados logo depois do pedido. Não dá para desfazer.'
const PAGES_TEXT = 'Você ainda é dono de uma página. Encerre ou transfira suas páginas antes de excluir a conta.'

// Ajustes > Excluir conta. `active`: the sub-screen is on screen and the node
// is ready; `member`: the unlocked key; onDone closes the sheet.
export default function ExcluirConta ({ active, member, onOpenPaginas, onTermsReset, onDone }) {
  const node = useNode()
  const outbox = useOutbox()
  const pushStore = usePush()
  const [prepared, setPrepared] = useState(null)
  const [problem, setProblem] = useState(null) // null | { code, text }
  const [loading, setLoading] = useState(false)
  const [typed, setTyped] = useState('')
  const [wipeFailed, setWipeFailed] = useState(false)
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
      try {
        await requestDeletion({
          prepared,
          typed,
          confirm: () => node.passkey.confirm(),
          sign: ({ nonce, username }) => node.request('account.sign', { phase: 'delete', nonce, username, sub: '' }),
          finish: ({ nonce, signature }) => deleteFinish({ member, nonce, signature }),
          status: () => accountStatus(member),
          beforeFinish: () => pushStore.turnOffPush({ node, member })
        })
      } catch (err) {
        // A spent or expired nonce: the next tap gets a new one.
        if (err && (err.code === 'expirado' || err.code === 'assinatura-invalida')) prepare()
        throw err
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

  if (problem !== null && problem.code === 'paginas-ativas') {
    return (
      <Page>
        <Body>{PAGES_TEXT}</Body>
        {typeof onOpenPaginas === 'function' ? <Btn label='Abrir Páginas' onPress={onOpenPaginas} /> : null}
      </Page>
    )
  }

  const username = prepared !== null ? prepared.username : null
  const matches = username !== null && typedMatches(typed, username)
  return (
    <Page>
      <Body>{WHAT_GOES}</Body>
      <Soft>{DIARY}</Soft>
      <Soft>{GROUPS}</Soft>
      <Soft>{KEPT}</Soft>
      <Soft>{DEVICE}</Soft>
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
              <Btn label='Excluir conta' danger onPress={submit} disabled={!matches} pending={action.pending} />
            </Row>
          </>
          )
        : null}
      <ErrorText>{action.error}</ErrorText>
    </Page>
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
