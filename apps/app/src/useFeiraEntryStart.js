// "Pedir entrada" for a visitor from a Feira listing link (src/feiraEntry.js),
// shared by the Google step (Identidade's LinkCard) and the age step (App.js,
// screens/Idade.js). With the Feira on, invites required and no code held,
// the offer shows; only a press asks the service for a code (never on its
// own, never repeated), and the code then goes through the ordinary flow.
//
// feira: { holder, origin, hold } (App.js) or null. required: the invite
// policy's required flag, undefined while unread. blocked: the offer is not
// for this person (a member already linked). onNote(text): the sentence to
// show ('' clears it).

import { useEffect, useRef, useState } from 'react'
import { feiraPolicy, feiraStart } from './account'
import { decideEntry, entryOffer, limitRefusal, startEntry, startRetryable } from './feiraEntry'
import { dropSignupInvite, loadSignupInvite } from './signupInviteStore'

export function useFeiraEntryStart ({ feira = null, active = false, required, blocked = false, onNote } = {}) {
  const note = (text) => { if (typeof onNote === 'function') onNote(text) }
  const entry = feira !== null && feira.holder ? feira.holder.load(feira.origin) : null
  const [policy, setPolicy] = useState(undefined)
  const asked = useRef(false)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(false)
  const [limited, setLimited] = useState(false)
  // Another listing (a new link while this card is up) is another seller:
  // what the last one answered says nothing about it.
  const entryKey = entry === null ? '' : entry.author + ':' + entry.seq
  const lastKey = useRef(entryKey)
  useEffect(() => {
    if (lastKey.current === entryKey) return
    lastKey.current = entryKey
    setTried(false)
    setRetry(false)
    setLimited(false)
  }, [entryKey])
  useEffect(() => {
    if (!active || entry === null || asked.current) return
    asked.current = true
    feiraPolicy().then(setPolicy, () => setPolicy(null))
  }, [active, entry])
  const decision = entry === null || policy === undefined || required === undefined
    ? null
    : decideEntry({ entry, held: loadSignupInvite(), policy, required: required === true })
  const action = decision === null ? null : decision.action
  const offer = entryOffer({ action, limited, blocked, tried, retry })
  const press = () => {
    if (busy || !offer) return
    note('')
    setTried(true)
    setBusy(true)
    setRetry(false)
    startEntry({ holder: feira.holder, entry, start: feiraStart, hold: feira.hold, isHeld: () => loadSignupInvite() !== null })
      .then((r) => {
        if (r.ok || r.superseded) note('')
        else {
          note(r.text)
          setRetry(startRetryable(r))
        }
      })
      .finally(() => setBusy(false))
  }
  // The held Feira code refused at sign-up: the seller's entries for this
  // week ran out. The code is dropped on every platform, the ref stays, and
  // no new code is offered: the service would refuse it too.
  const limit = (err) => {
    const hit = limitRefusal({ err, entry, held: loadSignupInvite() })
    if (hit === null) return false
    setLimited(true)
    setRetry(false)
    dropSignupInvite()
    feira.holder.forgetCode()
    note(hit.text)
    return true
  }
  const limitRef = useRef(limit)
  limitRef.current = limit
  // While a press is in flight the offer stands (its button shows pending), so
  // a screen never offers a step that needs the code before it arrives.
  return { entry, decision, action, offer: offer || busy, busy, tried, retry, limited, press, limit, limitRef }
}
