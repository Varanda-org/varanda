'use strict'

// The `page dm-*` pieces that the end-to-end test cannot drive cheaply: an
// uncertain send, a dm-list past its page cap, a --save that fails midway.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const { tmpDir } = require('./helpers/net')
const { _test: u } = require('../lib/commands/page')

test('dm-reply: an uncertain send says it may have arrived and must not be repeated', async (t) => {
  const call = async () => {
    const err = new Error(u.SEND_UNKNOWN)
    err.code = 'USAGE'
    throw err
  }
  const err = await u.dmPageSend(call, {}).then(() => null, (e) => e)
  t.ok(err && err.uncertain === true, 'uncertain flag')
  t.ok(err.message.includes('pode ter chegado'), err.message)
  t.ok(err.message.includes('dm-read não vai mostrá-la'), err.message)
  t.ok(err.message.includes('duas vezes'), err.message)
})

test('dm-list: a last page with next marks the listing incomplete', async (t) => {
  let calls = 0
  const endless = async (method, params) => {
    calls++
    return { conversations: [{ peer: 'p', folder: params.folder, at: 'a', preview: 'x' }], next: 'n' + calls }
  }
  const capped = await u.dmListFolders(endless, 'P')
  t.is(capped.incomplete, true)
  t.is(calls, 40, '20 pages per folder')
  t.is(capped.conversations.length, 40)
  const short = await u.dmListFolders(async () => ({ conversations: [], next: null }), 'P')
  t.is(short.incomplete, false)
})

test('dm-read --save: a failing read leaves no partial file and a rerun completes', async (t) => {
  const dir = tmpDir(t, 'varanda-page-dm-save-')
  const plan = [{ name: 'a.png', bytes: Buffer.from('aaaa') }, { name: 'b.png', bytes: Buffer.from('bbbb') }]
  const saved = []
  const failing = async (p) => {
    if (p.name === 'b.png') throw new Error('falhou')
    return { bytes: p.bytes }
  }
  await t.exception(u.saveMedia(dir, plan, saved, failing), /falhou/)
  t.alike(saved, ['a.png'])
  t.alike(fs.readdirSync(dir), ['a.png'], 'no partial or temporary file')
  t.is(fs.statSync(path.join(dir, 'a.png')).mode & 0o777, 0o600)

  const rest = []
  await u.saveMedia(dir, plan.slice(1), rest, async (p) => ({ bytes: p.bytes }))
  t.alike(fs.readdirSync(dir).sort(), ['a.png', 'b.png'])
  t.is(fs.readFileSync(path.join(dir, 'b.png'), 'utf8'), 'bbbb')

  await t.exception(u.saveMedia(dir, plan.slice(0, 1), [], async () => ({ bytes: Buffer.from('zz') })), /EEXIST/)
  t.is(fs.readFileSync(path.join(dir, 'a.png'), 'utf8'), 'aaaa', 'never replaced')
  t.alike(fs.readdirSync(dir).sort(), ['a.png', 'b.png'])
})
