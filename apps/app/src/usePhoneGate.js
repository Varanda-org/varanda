// The hosted phone gate (src/phone.js) as React state for the shell, built
// like the age gate in App.js. Three inputs, never device storage: the
// service's policy, the member's status asked of the service, and the proofs
// the node holds and reports in node.info (owner decision 2026-11-11), which
// the node verified against the association's issuer.
//
// The policy is read once the node is ready; a failed read is tried again
// after 5 s, 15 s, then every 60 s, and when the connection comes back. Each
// installation has its own policy: an answer is labelled with the origin it
// was asked of. The status is asked once per generation, member and origin
// (and again on recheck); an answer that started under another one is
// dropped, so a 'nenhum' never clears the next member's proof.

import { useCallback, useEffect, useRef, useState } from 'react'
import { phonePolicy as readPhonePolicy, phoneSince as readPhoneSince, phoneStart, phoneStatus } from './account'
import { installationOrigin } from './installation'
import { phoneGate, phoneReadAllowed } from './phone.js'

export const phoneRetryDelay = (n) => (n === 0 ? 5000 : n === 1 ? 15000 : 60000)
// The node.info read the gate waits on, as the age step's in App.js.
export const phoneInfoDelay = (n) => (n === 0 ? 2000 : n === 1 ? 5000 : n === 2 ? 15000 : 30000)

export function isIsoDate (s) {
  if (typeof s !== 'string' || s.length !== 24) return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString() === s
}

// Pure: what node.info says for this member only (an info read for another
// key, or none yet, proves nothing).
export function phoneProofs (info, member) {
  const known = info !== null && typeof info === 'object' && typeof member === 'string' && info.publicKey === member
  return {
    known,
    vouched: known && isIsoDate(info.phoneVerifiedDate),
    sinceHeld: known && isIsoDate(info.phoneSince)
  }
}

const isProof = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// The installation the account calls go to right now, as App.js's ageOrigin:
// readPhonePolicy and readPhoneSince resolve it when they send, so an answer
// is kept only when it is the origin it will be stored under, at the send
// and at the arrival (an installation switch may be under way).
const currentOrigin = () => installationOrigin() || globalThis.location?.origin || ''

// Pure: whether node.info (about this member) shows what the node was handed.
// op: { verified } (a proof or null, the clear) or { since } (a proof or null).
export function infoShows (info, op) {
  if (info === null || typeof info !== 'object' || op === null || typeof op !== 'object') return false
  if ('verified' in op) return op.verified === null ? info.phoneVerifiedDate == null : isIsoDate(info.phoneVerifiedDate)
  if (op.since === null) return info.phoneSince == null
  return isProof(op.since) && typeof op.since.since === 'string' ? info.phoneSince === op.since.since : isIsoDate(info.phoneSince)
}

// afterProof: called once the node stored or cleared a proof, to read
// node.info again (the shell holds that read back during a recovery).
// readInfo and infoFree: the step replaces Identidade, the other reader of
// node.info on the setup, so node.info is read here while the gate blocks
// and none is known; infoFree is false while the shell must not read it (a
// recovery or once sync, or the age step, which reads it itself).
export function usePhoneGate ({ node, info, hosted, ready, termsOk, locked, member, origin, generation, afterProof, readInfo, infoFree = false }) {
  const request = node.request
  const online = node.online
  const afterProofRef = useRef(afterProof)
  afterProofRef.current = afterProof
  const requestRef = useRef(request)
  requestRef.current = request
  const after = () => {
    const f = afterProofRef.current
    return typeof f === 'function' ? f() : undefined
  }

  // --- the policy ---
  const [policyEntry, setPolicyEntry] = useState(null)
  const policy = policyEntry !== null && policyEntry.origin === origin ? policyEntry.policy : undefined
  const policyKnown = policy !== undefined && policy !== null
  const [policyTick, setPolicyTick] = useState(0)
  const policyTries = useRef(0)
  const policyTriesOrigin = useRef(origin)
  useEffect(() => {
    if (policyTriesOrigin.current !== origin) {
      policyTriesOrigin.current = origin
      policyTries.current = 0
    }
    if (!hosted || !ready || policyKnown) return
    let cancelled = false
    let timer = null
    const retry = () => {
      timer = setTimeout(() => setPolicyTick((n) => n + 1), phoneRetryDelay(policyTries.current))
      policyTries.current += 1
    }
    const o = origin
    if (o !== currentOrigin()) {
      retry()
      return () => clearTimeout(timer)
    }
    readPhonePolicy().then((p) => {
      if (cancelled) return
      if (currentOrigin() !== o) return retry()
      setPolicyEntry({ origin: o, policy: p })
      if (p !== null) return
      retry()
    }, () => {})
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [hosted, ready, policyKnown, policyTick, origin])
  const policyOnlineRef = useRef(online)
  useEffect(() => {
    const was = policyOnlineRef.current
    policyOnlineRef.current = online
    if (was !== false || online !== true || policyKnown) return
    setPolicyTick((n) => n + 1)
  }, [online, policyKnown])

  // --- the member's status ---
  const key = generation + '#' + member + '#' + origin
  const keyRef = useRef(key)
  keyRef.current = key
  const memberRef = useRef(member)
  memberRef.current = member
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const [answer, setAnswer] = useState(null)
  const state = answer !== null && answer.key === key ? answer.state : undefined
  const [checkTick, setCheckTick] = useState(0)
  const readKey = key + '#' + checkTick
  const readKeyRef = useRef(readKey)
  readKeyRef.current = readKey
  const [readDone, setReadDone] = useState(null)
  const [failure, setFailure] = useState(null)
  // Bumped by every status read, by markVerified and by a lock, generation
  // or origin change: an answer that arrives under another number is dropped.
  const seq = useRef(0)
  const ran = useRef(null)
  useEffect(() => {
    seq.current += 1
    ran.current = null
  }, [generation, locked, origin])

  // The only sender of a phone-verified attestation and of its clearing: a
  // service answer for the member and installation the request started with.
  const take = (k, who, st, proof) => {
    setAnswer({ key: k, state: st })
    if (st === 'verificado' && isProof(proof)) queueProof(k, who, proof)
    else if (st === 'nenhum') queueProof(k, who, null)
    else if (st === 'verificado') setProofOp((cur) => (cur !== null && cur.verified === null && cur.member === who ? null : cur))
  }

  // The store (or the clear) is tried until the node accepts it, after 5 s,
  // 15 s, then every 60 s and when the connection comes back: a clear that
  // never landed would vouch for the member on the next launch. A store
  // applies only under the key it was answered under. A clear belongs to the
  // identity: it survives a lock, a reset and an installation switch of the
  // same member, and goes only with another member or a later 'verificado'.
  // Accepted, it stays (and a clear keeps masking the vouch) until node.info
  // shows it, read again on the info schedule below.
  const [proofOp, setProofOp] = useState(null)
  const [proofTick, setProofTick] = useState(0)
  const proofTries = useRef(0)
  const queueProof = (k, who, verified) => {
    proofTries.current = 0
    setProofOp({ key: k, member: who, verified })
  }
  const proofApplies = (op) => op !== null && (op.verified === null
    ? typeof member === 'string' && op.member === member
    : op.key === key)
  useEffect(() => {
    if (proofOp !== null && proofOp.verified === null && typeof member === 'string' && proofOp.member !== member) {
      setProofOp(null)
    }
  }, [member, proofOp])
  useEffect(() => {
    if (!proofApplies(proofOp) || proofOp.accepted === true) return
    const op = proofOp
    let cancelled = false
    let timer = null
    requestRef.current('phone.proof', { verified: op.verified }).then(() => {
      if (cancelled) return
      proofTries.current = 0
      infoTries.current = 0
      setProofOp((cur) => (cur === op ? { ...op, accepted: true } : cur))
      return after()
    }, () => {
      if (cancelled) return
      timer = setTimeout(() => setProofTick((n) => n + 1), phoneRetryDelay(proofTries.current))
      proofTries.current += 1
    }).catch(() => {})
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [proofOp, proofTick, key, member])
  const proofOnlineRef = useRef(online)
  const proofWaiting = proofApplies(proofOp) && proofOp.accepted !== true
  useEffect(() => {
    const was = proofOnlineRef.current
    proofOnlineRef.current = online
    if (was !== false || online !== true || !proofWaiting) return
    setProofTick((n) => n + 1)
  }, [online, proofWaiting])

  // termsOk: the status route records nothing, but the member's requests to
  // the service wait for the current terms, as the age read does.
  const readNow = phoneReadAllowed({
    hosted,
    ready,
    termsOk,
    locked,
    member,
    policyKnown,
    policyRequired: policyKnown ? policy.required : undefined
  })
  useEffect(() => {
    if (!readNow) return
    if (ran.current === readKey) return
    ran.current = readKey
    if (origin !== currentOrigin()) return
    const mine = ++seq.current
    const k = key
    const o = origin
    const stale = () => mine !== seq.current || k !== keyRef.current || lockedRef.current || currentOrigin() !== o
    const run = async () => {
      const { nonce } = await phoneStart({ member })
      if (stale()) return
      const { signature } = await requestRef.current('phone.sign', { action: 'status', nonce })
      if (stale()) return
      const r = await phoneStatus({ member, nonce, signature })
      if (!stale()) take(k, member, r.state, r.proof)
    }
    run().catch((err) => {
      if (!stale()) setFailure({ key: readKey, err })
    }).finally(() => {
      if (readKey === readKeyRef.current) setReadDone(readKey)
    })
  }, [readNow, readKey])

  const recheck = useCallback(() => {
    setFailure(null)
    setCheckTick((n) => n + 1)
  }, [])
  // A 'verificado' from the verify screen (send or check), applied only
  // under the key (generation, member, installation) its request started
  // with: it wins over a status read still in flight, and never opens the
  // gate of another account or installation.
  const markVerified = useCallback((proof, startedKey) => {
    if (startedKey !== keyRef.current || lockedRef.current) return
    seq.current += 1
    setFailure(null)
    take(startedKey, memberRef.current, 'verificado', proof)
  }, [])

  // --- the installation's signed since, handed to the node ---
  // As the age since in App.js: once per installation and generation (a
  // reset clears the node's copy); a failed read (undefined) or store is
  // tried again after 5 s, 15 s, then every 60 s, and at once when the
  // connection comes back. A live null clears a stale stored since. The
  // Vitrine's read never settles, so nothing is sent there.
  const sinceNow = hosted === true && ready === true && locked === false && typeof member === 'string' && origin !== ''
  const genRef = useRef(generation)
  genRef.current = generation
  const originRef = useRef(origin)
  originRef.current = origin
  const sinceSeq = useRef(0)
  const sinceDone = useRef(null)
  const sinceTries = useRef(0)
  const [sinceTick, setSinceTick] = useState(0)
  // The since the node accepted, until node.info shows it.
  const [sinceShown, setSinceShown] = useState(null)
  useEffect(() => {
    if (!sinceNow) return
    const o = origin
    const k = generation + '#' + o
    if (sinceDone.current === k) return
    const mine = ++sinceSeq.current
    const latest = () => mine === sinceSeq.current && generation === genRef.current && o === originRef.current
    let cancelled = false
    let timer = null
    const retry = () => {
      if (cancelled || !latest()) return
      timer = setTimeout(() => setSinceTick((n) => n + 1), phoneRetryDelay(sinceTries.current))
      sinceTries.current += 1
    }
    if (o !== currentOrigin()) {
      retry()
      return () => clearTimeout(timer)
    }
    readPhoneSince().then((since) => {
      if (cancelled || !latest()) return
      if (since === undefined || currentOrigin() !== o) return retry()
      return requestRef.current('phone.proof', { since }).then(() => {
        if (!latest()) return
        sinceDone.current = k
        sinceTries.current = 0
        infoTries.current = 0
        setSinceShown({ key: k, member, since })
        return after()
      }, retry)
    }).catch(() => {})
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sinceNow, generation, origin, sinceTick, request])
  const sinceOnlineRef = useRef(online)
  useEffect(() => {
    const was = sinceOnlineRef.current
    sinceOnlineRef.current = online
    if (was !== false || online !== true || !sinceNow) return
    if (sinceDone.current === generation + '#' + origin) return
    setSinceTick((n) => n + 1)
  }, [online, sinceNow, generation, origin])

  // --- the gate ---
  // A failed policy read leans on the node's proofs, so it waits for
  // node.info about this member: without it, "neither proof" is not known.
  const proofs = phoneProofs(info, member)
  const gatePolicy = policy === null && !proofs.known ? undefined : policy
  // A clear the node has not accepted yet: its verified proof no longer
  // vouches, even when node.info still reports it.
  const clearPending = proofOp !== null && proofOp.verified === null && typeof member === 'string' && proofOp.member === member
  const ownInfo = proofs.known ? info : null
  const proofUnseen = proofOp !== null && proofOp.accepted === true && proofApplies(proofOp) && !infoShows(ownInfo, proofOp)
  const sinceUnseen = sinceShown !== null && sinceShown.key === generation + '#' + origin && sinceShown.member === member &&
    !infoShows(ownInfo, { since: sinceShown.since })
  useEffect(() => {
    if (proofOp !== null && proofOp.accepted === true && proofApplies(proofOp) && infoShows(ownInfo, proofOp)) {
      setProofOp((cur) => (cur === proofOp ? null : cur))
    }
    if (sinceShown !== null && infoShows(ownInfo, { since: sinceShown.since })) {
      setSinceShown((cur) => (cur === sinceShown ? null : cur))
    }
  }, [ownInfo, proofOp, sinceShown])
  const gate = phoneGate({ hosted, policy: gatePolicy, state, vouched: proofs.vouched && !clearPending, sinceHeld: proofs.sinceHeld })
  const error = failure !== null && failure.key === readKey ? failure.err : null
  // A status read for the current key has not finished, or the policy is
  // still unknown (its read is retried; the status cannot be asked before).
  const pending = (readNow && readDone !== readKey) || (hosted === true && !policyKnown)

  // node.info for the proofs, retried after 2 s, 5 s, 15 s, then every 30 s
  // while the gate still needs it, or a proof the node accepted is not shown
  // in it yet, and at once when the connection comes back.
  const infoNow = hosted === true && ready === true && locked === false && typeof member === 'string' &&
    infoFree === true && typeof readInfo === 'function' &&
    ((gate !== 'ok' && gate !== 'off' && info === null) || proofUnseen || sinceUnseen)
  const readInfoRef = useRef(readInfo)
  readInfoRef.current = readInfo
  const [infoTick, setInfoTick] = useState(0)
  const infoTries = useRef(0)
  useEffect(() => { infoTries.current = 0 }, [generation])
  useEffect(() => {
    if (!infoNow) return
    let cancelled = false
    let timer = null
    Promise.resolve().then(() => readInfoRef.current()).catch(() => {}).then(() => {
      if (cancelled) return
      timer = setTimeout(() => setInfoTick((n) => n + 1), phoneInfoDelay(infoTries.current))
      infoTries.current += 1
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [infoNow, generation, infoTick])
  const infoOnlineRef = useRef(online)
  useEffect(() => {
    const was = infoOnlineRef.current
    infoOnlineRef.current = online
    if (was !== false || online !== true || !infoNow) return
    setInfoTick((n) => n + 1)
  }, [online, infoNow])

  return { gate, state, error, pending, key, recheck, markVerified }
}
