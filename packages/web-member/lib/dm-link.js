'use strict'

// The two short-lived seeder links of direct messages (docs/protocol.md
// section 11), both shaped like the notices link (./notices.js openLink):
// a fresh WebSocket, a NoiseSecretStream with a fresh ephemeral key, the
// admission hello with role 'member', an EMPTY inventory and no announce,
// the seeder's hello verified (role 'seeder', seederCertForKey on its Noise
// key) before anything is sent, a frame guard and one deadline per link.
//
// - openDmLink: the anonymous 'varanda/dm/2' channel (@varanda/core
//   lib/dm-net.js, member role), or 'varanda/dm/1' on a seeder from before
//   the buckets (both are opened at connect; the first request waits for the
//   v2 open and uses v2 when it opened, else v1). Nothing on it names a
//   diary: no proof, no key. put(drop, prefix) -> { ok, reason },
//   page({ after, limit, prefixes }) -> { items, next, oldest }; prefix and
//   prefixes are 6-bit bucket prefixes of the box a drop is sealed to (null
//   or none: untagged, every bucket), which dm-net truncates to the seeder's
//   bits and a v1 lane ignores. A put is never repeated here.
// - openStampLink: 'varanda/dm-stamp/1' (lib/dm-stamp-net.js, member role),
//   the proof signed by the identity key over THIS link's Noise key. Used
//   for a wallet top-up and closed right after; never the dm link, never the
//   sync socket. key(kind) and issue(blinded, kind) take the stamp kind,
//   'dm' (the default, sent without a kind field) or 'blob'.
// - openBlobLink: the anonymous 'varanda/blob/1' channel (lib/blob-net.js,
//   member role), shaped like openDmLink: nothing on it names a diary.
//   put(frame) -> { ok, reason }. A put is never repeated here.
// - openVisitLink: the quiet visit lane 'varanda/visit/1' (lib/dm-net.js
//   with VISIT_PROTOCOL_V2, falling back to VISIT_PROTOCOL as openDmLink does),
//   shaped like openDmLink, into the seeder's
//   separate visit pool that wakes nobody. It resolves only once the channel
//   opened: a seeder without the lane (an old one, or --no-dm) rejects with
//   an error whose `unsupported` is true, and the caller then sends no visit
//   there, never falling back to the dm channel.
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachDm, DM_REQUEST_TIMEOUT_MS } = require('@varanda/core/lib/dm-net')
const { attachDmStamp } = require('@varanda/core/lib/dm-stamp-net')
const { attachBlob } = require('@varanda/core/lib/blob-net')
const { DM_MAX_MESSAGE, DM_PROTOCOL, VISIT_PROTOCOL, DM_PROTOCOL_V2, VISIT_PROTOCOL_V2 } = require('@varanda/core/lib/dm')
const { UsageError } = require('@varanda/core/lib/errors')
const { guardedWsStream } = require('./ws-stream')

const NO_SEEDER = 'sem conexão com o semeador'
const SEEDER_BUSY = 'Semeador ocupado; tente novamente em instantes.'
const VISIT_UNSUPPORTED = 'semeador sem visitas'
const DM_CONNECT_TIMEOUT_MS = 15000
const DM_LINK_DEADLINE_MS = 25000
const DM_STAMP_LINK_DEADLINE_MS = 45000
// Up to BLOB_MAX_CHUNKS puts, each waiting for its ack, paced under the
// seeder's put bucket and limited by the member's upload speed.
const BLOB_LINK_DEADLINE_MS = 300000
// One dm message (DM_MAX_MESSAGE) plus the protomux and Noise framing.
const DM_MAX_FRAME = DM_MAX_MESSAGE * 2

function noop () {}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

// Dials and resolves with { noise, verified } once the seeder's hello
// verified; attach(noise) runs on connect, before the hello can arrive, so
// protomux pairs the seeder's channel opens. deadlineMs ends the link
// whatever it is doing (the caller's requests then fail).
function dial ({ seederUrl, createSocket, association, log = noop, connectTimeoutMs = DM_CONNECT_TIMEOUT_MS, deadlineMs, maxFrame = DM_MAX_FRAME, attach }) {
  const warn = (text) => { try { log(text) } catch {} }
  return new Promise((resolve, reject) => {
    let socket
    try {
      socket = createSocket(seederUrl)
    } catch {
      reject(new Error(NO_SEEDER))
      return
    }
    let noise = null
    const { ws, stream } = guardedWsStream(socket, {
      maxFrame,
      onLimit: () => {
        warn('aviso: quadro grande demais do semeador')
        if (noise !== null) noise.destroy()
      }
    })
    noise = new NoiseSecretStream(true, stream, { keyPair: crypto.keyPair() })
    noise.on('error', noop)
    const link = { noise, verified: false }
    let settled = false
    const finish = (err) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      if (err) {
        noise.destroy()
        reject(err)
      } else {
        resolve(link)
      }
    }
    const connectTimer = setTimeout(() => finish(new Error(NO_SEEDER)), connectTimeoutMs)
    const deadline = setTimeout(() => noise.destroy(), deadlineMs)
    noise.once('close', () => {
      clearTimeout(deadline)
      finish(ws.closeCode === 1013 ? new UsageError(SEEDER_BUSY) : new Error(NO_SEEDER))
    })
    noise.once('connect', () => {
      try {
        Hypercore.createProtocolStream(noise)
        attachAdmission(noise, {
          role: 'member',
          have: [],
          onmessage: (msg, peer) => {
            if (msg.type !== 'hello') return
            link.verified = msg.role === 'seeder' &&
              peer.peerKey !== null &&
              seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
            if (!link.verified) {
              warn('aviso: o endereço configurado não respondeu como um semeador verificado (' + key8(peer.peerKey) + ')')
              finish(new Error(NO_SEEDER))
              return
            }
            finish(null)
          },
          log: noop
        })
        attach(noise, link)
      } catch {
        finish(new Error(NO_SEEDER))
      }
    })
  })
}

// Any request failure (timeout, closed channel, lost link) reads as a lost
// link: the caller decides what an unanswered put means (uncertain).
function lost () {
  return new Error(NO_SEEDER)
}

// Both lanes are attached at connect (a lane opened late would miss the
// seeder's open): the bucketed one is used when the seeder opened it, else
// the v1 one (an old seeder rejects the v2 open). A v2 that never answers
// within the request timeout counts as absent; the v2 handle is then closed
// and the v1 lane carries the request. A v2 open that hangs therefore costs
// up to one request timeout before v1's own timeout starts (about twice the
// wait of a v1-only member), still bounded by the link deadline.
// Resolves the handle to use, or null when neither lane opened.
function laneChooser (v2, v1, timeoutMs) {
  let chosen = null
  return () => {
    if (chosen === null) {
      chosen = (async () => {
        let timer
        const wait = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
        let ok = false
        try { ok = (await Promise.race([v2.supported, wait])) === true } catch {}
        clearTimeout(timer)
        if (ok) {
          try { v1.close() } catch {}
          return v2
        }
        try { v2.close() } catch {}
        let open = false
        try { open = (await v1.supported) === true } catch {}
        return open ? v1 : null
      })()
    }
    return chosen
  }
}

async function openDmLink ({ seederUrl, createSocket, association, log = noop, limits = {} } = {}) {
  let dm = null
  let dm2 = null
  const link = await dial({
    seederUrl,
    createSocket,
    association,
    log,
    connectTimeoutMs: limits.connectTimeoutMs,
    deadlineMs: limits.deadlineMs || DM_LINK_DEADLINE_MS,
    attach: (noise) => {
      const extra = limits.requestTimeoutMs ? { requestTimeoutMs: limits.requestTimeoutMs } : {}
      dm2 = attachDm(noise, { role: 'member', protocol: DM_PROTOCOL_V2, ...extra })
      dm = attachDm(noise, { role: 'member', protocol: DM_PROTOCOL, ...extra })
    }
  })
  const choose = laneChooser(dm2, dm, limits.requestTimeoutMs || DM_REQUEST_TIMEOUT_MS)
  return {
    async put (bytes, prefix = null) {
      try {
        const lane = (await choose()) || dm
        return await lane.put(bytes, prefix)
      } catch (err) {
        if (err instanceof TypeError) throw err
        throw lost()
      }
    },
    async page ({ after, limit, prefixes }) {
      try {
        const lane = (await choose()) || dm
        return await lane.requestPage({ after, limit, prefixes })
      } catch (err) {
        if (err instanceof TypeError) throw err
        throw lost()
      }
    },
    close () {
      try { dm.close() } catch {}
      try { dm2.close() } catch {}
      link.noise.destroy()
    }
  }
}

function unsupported () {
  const err = new Error(VISIT_UNSUPPORTED)
  err.unsupported = true
  return err
}

async function openVisitLink ({ seederUrl, createSocket, association, log = noop, limits = {} } = {}) {
  let visit = null
  let visit2 = null
  const link = await dial({
    seederUrl,
    createSocket,
    association,
    log,
    connectTimeoutMs: limits.connectTimeoutMs,
    deadlineMs: limits.deadlineMs || DM_LINK_DEADLINE_MS,
    attach: (noise) => {
      const extra = limits.requestTimeoutMs ? { requestTimeoutMs: limits.requestTimeoutMs } : {}
      visit2 = attachDm(noise, { role: 'member', protocol: VISIT_PROTOCOL_V2, ...extra })
      visit = attachDm(noise, { role: 'member', protocol: VISIT_PROTOCOL, ...extra })
    }
  })
  // No visit lane at all (neither v2 nor v1) is unsupported, never a
  // fallback to the dm lane.
  const lane = await laneChooser(visit2, visit, limits.requestTimeoutMs || DM_REQUEST_TIMEOUT_MS)()
  if (lane === null) {
    // Settled false by a rejected open or by the link ending first: either
    // way nothing can go on this lane here.
    const lostFirst = link.noise.destroyed
    try { visit.close() } catch {}
    try { visit2.close() } catch {}
    link.noise.destroy()
    throw lostFirst ? lost() : unsupported()
  }
  return {
    async put (bytes, prefix = null) {
      try {
        return await lane.put(bytes, prefix)
      } catch (err) {
        if (err instanceof TypeError) throw err
        throw lost()
      }
    },
    async page ({ after, limit, prefixes }) {
      try {
        return await lane.requestPage({ after, limit, prefixes })
      } catch (err) {
        if (err instanceof TypeError) throw err
        throw lost()
      }
    },
    close () {
      try { visit.close() } catch {}
      try { visit2.close() } catch {}
      link.noise.destroy()
    }
  }
}

async function openBlobLink ({ seederUrl, createSocket, association, log = noop, limits = {} } = {}) {
  let blob = null
  const link = await dial({
    seederUrl,
    createSocket,
    association,
    log,
    connectTimeoutMs: limits.connectTimeoutMs,
    deadlineMs: limits.blobDeadlineMs || BLOB_LINK_DEADLINE_MS,
    attach: (noise) => {
      blob = attachBlob(noise, { role: 'member', ...(limits.requestTimeoutMs ? { requestTimeoutMs: limits.requestTimeoutMs } : {}) })
    }
  })
  return {
    async put (frame) {
      try {
        return await blob.put(frame)
      } catch (err) {
        if (err instanceof TypeError) throw err
        throw lost()
      }
    },
    close () {
      try { blob.close() } catch {}
      link.noise.destroy()
    }
  }
}

// keyPair: the identity pair (in memory, the session's copy); the proof is
// signed only after the hello verified.
async function openStampLink ({ seederUrl, createSocket, association, keyPair, log = noop, limits = {} } = {}) {
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array)) throw new TypeError('par de chaves inválido')
  let stamp = null
  const ownKey = b4a.toString(keyPair.publicKey, 'hex')
  const link = await dial({
    seederUrl,
    createSocket,
    association,
    log,
    connectTimeoutMs: limits.connectTimeoutMs,
    deadlineMs: limits.stampDeadlineMs || DM_STAMP_LINK_DEADLINE_MS,
    attach: (noise, l) => {
      stamp = attachDmStamp(noise, {
        role: 'member',
        ownKey,
        ...(limits.requestTimeoutMs ? { requestTimeoutMs: limits.requestTimeoutMs } : {}),
        sign: (payload) => {
          if (!l.verified) throw new Error(NO_SEEDER)
          return crypto.sign(payload, keyPair.secretKey)
        }
      })
    }
  })
  const wrap = async (fn) => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof TypeError) throw err
      throw lost()
    }
  }
  return {
    key: (kind = 'dm') => wrap(() => stamp.key(kind)),
    issue: (blindedBase64, kind = 'dm') => wrap(() => stamp.issue(blindedBase64, kind)),
    close () {
      try { stamp.close() } catch {}
      link.noise.destroy()
    }
  }
}

module.exports = {
  openDmLink,
  openStampLink,
  openBlobLink,
  openVisitLink,
  NO_SEEDER,
  VISIT_UNSUPPORTED,
  DM_LINK_DEADLINE_MS,
  DM_STAMP_LINK_DEADLINE_MS,
  BLOB_LINK_DEADLINE_MS,
  DM_MAX_FRAME
}
