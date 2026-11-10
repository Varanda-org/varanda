'use strict'

// A Página's private groups on this device (docs/rpc.md 5.114): group.read
// and group.seal with `page` fold the group as the page, with the page's
// group box (./page-dm.js groupBoxOf) in place of this device's box. The
// epoch keys that fold opens are kept here, per page and per group box,
// never in the identity's own holder (./group-keys.js): a page's keys and
// the identity's never mix. In memory only; lock() zeroes every key, and a
// box that changed (a new gen) or went away (dm.pageForget) drops the keys
// held under the old one.
const b4a = require('b4a')
const { KEY_BYTES } = require('@varanda/core/lib/group-crypto')
const { diaryGroupKeys } = require('@varanda/core/lib/group')
const { kidString } = require('./group-keys')

// The newest blocks a remote scan of a page diary reads (peekPageRoots):
// windows of PEEK_WINDOW, as page.read reads a page it does not hold.
const PEEK_WINDOW = 36
const PEEK_WINDOWS = 8

function zero (buf) {
  if (buf instanceof Uint8Array) buf.fill(0)
}

function zeroAll (map) {
  for (const key of map.values()) zero(key)
  map.clear()
}

// groupBoxOf: (page) -> the page's group box pair (the page holder's own
// buffers) or null.
function createPageGroupKeys ({ groupBoxOf }) {
  if (typeof groupBoxOf !== 'function') throw new TypeError('groupBoxOf required')
  let generation = 0
  // page -> { box: hex of the group box public key, epochs: Map kid -> key }
  const pages = new Map()

  function drop (page) {
    const p = pages.get(page)
    if (p === undefined) return
    zeroAll(p.epochs)
    pages.delete(page)
  }

  function lock () {
    generation++
    for (const page of [...pages.keys()]) drop(page)
  }

  // The current pair of `page`, its keys kept only while it is the same box.
  function pairOf (page) {
    const pair = groupBoxOf(page)
    if (pair === null || pair === undefined) {
      drop(page)
      return null
    }
    const box = b4a.toString(pair.publicKey, 'hex')
    const p = pages.get(page)
    if (p !== undefined && p.box !== box) drop(page)
    return pair
  }

  function entryOf (page, pair) {
    const box = b4a.toString(pair.publicKey, 'hex')
    let p = pages.get(page)
    if (p === undefined) {
      p = { box, epochs: new Map() }
      pages.set(page, p)
    }
    return p
  }

  // Whether this identity holds the page's secrets now.
  function holds (page) {
    return pairOf(page) !== null
  }

  // The holder member-ops folds `page` with (ctx.groupKeys): group-keys.js's
  // shape, its box the page's group box.
  function holderFor (page) {
    return {
      token: () => generation,
      boxKeyPair: () => pairOf(page),
      boxPublicKey () {
        const pair = pairOf(page)
        return pair === null ? null : new Uint8Array(pair.publicKey)
      },
      put (tok, kid, key) {
        const id = kidString(kid)
        if (id === null) throw new TypeError('kid inválido')
        if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) throw new TypeError('chave de época inválida')
        const pair = pairOf(page)
        if (tok !== generation || pair === null) return false
        const p = entryOf(page, pair)
        const prev = p.epochs.get(id)
        if (prev !== undefined) zero(prev)
        p.epochs.set(id, new Uint8Array(key))
        return true
      },
      get (kid) {
        const id = kidString(kid)
        if (id === null || pairOf(page) === null) return null
        const p = pages.get(page)
        return p === undefined ? null : p.epochs.get(id) || null
      },
      has (kid) {
        return this.get(kid) !== null
      },
      get unlocked () { return pairOf(page) !== null }
    }
  }

  return {
    lock,
    close: lock,
    holds,
    holderFor,
    get size () {
      let n = 0
      for (const p of pages.values()) n += p.epochs.size
      return n
    }
  }
}

// The roots a page diary this device does not store binds with live
// group-join records, read newest first through a bounded diary peek
// (peek({ author, seqs }) -> { length, entries, missing }, the session's
// diaryPeekWithin) before `deadline` (ms since the epoch). Joins older than
// the scanned windows are not seen. Throws on any failure: the caller then
// keeps no roots for the page.
async function peekPageRoots (peek, page, deadline, { window = PEEK_WINDOW, windows = PEEK_WINDOWS } = {}) {
  const left = () => {
    const ms = deadline - Date.now()
    if (ms <= 0) throw new Error('prazo esgotado')
    return ms
  }
  const first = await peek({ author: page, seqs: [0] }, left())
  const length = first.length
  const entries = []
  let hi = length - 1
  for (let w = 0; hi >= 1 && w < windows; w++) {
    const lo = Math.max(1, hi - window + 1)
    const seqs = []
    for (let q = lo; q <= hi; q++) seqs.push(q)
    hi = lo - 1
    const r = await peek({ author: page, seqs }, left())
    for (const e of r.entries) if (e && e.record) entries.push({ seq: e.seq, record: e.record })
  }
  entries.sort((a, b) => a.seq - b.seq)
  return diaryGroupKeys(entries)
}

module.exports = { createPageGroupKeys, peekPageRoots }
