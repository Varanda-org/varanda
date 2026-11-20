// Convidar pessoas (Ajustes): the weekly allowance (from the public policy)
// and a button that creates one link. How many are left is a signed summary
// (the status route stays silent, member keys are public); a 404 keeps the
// policy sentence for an older service. Creating is a state change: one tap
// runs start, the node's signature and one finish, and nothing is ever resent.
// The link lives only in this component's state while the screen is open; it
// is never stored, and the service cannot show it again.

import { useCallback, useEffect, useRef, useState } from 'react'
import { buildInviteCardUrl } from '@varanda/rpc'
import { accountStatus, invitesFinish, invitesStart, invitesSummary } from '../account'
import { origin as inviteOrigin } from '../communityShare'
import { HELP } from '../help'
import { CARD_FAILED_TEXT, PROBLEM_TEXT, cardFields, cardRefusal, composeTransition, createLabel, initialCompose, problem } from '../inviteCardCompose'
import { useNode } from '../node'
import { DROPS_HINT_TEXT, INVITE_VALID_TEXT, WEEK_RESET_TEXT, allowanceText, buildSignupInviteUrl, dropView, inviteCountText } from '../signupInvite'
import { Body, Btn, ErrorText, Page, Soft, errorText } from '../ui'
import { HelpNote } from '../ui/Help'
import { InviteCardButton, InviteCardCompose } from '../ui/InviteCardCompose'
import { ShareProfile } from '../ui/ShareProfile'

const NOT_LINKED_TEXT = 'Termine o cadastro em Ajustes → Conta e @nome.'
const UNAVAILABLE_TEXT = 'serviço indisponível'
const COPY_NOW_TEXT = 'Copie o link agora: ele só aparece nesta tela.'
const MAYBE_CREATED_TEXT = 'Se o convite foi criado, ele já conta nesta semana.'
// A drop can arrive while this screen stays open. Web also refreshes from the
// push click; every hosted install has invite.sign, so the open screen polls.
const SUMMARY_REFRESH_MS = 15 * 60 * 1000
const LABELS = Object.freeze({
  field: 'link do convite',
  copy: 'Copiar link do convite',
  copyLabel: 'copiar link do convite',
  share: 'Compartilhar convite',
  shareLabel: 'compartilhar convite'
})

// open: the screen is showing (its lifetime, for the link); active: open and
// the node ready (for reads). perWeek: the policy's weekly allowance, read by
// Ajustes. keyFailed: Ajustes could not read the own key; onRetryKey asks it
// again. inviteNudge: bumped when a convite push opens this screen, including
// when it is already open.
export default function Convites ({ open, active, ownKey, perWeek, keyFailed = false, onRetryKey, inviteNudge = 0 }) {
  const node = useNode()
  const request = node.request
  const origin = inviteOrigin() || null
  const [draft, setDraft] = useState(initialCompose)
  const changeDraft = (event) => setDraft((current) => composeTransition(current, event))
  // { key, linked } of the last status read for this key.
  const [state, setState] = useState(null)
  // { key, used, remaining } from the last create answer in this opening.
  const [count, setCount] = useState(null)
  // { key, ...summary } of the last signed summary. null: 404 or none yet.
  const [summary, setSummary] = useState(null)
  const [limitHit, setLimitHit] = useState(false)
  // convite-aguardando holds the button only until the next summary read.
  const [awaitingDrop, setAwaitingDrop] = useState(false)
  const [readError, setReadError] = useState('')
  const [url, setUrl] = useState(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const seqRef = useRef(0)
  const readingRef = useRef(false)
  const errorCodeRef = useRef('')
  // Bumped when a create is told the drop has not arrived, so the summary
  // read already running does not lift that hold.
  const dropGen = useRef(0)
  const linkedRef = useRef(false)
  linkedRef.current = state !== null && state.key === ownKey && state.linked === true

  // One summary, guarded by the same seq as the status read. A 404 keeps the
  // allowance copy; any other failure leaves the last summary and must not
  // disable the button.
  const readSummary = useCallback(async (mine) => {
    const seen = dropGen.current
    let grant = false
    let settled = false
    try {
      const { nonce } = await invitesStart({ member: ownKey })
      if (mine !== seqRef.current) return
      const { signature } = await request('invite.sign', { action: 'summary', nonce })
      if (mine !== seqRef.current) return
      const answer = await invitesSummary({ member: ownKey, nonce, signature })
      if (mine !== seqRef.current) return
      if (answer === null) setSummary(null)
      else {
        setSummary({ key: ownKey, ...answer })
        grant = dropView(answer).enabled === true
      }
      settled = true
    } catch {
      if (mine !== seqRef.current) return
    }
    // A hold raised while this read was running stays, unless the answer
    // itself shows an invite that can be used. A failure lifts it too: the
    // button must not stay off because a read failed.
    if (mine !== seqRef.current || (dropGen.current !== seen && !grant)) return
    if (settled && errorCodeRef.current === 'convite-aguardando') {
      errorCodeRef.current = ''
      setError('')
    }
    setAwaitingDrop(false)
  }, [ownKey, request])

  const refreshSummary = useCallback(() => {
    if (typeof ownKey !== 'string') return Promise.resolve()
    const mine = ++seqRef.current
    readingRef.current = true
    return readSummary(mine).finally(() => {
      if (mine === seqRef.current) readingRef.current = false
    })
  }, [ownKey, readSummary])

  const read = useCallback(async () => {
    if (typeof ownKey !== 'string') return
    const mine = ++seqRef.current
    readingRef.current = true
    try {
      const status = await accountStatus(ownKey)
      if (mine !== seqRef.current) return
      const linked = status.linked === true
      if (linked) await readSummary(mine)
      if (mine !== seqRef.current) return
      setState({ key: ownKey, linked })
      setReadError('')
    } catch (err) {
      if (mine === seqRef.current) setReadError(errorText(err))
    } finally {
      if (mine === seqRef.current) readingRef.current = false
    }
  }, [ownKey, readSummary])

  // inviteNudge covers a push click that arrives while the screen is already open.
  useEffect(() => { if (active) read() }, [active, read, inviteNudge])

  useEffect(() => {
    if (!open || !active) return
    const timer = setInterval(() => {
      if (readingRef.current || busyRef.current || !linkedRef.current) return
      refreshSummary()
    }, SUMMARY_REFRESH_MS)
    return () => clearInterval(timer)
  }, [open, active, refreshSummary])

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
    errorCodeRef.current = ''
    setCount(null)
    setLimitHit(false)
    setAwaitingDrop(false)
    setDraft(initialCompose())
  }, [open])

  const create = async () => {
    if (busyRef.current || typeof ownKey !== 'string') return
    busyRef.current = true
    const card = cardFields(draft, origin)
    changeDraft({ type: 'create' })
    setBusy(true)
    setError('')
    errorCodeRef.current = ''
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
      const link = buildSignupInviteUrl({ origin, code: done.code })
      // The previous link (still valid, already counted) stays until a new
      // one replaces it.
      if (card !== null) {
        changeDraft({ type: 'sign' })
        try {
          const expires = Math.floor(Date.parse(done.expiresAt) / 1000)
          const { signature } = await node.request('inviteCard.sign', { code: done.code, ...card, expires })
          const cardUrl = buildInviteCardUrl({ origin, code: done.code, ...card, expires, member: ownKey, signature })
          if (cardUrl === null) throw new Error('invalid card link')
          setUrl(cardUrl)
          changeDraft({ type: 'card' })
        } catch {
          setUrl(link)
          setNote(CARD_FAILED_TEXT)
          changeDraft({ type: 'card-failed' })
        }
      } else {
        if (link === null) setError(UNAVAILABLE_TEXT)
        else setUrl(link)
        changeDraft({ type: 'plain' })
      }
      setCount({ key: ownKey, used: done.used, remaining: done.remaining })
      // If the refresh below fails, the shown summary still counts this link.
      // finish answers remaining = opened now - used, so opened follows from it
      // (another drop may have opened since the summary on screen).
      setSummary((s) => s !== null && s.key === ownKey
        ? { ...s, used: done.used, remaining: done.remaining, opened: done.remaining > 0 ? done.used + done.remaining : Math.min(s.opened, done.used) }
        : s)
      await refreshSummary()
    } catch (err) {
      changeDraft({ type: 'error' })
      const code = err && err.code
      // A finish whose answer was lost may still have spent an invite: say
      // so. Never issue again on our own.
      if (finishing && (code === 'indisponivel' || code === undefined)) {
        setNote(MAYBE_CREATED_TEXT)
      } else {
        errorCodeRef.current = typeof code === 'string' ? code : ''
        setError(errorText(err))
        // limite-convites stays until the screen closes. convite-aguardando
        // only until the next summary read, so a later grant can enable the button.
        if (code === 'limite-convites') setLimitHit(true)
        else if (code === 'convite-aguardando') {
          dropGen.current += 1
          setAwaitingDrop(true)
        }
      }
    } finally {
      busyRef.current = false
      setBusy(false)
      // A spent invite keeps its link for the next opening; only the card draft goes.
      if (!openRef.current) setDraft(initialCompose())
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
    const known = summary !== null && summary.key === ownKey ? summary : null
    const last = count !== null && count.key === ownKey ? count : null
    const view = known === null ? null : dropView(known)
    const text = view === null
      ? (last === null ? allowanceText(perWeek) : inviteCountText({ remaining: last.remaining, perWeek }))
      : view.text
    const hint = known !== null && known.mode === 'sorteio' ? DROPS_HINT_TEXT : WEEK_RESET_TEXT
    const noLeft = view === null ? last !== null && last.remaining === 0 : !view.enabled
    // The card shows why the button waits; skipping it never sends a plain link by accident.
    const cardMissing = draft.enabled && cardFields(draft, origin) === null
    const cardRefused = draft.enabled ? cardRefusal(draft) : ''
    body = (
      <>
        {text ? <Body>{text}</Body> : null}
        <HelpNote doc={HELP.convites}><Soft>{hint}</Soft></HelpNote>
        <InviteCardButton label={draft.enabled ? 'Mandar sem cartão' : 'Mandar com um cartão'} secondary onPress={() => changeDraft({ type: 'toggle' })} disabled={busy} expanded={draft.enabled} />
        {draft.enabled ? <InviteCardCompose draft={draft} origin={origin} onChange={changeDraft} disabled={busy} /> : null}
        <InviteCardButton label={createLabel(draft, origin)} onPress={create} pending={busy} disabled={busy || limitHit || awaitingDrop || noLeft || cardMissing} />
        {cardRefused !== '' ? <ErrorText>{cardRefused}</ErrorText> : null}
        {cardMissing && cardRefused === '' ? <Soft>{PROBLEM_TEXT[problem(draft, origin)]}</Soft> : null}
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
