// The phone check's two requests for the Telefone screen: send (the service
// texts a code) and check (the code typed back). Each takes a fresh nonce
// (the service spends it first, even on a refusal), has the node sign it and
// goes once: nothing here sends again on its own. A send whose outcome is
// unknown may have texted a code, so the code field stays open.

import { useCallback, useEffect, useRef, useState } from 'react'
import { phoneCheck, phoneSend, phoneStart } from './account'
import { PHONE_SENT_TEXT, PHONE_UNCERTAIN_TEXT, isCode, phoneErrorText, toBrMobile } from './phone.js'
import { errorText } from './ui'

export const RESEND_MS = 60000
export const PHONE_INVALID_TEXT = 'Digite um celular brasileiro com DDD, como (11) 91234-5678.'
export const CODE_INVALID_TEXT = 'Digite os 6 números do código.'

const textOf = (err) => phoneErrorText(err) || errorText(err)

// gateKey: the phone gate's key (generation, member, installation). An
// answer is dropped when it changes, on reset and on unmount, and every
// answer carries the key it started under, for markVerified. onDropped: a
// send or check that reached the service was dropped while the session
// stayed the same, so a recorded verification is picked up by a status read.
export function usePhoneVerify ({ node, member, gateKey, onDropped }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [sent, setSent] = useState(false)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const key = typeof gateKey === 'string' ? gateKey : String(member)
  const busyRef = useRef(false)
  const memberRef = useRef(member)
  memberRef.current = member
  const keyRef = useRef(key)
  keyRef.current = key
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const onDroppedRef = useRef(onDropped)
  onDroppedRef.current = onDropped
  const liveRef = useRef(true)
  // Bumped by a key change and by reset: an answer started before is
  // dropped.
  const seq = useRef(0)

  useEffect(() => {
    liveRef.current = true
    return () => { liveRef.current = false }
  }, [])
  useEffect(() => {
    seq.current += 1
    busyRef.current = false
    setBusy(false)
    setError('')
    setNote('')
    setSent(false)
    setResendAt(0)
  }, [key])

  const waiting = resendAt > now
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [waiting])
  const resendIn = waiting ? Math.ceil((resendAt - now) / 1000) : 0

  const startCountdown = () => {
    const at = Date.now()
    setNow(at)
    setResendAt(at + RESEND_MS)
  }

  // -> the service's answer ({ state, proof?, key }), { uncertain: true, key }
  // for a send or check with an unknown outcome, or null when nothing was answered
  // for this session (a refusal, a dropped answer, a request in flight).
  const run = async (action, value) => {
    const who = memberRef.current
    const k = keyRef.current
    if (typeof who !== 'string' || busyRef.current || !liveRef.current) return null
    const mine = ++seq.current
    const stale = () => mine !== seq.current || k !== keyRef.current || !liveRef.current
    const dropped = () => {
      if (k === keyRef.current && typeof onDroppedRef.current === 'function') onDroppedRef.current()
      return null
    }
    let asked = false
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const { nonce } = await phoneStart({ member: who })
      if (stale()) return null
      const { signature } = await requestRef.current('phone.sign', { action, nonce })
      if (stale()) return null
      asked = true
      const r = action === 'send'
        ? await phoneSend({ member: who, nonce, signature, phone: value })
        : await phoneCheck({ member: who, nonce, signature, code: value })
      if (stale()) return dropped()
      return { ...r, key: k }
    } catch (err) {
      if (stale()) return asked ? dropped() : null
      if (action === 'send' && err && err.uncertain === true) {
        setSent(true)
        setNote(PHONE_UNCERTAIN_TEXT)
        startCountdown()
        // It may have answered 'verificado' (no code sent): the caller asks
        // the status.
        return { uncertain: true, key: k }
      }
      setError(textOf(err))
      // A check that may have been recorded: the caller can ask the status
      // (a read) instead of sending the code again.
      return err && err.uncertain === true ? { uncertain: true, key: k } : null
    } finally {
      if (!stale()) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  const send = async (text) => {
    const phone = toBrMobile(text)
    if (phone === null) {
      setError(PHONE_INVALID_TEXT)
      return null
    }
    const r = await run('send', phone)
    if (r !== null && r.state === 'enviado') {
      setSent(true)
      setNote(PHONE_SENT_TEXT)
      startCountdown()
    }
    return r
  }

  const check = async (code) => {
    const c = typeof code === 'string' ? code.trim() : ''
    if (!isCode(c)) {
      setError(CODE_INVALID_TEXT)
      return null
    }
    return run('check', c)
  }

  // Back to the number field ('Trocar número'). A request in flight is
  // dropped; whatever the service did with it stands.
  const reset = useCallback(() => {
    seq.current += 1
    busyRef.current = false
    setBusy(false)
    setError('')
    setNote('')
    setSent(false)
    setResendAt(0)
  }, [])

  return { busy, error, note, sent, resendIn, send, check, reset }
}
