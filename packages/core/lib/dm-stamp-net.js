'use strict'

// The direct message stamp channel 'varanda/dm-stamp/1' (docs/protocol.md
// section 11). A member proves its diary, as on 'varanda/notices/2', and the
// seeder blind-signs stamps for it within a daily budget per diary
// (dm-postage.js). The proof is what the budget is for; the blinded value
// tells the seeder nothing about the drop the stamp will pay for, so the
// stamp cannot be tied back to this diary. The seeder attaches the channel
// to every peer socket; the member opens it on its own short-lived link
// (fresh Noise key), never on the sync socket nor on the anonymous dm link.
//
// Flow (all messages JSON in one c.buffer message type):
//   seeder -> member  { type: 'challenge', nonce }        once, on open
//   member -> seeder  { type: 'proof', key, sig }         once (v1)
//              or     { type: 'proof', key, sig, signer } once (v2)
//   member -> seeder  { type: 'key' }
//   seeder -> member  { type: 'key', v: 1, kid, n, e }
//   member -> seeder  { type: 'issue', blinded }          canonical base64, 256 bytes
//   seeder -> member  { type: 'stamp', kid, sig }  or  { type: 'stamp', error }
// Blob stamps (media chunks) ride the same channel under the seeder's
// separate blob key, with a kind field and nothing else added:
//   member -> seeder  { type: 'key', kind: 'blob' }
//   seeder -> member  { type: 'key', kind: 'blob', v: 1, kid, n, e }
//   member -> seeder  { type: 'issue', blinded, kind: 'blob' }
//   seeder -> member  { type: 'stamp', kid, sig }  or  { type: 'stamp', error }
// A history copy (docs/protocol.md section 11) buys its stamps on the same
// channel with kind 'copy': the seeder answers with the BLOB public key (a
// copy stamp is a blob stamp, spent on the blob pool) but charges its own
// weekly budget per diary, never the blob one (nor the reverse):
//   member -> seeder  { type: 'key', kind: 'copy' }
//   seeder -> member  { type: 'key', kind: 'copy', v: 1, kid, n, e }
//   member -> seeder  { type: 'issue', blinded, kind: 'copy' }
//   seeder -> member  { type: 'stamp', kid, sig }  or  { type: 'stamp', error }
// A seeder from before the kind treats these as bad messages and never
// answers: the member's request times out. The budget gets the Brasília ISO
// week ('YYYY-Www') where the others get the day.
// A message without kind is a DM one, byte for byte as before; kind 'dm' is
// never written, so each message has one encoding. A blob issue is signed
// only by the blob key and charged only to the blob budget, and a DM issue
// only by the DM key and the DM budget: a DM-domain value sent as a blob
// issue gets a signature that no DM key verifies. A seeder without a blob
// key treats the blob messages as bad, as one from before them does.
// error is 'teto' (the diary's budget for the day is spent) or 'ruim' (the
// blinded value cannot be signed). The v1 proof is an Ed25519 signature by
// the diary key over 'varanda-dm-stamp-v1' LF nonce LF the member's Noise
// public key LF the diary key, checked against THIS connection's remote
// Noise key: it only fits a diary whose key IS its signer (Hypercore 10, the
// browser). A Hypercore 11 diary key is the hash of its signer's one-signer
// manifest, so its member sends v2: signed by `signer` over
// 'varanda-dm-stamp-v2' LF nonce LF Noise key LF key LF signer, accepted only
// when diaryKeyOfSigner(signer) is the key (./diary-signer.js) and never with
// signer === key (that diary proves with v1). Either way the budget and
// everything after are keyed by `key`, the diary. Each prefix differs from
// every notices proof and from the other, so no proof crosses over.
//
// Bad messages, drops and lifetime as notices-net.js. Every request waits for
// a valid proof and one request is in flight at a time. The seeder stores
// nothing about a blinded value and logs only { event: 'dm-stamp', reason }
// ('blob-stamp' for a blob issue), never a key. A budget may expose
// check(diary, day), side-effect free: it runs before the costly blind
// signature, so a key that may get no stamp costs the seeder no modPow.
// MAX_TETO_DM_STAMP 'teto' answers in a row on one channel, of either kind,
// drop the peer.
const b4a = require('b4a')
const c = require('compact-encoding')
const hcrypto = require('hypercore-crypto')
const clock = require('./clock')
const { localDay, localWeek } = require('./activity')
const { hasExactKeys, isHex64 } = require('./records')
const { MESSAGE_BURST, MESSAGE_RATE } = require('./blocklist-net')
const { DM_STAMP_PROTOCOL } = require('./dm')
const { MODULUS_BYTES, parsePublicKey, fromBase64, toBase64 } = require('./dm-postage')
const { isDiaryOfSigner } = require('./diary-signer')

const DM_STAMP_PROOF_PREFIX = 'varanda-dm-stamp-v1\n'
const DM_STAMP_PROOF_PREFIX_V2 = 'varanda-dm-stamp-v2\n'
const MAX_BAD_DM_STAMP = 5
const MAX_TETO_DM_STAMP = 3
const DM_STAMP_MAX_MESSAGE = 16384
const DM_STAMP_REQUEST_TIMEOUT_MS = 10000
const DM_ISSUE_BURST = 10
const DM_ISSUE_RATE = 1 // tokens per second: 10 per 10 s
// A media view needs one stamp per chunk, so blob issues have their own,
// larger bucket and never eat into the DM one.
const BLOB_ISSUE_BURST = 32
const BLOB_ISSUE_RATE = 4
// A copy issues as fast as a blob one but in a bucket of its own: a copy is
// thousands of stamps in a row and must not starve the media ones.
const COPY_ISSUE_BURST = BLOB_ISSUE_BURST
const COPY_ISSUE_RATE = BLOB_ISSUE_RATE
const STAMP_KINDS = Object.freeze(['blob', 'copy'])
const STAMP_ERRORS = Object.freeze(['teto', 'ruim'])
const HEX128 = /^[0-9a-f]{128}$/
const HEX16 = /^[0-9a-f]{16}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const MODULUS_BASE64_LENGTH = Math.ceil(MODULUS_BYTES / 3) * 4

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function tokenBucket (burst, rate) {
  let tokens = burst
  let last = clock.now()
  return {
    take () {
      const now = clock.now()
      tokens = Math.min(burst, tokens + (now - last) * rate / 1000)
      last = now
      if (tokens < 1) return false
      tokens--
      return true
    }
  }
}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function isModulusBase64 (s) {
  if (typeof s !== 'string' || s.length !== MODULUS_BASE64_LENGTH || !BASE64.test(s)) return false
  const bytes = b4a.from(s, 'base64')
  return bytes.byteLength === MODULUS_BYTES && b4a.toString(bytes, 'base64') === s
}

function encodeProof (nonceHex, noiseHex, keyHex) {
  return b4a.from(DM_STAMP_PROOF_PREFIX + nonceHex + '\n' + noiseHex + '\n' + keyHex, 'utf8')
}

// Never throws.
function verifyProof (fields, sigHex) {
  try {
    if (!isPlainObject(fields)) return false
    const { nonce, noise, key } = fields
    if (!isHex64(nonce) || !isHex64(noise) || !isHex64(key)) return false
    if (typeof sigHex !== 'string' || !HEX128.test(sigHex)) return false
    return hcrypto.verify(encodeProof(nonce, noise, key), b4a.from(sigHex, 'hex'), b4a.from(key, 'hex')) === true
  } catch {
    return false
  }
}

function encodeProofV2 (nonceHex, noiseHex, keyHex, signerHex) {
  return b4a.from(DM_STAMP_PROOF_PREFIX_V2 + nonceHex + '\n' + noiseHex + '\n' + keyHex + '\n' + signerHex, 'utf8')
}

// Never throws.
function verifyProofV2 (fields, sigHex) {
  try {
    if (!isPlainObject(fields)) return false
    const { nonce, noise, key, signer } = fields
    if (!isHex64(nonce) || !isHex64(noise) || !isHex64(key) || !isHex64(signer)) return false
    if (signer === key) return false
    if (typeof sigHex !== 'string' || !HEX128.test(sigHex)) return false
    if (!isDiaryOfSigner(key, signer)) return false
    return hcrypto.verify(encodeProofV2(nonce, noise, key, signer), b4a.from(sigHex, 'hex'), b4a.from(signer, 'hex')) === true
  } catch {
    return false
  }
}

// Exact keys for every message of the channel, from either side. Never
// throws.
function validateDmStampMessage (msg) {
  try {
    if (!isPlainObject(msg)) return false
    switch (msg.type) {
      case 'challenge':
        return hasExactKeys(msg, ['type', 'nonce']) && isHex64(msg.nonce)
      case 'proof':
        if (hasExactKeys(msg, ['type', 'key', 'sig', 'signer'])) {
          if (!isHex64(msg.signer)) return false
        } else if (!hasExactKeys(msg, ['type', 'key', 'sig'])) {
          return false
        }
        return isHex64(msg.key) && typeof msg.sig === 'string' && HEX128.test(msg.sig)
      case 'key':
        if (hasExactKeys(msg, ['type'])) return true
        if (hasExactKeys(msg, ['type', 'kind'])) return STAMP_KINDS.includes(msg.kind)
        if (hasExactKeys(msg, ['type', 'kind', 'v', 'kid', 'n', 'e'])) {
          if (!STAMP_KINDS.includes(msg.kind)) return false
        } else if (!hasExactKeys(msg, ['type', 'v', 'kid', 'n', 'e'])) {
          return false
        }
        return parsePublicKey({ v: msg.v, kid: msg.kid, n: msg.n, e: msg.e }) !== null
      case 'issue':
        if (hasExactKeys(msg, ['type', 'blinded', 'kind']) && !STAMP_KINDS.includes(msg.kind)) return false
        else if (!hasExactKeys(msg, ['type', 'blinded']) && !hasExactKeys(msg, ['type', 'blinded', 'kind'])) return false
        return isModulusBase64(msg.blinded)
      case 'stamp':
        if (hasExactKeys(msg, ['type', 'error'])) return STAMP_ERRORS.includes(msg.error)
        return hasExactKeys(msg, ['type', 'kid', 'sig']) && typeof msg.kid === 'string' &&
          HEX16.test(msg.kid) && isModulusBase64(msg.sig)
      default:
        return false
    }
  } catch {
    return false
  }
}

function attachDmStamp (socket, opts = {}) {
  const slot = opts.slot === undefined ? '_varandaDmStamp' : opts.slot
  if (typeof slot !== 'string' || slot === '') throw new TypeError('invalid slot')
  if (socket && socket[slot]) return socket[slot]

  const {
    role,
    postage,
    budget,
    blobPostage,
    blobBudget,
    copyBudget,
    ownKey,
    ownSigner = null,
    sign,
    now = Date.now,
    log = noop,
    maxBytes = DM_STAMP_MAX_MESSAGE,
    maxBad = MAX_BAD_DM_STAMP,
    messageBurst = MESSAGE_BURST,
    messageRate = MESSAGE_RATE,
    issueBurst = DM_ISSUE_BURST,
    issueRate = DM_ISSUE_RATE,
    blobIssueBurst = BLOB_ISSUE_BURST,
    blobIssueRate = BLOB_ISSUE_RATE,
    copyIssueBurst = COPY_ISSUE_BURST,
    copyIssueRate = COPY_ISSUE_RATE,
    requestTimeoutMs = DM_STAMP_REQUEST_TIMEOUT_MS
  } = opts

  if (role !== 'seeder' && role !== 'member') throw new TypeError('role must be seeder or member')
  // kind -> { pubMsg, modulus, postage, budget }, seeder only. Each kind
  // signs with its own key and spends its own budget, never the other's.
  const kinds = new Map()
  if (role === 'seeder') {
    kinds.set('dm', seederKind(postage, budget, 'postage', 'budget', null))
    if (blobPostage !== undefined && blobPostage !== null) {
      const blob = seederKind(blobPostage, blobBudget, 'blobPostage', 'blobBudget', 'blob')
      if (blob.pubMsg.kid === kinds.get('dm').pubMsg.kid) throw new TypeError('blobPostage must use its own key')
      kinds.set('blob', blob)
    } else if (blobBudget !== undefined && blobBudget !== null) {
      throw new TypeError('blobBudget without blobPostage')
    }
    // The copy kind signs with the blob key, so it exists only with one.
    if (copyBudget !== undefined && copyBudget !== null) {
      if (blobPostage === undefined || blobPostage === null) throw new TypeError('copyBudget without blobPostage')
      kinds.set('copy', seederKind(blobPostage, copyBudget, 'blobPostage', 'copyBudget', 'copy'))
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function')
  } else {
    if (!isHex64(ownKey)) throw new TypeError('invalid ownKey')
    // A proof the seeder must refuse would only surface as a timed-out
    // request, so a signer that does not own ownKey fails here.
    if (ownSigner !== null && !isDiaryOfSigner(ownKey, ownSigner)) throw new TypeError('invalid ownSigner')
    if (typeof sign !== 'function') throw new TypeError('sign must be a function')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid maxBytes')
  if (!Number.isSafeInteger(maxBad) || maxBad < 0) throw new TypeError('invalid maxBad')
  if (!(requestTimeoutMs > 0)) throw new TypeError('invalid requestTimeoutMs')
  for (const [burst, rate] of [[messageBurst, messageRate], [issueBurst, issueRate], [blobIssueBurst, blobIssueRate], [copyIssueBurst, copyIssueRate]]) {
    if (!(burst >= 1) || !(rate > 0)) throw new TypeError('invalid rate limits')
  }

  const mux = socket && socket.noiseStream && socket.noiseStream.userData && socket.noiseStream.userData.isProtomux
    ? socket.noiseStream.userData
    : null
  if (!mux) throw new Error('replicate the store before attachDmStamp')

  let channel = null
  let message = null
  let isOpen = false
  let ended = false
  let dropped = false
  let settled = false
  let resolveSupported
  // The flood limit, taken before a message is even parsed. It covers the
  // message bucket plus both issue buckets (and a seeder sends one reply per
  // request), so a peer within the issue rates never trips it: a lone shared
  // bucket at messageRate would drop a member issuing blob stamps at the
  // allowed rate once its burst ran out.
  const inbound = tokenBucket(messageBurst + issueBurst + blobIssueBurst + copyIssueBurst, messageRate + issueRate + blobIssueRate + copyIssueRate)
  const issues = { dm: tokenBucket(issueBurst, issueRate), blob: tokenBucket(blobIssueBurst, blobIssueRate), copy: tokenBucket(copyIssueBurst, copyIssueRate) }

  // Seeder state, per channel.
  let nonce = null
  let proofSeen = false
  let boundKey = null
  let answering = false
  let tetoInRow = 0

  // Member state, per channel.
  let challengeSeen = false
  let provedDone = false
  let resolveProved = noop
  let rejectProved = noop
  let request = null

  const handle = {
    socket,
    role,
    badMessages: 0,
    supported: new Promise((resolve) => { resolveSupported = resolve }),
    close
  }
  if (role === 'member') {
    handle.proved = new Promise((resolve, reject) => {
      resolveProved = resolve
      rejectProved = reject
    })
    handle.proved.catch(noop)
    handle.key = requestKey
    handle.issue = requestIssue
  }
  socket[slot] = handle

  mux.pair({ protocol: DM_STAMP_PROTOCOL }, onpair)
  openChannel()
  if (typeof socket.once === 'function') socket.once('close', end)

  return handle

  function seederKind (p, b, pName, bName, kind) {
    if (!isPlainObject(p) || typeof p.sign !== 'function') throw new TypeError('invalid ' + pName)
    const parsed = parsePublicKey(p.publicKey)
    if (parsed === null) throw new TypeError('invalid ' + pName + ' public key')
    if (!isPlainObject(b) || typeof b.take !== 'function') throw new TypeError('invalid ' + bName)
    if (b.check !== undefined && typeof b.check !== 'function') throw new TypeError('invalid ' + bName)
    const { v, kid, n, e } = p.publicKey
    const pubMsg = kind === null ? { type: 'key', v, kid, n, e } : { type: 'key', kind, v, kid, n, e }
    return { pubMsg, modulus: parsed.n, postage: p, budget: b, kind, event: kind === null ? 'dm-stamp' : kind + '-stamp' }
  }

  function settle (value) {
    if (settled) return
    settled = true
    resolveSupported(value)
  }

  function settleProved (ok, err) {
    if (provedDone) return
    provedDone = true
    if (err) rejectProved(err)
    else resolveProved(ok)
  }

  function openChannel () {
    const ch = mux.createChannel({ protocol: DM_STAMP_PROTOCOL, onopen, onclose: onchannelclose })
    if (ch === null) return
    channel = ch
    nonce = null
    proofSeen = false
    boundKey = null
    answering = false
    // tetoInRow is per socket, not per channel: reopening the channel must
    // not reset the run that drops the peer.
    challengeSeen = false
    message = ch.addMessage({ encoding: c.buffer, onmessage: onraw })
    ch.open()
  }

  function onpair () {
    if (ended || dropped || channel !== null) return
    openChannel()
  }

  function onopen (handshake, ch) {
    if (ch !== channel || ended) return
    isOpen = true
    settle(true)
    if (role === 'seeder') {
      nonce = hex(hcrypto.randomBytes(32))
      rawSend({ type: 'challenge', nonce })
    }
  }

  function onchannelclose (isRemote, ch) {
    if (ch !== channel) return
    const wasOpen = isOpen
    isOpen = false
    channel = null
    message = null
    failRequest(new Error('dm stamp channel closed'))
    if (!wasOpen) settle(false)
    if (role === 'member') end()
  }

  function end () {
    if (ended) return
    ended = true
    mux.unpair({ protocol: DM_STAMP_PROTOCOL })
    failRequest(new Error('dm stamp channel closed'))
    settle(false)
    settleProved(false)
    if (socket[slot] === handle) delete socket[slot]
    if (typeof socket.off === 'function') socket.off('close', end)
  }

  function close () {
    const ch = channel
    end()
    if (ch !== null) ch.close()
  }

  function rawSend (msg) {
    if (!isOpen || message === null) return false
    message.send(b4a.from(JSON.stringify(msg), 'utf8'))
    return true
  }

  function drop (reason) {
    if (dropped || ended) return
    dropped = true
    failRequest(new Error('dm stamp peer dropped'))
    log({ event: 'peer-dropped', reason })
    const ch = channel
    if (ch !== null) ch.close()
    socket.destroy()
  }

  function badMessage () {
    handle.badMessages++
    if (handle.badMessages > maxBad) drop('dm-stamp')
  }

  function onraw (buf) {
    if (ended || dropped) return
    if (!inbound.take()) {
      drop('message-rate')
      return
    }
    let msg
    try {
      if (!buf || buf.byteLength === 0 || buf.byteLength > maxBytes) {
        badMessage()
        return
      }
      msg = JSON.parse(b4a.toString(buf, 'utf8'))
    } catch {
      badMessage()
      return
    }
    if (!validateDmStampMessage(msg)) {
      badMessage()
      return
    }
    if (role === 'seeder') onseeder(msg)
    else onmember(msg)
  }

  // ---- seeder role ----

  function onseeder (msg) {
    if (msg.type === 'proof') {
      if (proofSeen || nonce === null || !socket.remotePublicKey) {
        badMessage()
        return
      }
      proofSeen = true
      const fields = { nonce, noise: hex(socket.remotePublicKey), key: msg.key }
      const valid = msg.signer === undefined
        ? verifyProof(fields, msg.sig)
        : verifyProofV2({ ...fields, signer: msg.signer }, msg.sig)
      if (!valid) {
        badMessage()
        return
      }
      boundKey = msg.key
      return
    }
    // Only requests reach here: a key message with a public key is a reply.
    const isKeyRequest = msg.type === 'key' && msg.n === undefined
    const kind = msg.kind === undefined ? 'dm' : msg.kind
    const k = kinds.get(kind)
    if ((!isKeyRequest && msg.type !== 'issue') || k === undefined || boundKey === null || answering) {
      badMessage()
      return
    }
    if (isKeyRequest) {
      rawSend(k.pubMsg)
      return
    }
    if (!issues[kind].take()) {
      drop('dm-stamp-rate')
      return
    }
    answerIssue(msg.blinded, k)
  }

  // Not awaited by protomux: a rejected promise there destroys the stream.
  async function answerIssue (blindedBase64, k) {
    answering = true
    const ch = channel
    const { postage, budget, modulus, pubMsg, event } = k
    let reply
    const blinded = fromBase64(blindedBase64)
    // The budget's period: the Brasília day, or for a copy the ISO week.
    const day = k.kind === 'copy' ? localWeek(now()) : localDay(now())
    let eligible = true
    if (typeof budget.check === 'function') {
      try {
        eligible = budget.check(boundKey, day) === true
      } catch {
        eligible = false
      }
    }
    // Sign first and take the allowance last: a value that cannot be signed
    // spends nothing. A channel that closes after take() and before the stamp
    // is sent still loses that one slot of the day.
    let sig = null
    if (eligible && blinded !== null && blinded >= 1n && blinded < modulus) {
      try {
        sig = await postage.sign(blinded)
      } catch {}
    }
    if (!eligible) {
      reply = { type: 'stamp', error: 'teto' }
    } else if (typeof sig !== 'bigint' || sig < 1n || sig >= modulus) {
      reply = { type: 'stamp', error: 'ruim' }
    } else {
      let allowed = null
      try {
        // The budget is per Brasília day (docs/protocol.md section 11).
        allowed = (await budget.take(boundKey, day)) === true
      } catch {}
      if (allowed === null) reply = { type: 'stamp', error: 'ruim' }
      else if (!allowed) reply = { type: 'stamp', error: 'teto' }
      else reply = { type: 'stamp', kid: pubMsg.kid, sig: toBase64(sig) }
    }
    log({ event, reason: reply.error === undefined ? 'ok' : reply.error })
    if (ch !== channel || ended || dropped) return
    answering = false
    rawSend(reply)
    if (reply.error === 'teto') {
      tetoInRow++
      if (tetoInRow >= MAX_TETO_DM_STAMP) drop('dm-stamp-teto')
    } else if (reply.error === undefined) {
      tetoInRow = 0
    }
  }

  // ---- member role ----

  function onmember (msg) {
    if (msg.type === 'challenge') {
      if (challengeSeen) {
        badMessage()
        return
      }
      challengeSeen = true
      answerChallenge(msg.nonce)
      return
    }
    const r = request
    const isKeyReply = msg.type === 'key' && msg.n !== undefined
    const replyKind = msg.kind === undefined ? 'dm' : msg.kind
    if (r === null || !r.sent || (isKeyReply ? r.expects !== 'key' || r.kind !== replyKind : msg.type !== 'stamp' || r.expects !== 'stamp')) {
      badMessage()
      return
    }
    request = null
    clearTimeout(r.timer)
    if (isKeyReply) r.resolve({ v: msg.v, kid: msg.kid, n: msg.n, e: msg.e })
    else if (msg.error !== undefined) r.resolve({ error: msg.error })
    else r.resolve({ kid: msg.kid, sig: msg.sig })
  }

  function answerChallenge (nonceHex) {
    if (!socket.publicKey) {
      settleProved(false, new Error('no noise key'))
      close()
      return
    }
    const noiseHex = hex(socket.publicKey)
    let sig
    try {
      sig = sign(ownSigner === null ? encodeProof(nonceHex, noiseHex, ownKey) : encodeProofV2(nonceHex, noiseHex, ownKey, ownSigner))
      if (!(sig instanceof Uint8Array) || sig.byteLength !== 64) throw new Error('invalid signature')
    } catch (err) {
      log({ event: 'dm-stamp-sign-failed' })
      settleProved(false, err)
      close()
      return
    }
    const proof = ownSigner === null
      ? { type: 'proof', key: ownKey, sig: hex(sig) }
      : { type: 'proof', key: ownKey, sig: hex(sig), signer: ownSigner }
    if (!rawSend(proof)) return
    settleProved(true)
    if (request !== null && !request.sent) sendRequest()
  }

  // kind 'dm' (the default) sends the message without a kind field.
  function requestKey (kind = 'dm') {
    if (kind !== 'dm' && !STAMP_KINDS.includes(kind)) return Promise.reject(new TypeError('invalid stamp kind'))
    return startRequest(kind === 'dm' ? { type: 'key' } : { type: 'key', kind }, 'key', kind)
  }

  function requestIssue (blindedBase64, kind = 'dm') {
    if (kind !== 'dm' && !STAMP_KINDS.includes(kind)) return Promise.reject(new TypeError('invalid stamp kind'))
    if (!isModulusBase64(blindedBase64)) return Promise.reject(new TypeError('invalid blinded value'))
    const msg = kind === 'dm' ? { type: 'issue', blinded: blindedBase64 } : { type: 'issue', blinded: blindedBase64, kind }
    return startRequest(msg, 'stamp', kind)
  }

  // As notices-net.js: one request in flight, sent after our proof, and a
  // timeout that rejects AND closes the channel (never the socket).
  function startRequest (msg, expects, kind) {
    if (ended || dropped) return Promise.reject(new Error('dm stamp channel closed'))
    if (request !== null) return Promise.reject(new Error('a dm stamp request is already in flight'))
    return new Promise((resolve, reject) => {
      const r = { msg, expects, kind, sent: false, resolve, reject, timer: null }
      r.timer = setTimeout(() => {
        if (request !== r) return
        request = null
        reject(new Error('dm stamp request timed out'))
        close()
      }, requestTimeoutMs)
      request = r
      if (provedDone && isOpen) sendRequest()
    })
  }

  function sendRequest () {
    const r = request
    if (r === null || r.sent) return
    if (!rawSend(r.msg)) return
    r.sent = true
  }

  function failRequest (err) {
    const r = request
    if (r === null) return
    request = null
    clearTimeout(r.timer)
    r.reject(err)
  }
}

module.exports = {
  DM_STAMP_PROTOCOL,
  DM_STAMP_PROOF_PREFIX,
  DM_STAMP_PROOF_PREFIX_V2,
  MAX_BAD_DM_STAMP,
  MAX_TETO_DM_STAMP,
  DM_STAMP_MAX_MESSAGE,
  DM_STAMP_REQUEST_TIMEOUT_MS,
  DM_ISSUE_BURST,
  DM_ISSUE_RATE,
  BLOB_ISSUE_BURST,
  BLOB_ISSUE_RATE,
  COPY_ISSUE_BURST,
  COPY_ISSUE_RATE,
  encodeProof,
  verifyProof,
  encodeProofV2,
  verifyProofV2,
  validateDmStampMessage,
  attachDmStamp
}
