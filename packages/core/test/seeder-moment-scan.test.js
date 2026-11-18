'use strict'

const test = require('brittle')
const b4a = require('b4a')
const { randomBytes } = require('crypto')
const { momentRecord, postRecord } = require('../lib/records')
const { recentMomentIds } = require('../lib/seeder')

const hex = (b) => b4a.toString(b, 'hex')
const DAY = 86400000

function media (id) {
  return { id, key: hex(randomBytes(32)), nonce: hex(randomBytes(24)), chunks: 1, bytes: 116, sha256: hex(randomBytes(32)), mime: 'image/jpeg', w: 8, h: 8, ms: 0 }
}

// A core whose block i is blocks[i - 1] (block 0 is the header), null = not stored.
function fakeCore (blocks) {
  return {
    length: blocks.length + 1,
    async get (i) {
      const b = blocks[i - 1]
      return b === null || b === undefined ? null : b4a.from(JSON.stringify(b))
    }
  }
}

test('recentMomentIds reads past an older-dated block appended after the momento', async (t) => {
  const now = Date.now()
  const id = hex(randomBytes(32))
  const moment = momentRecord({ text: 'm', media: media(id), at: new Date(now - 3600000).toISOString() })
  const old = postRecord({ text: 'roster refeito', at: new Date(now - 10 * DAY).toISOString() })
  const core = fakeCore([moment, old])
  const found = await recentMomentIds(core, new Set([id]), now - DAY, now + 600000)
  t.ok(found.has(id), 'the live momento shields its id')
})

test('recentMomentIds ignores a momento older than the window', async (t) => {
  const now = Date.now()
  const id = hex(randomBytes(32))
  const moment = momentRecord({ text: 'm', media: media(id), at: new Date(now - 3 * DAY).toISOString() })
  const found = await recentMomentIds(fakeCore([moment]), new Set([id]), now - DAY, now + 600000)
  t.is(found.size, 0)
})

test('recentMomentIds throws on a block in the window that is not stored', async (t) => {
  const now = Date.now()
  const id = hex(randomBytes(32))
  await t.exception(() => recentMomentIds(fakeCore([null, postRecord({ text: 'x' })]), new Set([id]), now - DAY, now + 600000))
})
