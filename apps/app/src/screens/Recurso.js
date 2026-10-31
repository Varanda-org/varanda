// Recorrer de um bloqueio (Ajustes): a blocked member asks the association's
// moderation to review the block. Only the hosted browser node can sign the
// statement (RPC appeal.sign, docs/rpc.md 5.57), and only a member whose
// Google account is linked may appeal (the account service refuses
// 'nao-vinculado'); a key that is not blocked is refused too
// ('nao-bloqueado').
// Flow: /account/status -> /account/appeal/start (nonce) -> appeal.sign ->
// /account/appeal. Nothing is stored: no localStorage, no diary write.

import { useEffect, useRef, useState } from 'react'
import { accountStatus } from '../account'
import { NOT_LINKED_MESSAGE, TEXT_MAX, appealSend, appealStart, validateAppealText, wellFormed } from '../appeal'
import { countChars } from '../format'
import { useNode } from '../node'
import { Btn, ErrorText, Field, Notice, Page, Soft, errorText, useAction } from '../ui'

const NOT_HOSTED_MESSAGE = 'Nesta versão, recursos só pela versão web no site da associação.'
const EXPLAIN = 'Se sua conta foi bloqueada pela moderação, você pode pedir uma revisão. Outra pessoa da equipe, que não decidiu o bloqueio, lê o seu pedido. Se o pedido for negado, só dá para recorrer de novo em 30 dias.'
const PRIVACY = 'O recurso é assinado com a chave do seu diário e fica só com a moderação. Não vai para o diário nem para outras pessoas.'

export default function Recurso ({ open, active }) {
  const node = useNode()
  const hosted = node.hosted === true && node.passkey !== null
  const member = hosted && node.passkey.status ? node.passkey.status.publicKey : null
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [text, setText] = useState('')
  const [sent, setSent] = useState('')
  const send = useAction()
  const seqRef = useRef(0)

  // Every opening starts a fresh form and a fresh status read.
  useEffect(() => {
    setText('')
    setSent('')
    setStatus(null)
    setStatusError('')
    send.clearError()
    const mine = ++seqRef.current
    if (!open || !active || !hosted || typeof member !== 'string') return
    accountStatus(member).then((s) => {
      if (mine === seqRef.current) setStatus(s)
    }, (err) => {
      if (mine === seqRef.current) setStatusError(errorText(err))
    })
  }, [open, active, hosted, member])

  // The exact text that is signed and sent (lone surrogates normalized).
  const words = validateAppealText(wellFormed(text))

  const submit = async () => {
    if (words === null || typeof member !== 'string') return
    // A close, a lock or a new opening while this runs makes it stale.
    const mine = seqRef.current
    const r = await send.run(async () => {
      const { nonce } = await appealStart({ member })
      if (mine !== seqRef.current) return null
      const { signature } = await node.request('appeal.sign', { nonce, text: words })
      if (mine !== seqRef.current) return null
      return appealSend({ member, nonce, text: words, signature })
    })
    if (r.ok && r.value !== null && mine === seqRef.current) {
      setSent(r.value.duplicate ? 'você já tinha um recurso aberto' : 'recurso enviado')
      setText('')
    }
  }

  let body
  if (!hosted) {
    body = <Soft>{NOT_HOSTED_MESSAGE}</Soft>
  } else if (statusError) {
    body = <ErrorText>{statusError}</ErrorText>
  } else if (status === null) {
    body = <Soft>carregando…</Soft>
  } else if (status.linked !== true) {
    body = <Soft>{NOT_LINKED_MESSAGE}</Soft>
  } else {
    body = (
      <>
        <Soft>{EXPLAIN}</Soft>
        <Field label='o que você quer dizer à moderação (opcional)' value={text} onChangeText={setText} multiline maxLength={TEXT_MAX * 2} />
        {/* maxLength counts UTF-16 units and the limit is in characters
            (code points), so the input only caps at two units per character;
            the counter and validateAppealText enforce TEXT_MAX. */}
        <Soft>{String(countChars(text)) + '/' + String(TEXT_MAX)}</Soft>
        <Soft>{PRIVACY}</Soft>
        <ErrorText>{send.error}</ErrorText>
        <Notice>{sent}</Notice>
        <Btn label='enviar recurso' onPress={submit} pending={send.pending} disabled={words === null || sent !== ''} />
      </>
    )
  }

  return <Page>{body}</Page>
}
