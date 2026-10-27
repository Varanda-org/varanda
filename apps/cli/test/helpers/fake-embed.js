'use strict'

// A deterministic stand-in for the MiniLM embedder (lib/account/ai/embedder.js)
// so the triage worker and the e2e tests run with no model: a hashed
// bag-of-words vector of DIM components, L2-normalised. Every word (letters
// and digits, lower-cased) is hashed with sha256; the first two bytes pick a
// component and the third byte a sign. Two texts sharing most words have a
// high cosine; texts with disjoint words a cosine near zero, so near
// duplicates and strangers behave as they would with a sentence model.
// `makeEmbed` gives the worker's contract: embed(text) -> Promise of
// { embedding, truncated }, truncating (embedding null) past `maxWords`.

const crypto = require('node:crypto')

const DIM = 384

function words (text) {
  return String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

// text -> DIM-component unit vector (a zero vector for an empty text).
function fakeEmbed (text) {
  const v = new Array(DIM).fill(0)
  for (const w of words(text)) {
    const h = crypto.createHash('sha256').update(w, 'utf8').digest()
    const i = h.readUInt16BE(0) % DIM
    v[i] += (h[2] & 1) === 1 ? 1 : -1
  }
  let sum = 0
  for (const x of v) sum += x * x
  const n = Math.sqrt(sum)
  return n > 0 ? v.map((x) => x / n) : v
}

// Builds an async embed(text) with the embedder's contract. `calls` records
// every text handed to it (tests assert the worker embeds the verified post
// text, never the reporter's quote).
function makeEmbed ({ maxWords = 128, calls = [] } = {}) {
  const embed = async (text) => {
    calls.push(text)
    if (words(text).length > maxWords) return { embedding: null, truncated: true }
    return { embedding: fakeEmbed(text), truncated: false }
  }
  embed.calls = calls
  return embed
}

module.exports = { DIM, fakeEmbed, makeEmbed, words }
