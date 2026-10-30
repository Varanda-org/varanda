// Convidar pessoas (Ajustes): the weekly allowance (from the public policy)
// and a button that creates one link. How many are left is only known from
// the signed create answer: the status route never says, since member keys
// are public. Creating is a state change: one tap runs
// start, the node's signature and one finish, and nothing is ever resent. The
// link lives only in this component's state while the screen is open; it is
// never stored, and the service cannot show it again.

import { useCallback, useEffect, useRef, useState } from 'react'
import { accountStatus, invitesFinish, invitesStart } from '../account'
import { HELP } from '../help'
import { useNode } from '../node'
import { INVITE_VALID_TEXT, WEEK_RESET_TEXT, allowanceText, buildSignupInviteUrl, inviteCountText } from '../signupInvite'
import { Body, Btn, ErrorText, Page, Soft, errorText } from '../ui'
import { HelpNote } from '../ui/Help'
import { ShareProfile } from '../ui/ShareProfile'

const NOT_LINKED_TEXT = 'Vincule sua conta Google em Conta e @nome para poder convidar.'
const UNAVAILABLE_TEXT = 'serviço indisponível'
const COPY_NOW_TEXT = 'Copie o link agora: ele só aparece nesta tela.'
const MAYBE_CREATED_TEXT = 'Se o convite foi criado, ele já conta nesta semana.'
const LABELS = Object.freeze({
  field: 'link do convite',
  copy: 'copiar link do convite',
  copyLabel: 'copiar link do convite',
  share: 'compartilhar convite',
  shareLabel: 'compartilhar convite'
})

// open: the screen is showing (its lifetime, for the link); active: open and
// the node ready (for reads). perWeek: the policy's weekly allowance, read by
// Ajustes. keyFailed: Ajustes could not read the own key; onRetryKey asks it
// again.
export default function Convites ({ open, active, ownKey, perWeek, keyFailed = false, onRetryKey }) {
  const node = useNode()
  // { key, linked } of the last status read for this key.
  const [state, setState] = useState(null)
  // { key, used, remaining } from the last create answer in this opening.
  const [count, setCount] = useState(null)
  const [limitHit, setLimitHit] = useState(false)
  const [readError, setReadError] = useState('')
  const [url, setUrl] = useState(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const seqRef = useRef(0)

  const read = useCallback(async () => {
    if (typeof ownKey !== 'string') return
    const mine = ++seqRef.current
    try {
      const status = await accountStatus(ownKey)
      if (mine !== seqRef.current) return
      setState({ key: ownKey, linked: status.linked === true })
      setReadError('')
    } catch (err) {
      if (mine === seqRef.current) setReadError(errorText(err))
    }
  }, [ownKey])

  useEffect(() => { if (active) read() }, [active, read])

  // Leaving the screen forgets the link: it is shown once, here. A node
  // reconnecting while the screen stays open must not lose it.
  const openRef = useRef(open)
  useEffect(() => () => { openRef.current = false }, [])
  useEffect(() => {
    openRef.current = open
    if (open) return
    setUrl(null)
    setNote('')
    setError('')
    setCount(null)
    setLimitHit(false)
  }, [open])

  const create = async () => {
    if (busyRef.current || typeof ownKey !== 'string') return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNote('')
    let finishing = false
    try {
      // A screen closed mid-way stops before the next step, so no invite is
      // spent on a link nobody will see.
      const { nonce } = await invitesStart({ member: ownKey })
      if (!openRef.current) return
      const { signature } = await node.request('invite.sign', { action: 'issue', nonce })
      if (!openRef.current) return
      // Once finish is sent the service decides; closing now cannot undo it.
      finishing = true
      const done = await invitesFinish({ member: ownKey, nonce, signature })
      const link = buildSignupInviteUrl({ origin: globalThis.location?.origin, code: done.code })
      // The previous link (still valid, already counted) stays until a new
      // one replaces it.
      if (link === null) setError(UNAVAILABLE_TEXT)
      else setUrl(link)
      setCount({ key: ownKey, used: done.used, remaining: done.remaining })
    } catch (err) {
      const code = err && err.code
      // A finish whose answer was lost may still have spent an invite: say
      // so. Never issue again on our own.
      if (finishing && (code === 'indisponivel' || code === undefined)) {
        setNote(MAYBE_CREATED_TEXT)
      } else {
        setError(errorText(err))
        if (code === 'limite-convites') setLimitHit(true)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const retryKey = () => { if (typeof onRetryKey === 'function') onRetryKey() }
  const cur = state !== null && state.key === ownKey ? state : null
  const noKey = typeof ownKey !== 'string'
  let body
  if (noKey) {
    body = keyFailed || !active
      ? (
        <>
          <Body>{UNAVAILABLE_TEXT}</Body>
          <Btn label='tentar de novo' secondary onPress={retryKey} />
        </>
        )
      : <Soft>carregando…</Soft>
  } else if (cur === null) {
    body = readError ? null : <Soft>carregando…</Soft>
  } else if (!cur.linked) {
    body = <Body>{NOT_LINKED_TEXT}</Body>
  } else if (allowanceText(perWeek) === '') {
    body = <Body>{UNAVAILABLE_TEXT}</Body>
  } else {
    const last = count !== null && count.key === ownKey ? count : null
    const text = last === null ? allowanceText(perWeek) : inviteCountText({ remaining: last.remaining, perWeek })
    body = (
      <>
        {text ? <Body>{text}</Body> : null}
        <HelpNote doc={HELP.convites}><Soft>{WEEK_RESET_TEXT}</Soft></HelpNote>
        <Btn label='Criar link de convite' onPress={create} pending={busy} disabled={busy || limitHit || (last !== null && last.remaining === 0)} />
      </>
    )
  }

  return (
    <Page>
      {body}
      {url !== null
        ? (
          <>
            <ShareProfile key={url} url={url} labels={LABELS} showUrl />
            <Soft>{INVITE_VALID_TEXT}</Soft>
            <Body>{COPY_NOW_TEXT}</Body>
          </>
          )
        : null}
      {note ? <Soft>{note}</Soft> : null}
      <ErrorText>{(noKey ? '' : readError) || error}</ErrorText>
      {readError && !noKey ? <Btn label='tentar de novo' secondary onPress={read} /> : null}
    </Page>
  )
}
