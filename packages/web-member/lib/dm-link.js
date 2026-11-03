'use strict'

// The two short-lived seeder links of direct messages (docs/protocol.md
// section 11), both shaped like the notices link (./notices.js openLink):
// a fresh WebSocket, a NoiseSecretStream with a fresh ephemeral key, the
// admission hello with role 'member', an EMPTY inventory and no announce,
// the seeder's hello verified (role 'seeder', seederCertForKey on its Noise
// key) before anything is sent, a frame guard and one deadline per link.
//
// - openDmLink: the anonymous 'varanda/dm/1' channel (@varanda/core
//   lib/dm-net.js, member role). Nothing on it names a diary: no proof, no
//   key. put(drop) -> { ok, reason }, page({ after, limit }) -> { items,
//   next, oldest }. A put is never repeated here.
// - openStampLink: 'varanda/dm-stamp/1' (lib/dm-stamp-net.js, member role),
//   the proof signed by the identity key over THIS link's Noise key. Used
//   for a wallet top-up and closed right after; never the dm link, never the
//   sync socket.
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachDm } = require('@varanda/core/lib/dm-net')
const { attachDmStamp } = require('@varanda/core/lib/dm-stamp-net')
const { DM_MAX_MESSAGE } = require('@varanda/core/lib/dm')
const { UsageError } = require('@varanda/core/lib/errors')
const { guardedWsStream } = require('./ws-stream')

const NO_SEEDER = 'sem conexão com o semeador'
const SEEDER_BUSY = 'Semeador ocupado; tente novamente em instantes.'
const DM_CONNECT_TIMEOUT_MS = 15000
const DM_LINK_DEADLINE_MS = 25000
const DM_STAMP_LINK_DEADLINE_MS = 45000
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

async function openDmLink ({ seederUrl, createSocket, association, log = noop, limits = {} } = {}) {
  let dm = null
  const link = await dial({
    seederUrl,
    createSocket,
    association,
    log,
    connectTimeoutMs: limits.connectTimeoutMs,
    deadlineMs: limits.deadlineMs || DM_LINK_DEADLINE_MS,
    attach: (noise) => {
      dm = attachDm(noise, { role: 'member', ...(limits.requestTimeoutMs ? { requestTimeoutMs: limits.requestTimeoutMs } : {}) })
    }
  })
  return {
    async put (bytes) {
      try {
        return await dm.put(bytes)
      } catch (err) {
        if (err instanceof TypeError) throw err
        throw lost()
      }
    },
    async page ({ after, limit }) {
      try {
        return await dm.requestPage({ after, limit })
      } catch (err) {
        if (err instanceof TypeError) throw err
        throw lost()
      }
    },
    close () {
      try { dm.close() } catch {}
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
    key: () => wrap(() => stamp.key()),
    issue: (blindedBase64) => wrap(() => stamp.issue(blindedBase64)),
    close () {
      try { stamp.close() } catch {}
      link.noise.destroy()
    }
  }
}

module.exports = {
  openDmLink,
  openStampLink,
  NO_SEEDER,
  DM_LINK_DEADLINE_MS,
  DM_STAMP_LINK_DEADLINE_MS,
  DM_MAX_FRAME
}
