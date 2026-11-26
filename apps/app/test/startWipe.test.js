'use strict'

// A connection that starts without an open session (expired, signed out
// elsewhere, never made) leaves no private copy on disk: src/node.js wipes
// the local caches after the first identity.status() of the connection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/localCaches.js')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

test('shouldWipeOnStart truth table', async (t) => {
  const { shouldWipeOnStart } = await load()
  t.is(shouldWipeOnStart({ exists: true, unlocked: true }), false, 'unlocked keeps the caches')
  t.is(shouldWipeOnStart({ exists: true, unlocked: false }), true, 'locked wipes')
  t.is(shouldWipeOnStart({ exists: false }), true, 'missing unlocked wipes')
  t.is(shouldWipeOnStart({ unlocked: 'true' }), true, 'only a literal true keeps')
  t.is(shouldWipeOnStart({}), true, 'an empty status wipes')
  t.is(shouldWipeOnStart(null), false, 'no status without a failure keeps')
  t.is(shouldWipeOnStart(null, true), true, 'a failed first read wipes')
  t.is(shouldWipeOnStart({ unlocked: true }, true), true, 'a failure wins over any status')
  t.is(shouldWipeOnStart(undefined), false, 'no identity API keeps')
  t.is(shouldWipeOnStart('locked'), false, 'a non-object keeps')
})

test('a start without a session wipes the registered caches', async (t) => {
  const lc = await load()
  let wiped = 0
  const off = lc.registerLocalCache({ wipe: () => { wiped++ } })
  t.teardown(off)
  for (const st of [{ unlocked: true }, null, { unlocked: false }]) {
    if (lc.shouldWipeOnStart(st)) lc.wipeLocalCaches()
  }
  t.is(wiped, 1, 'only the locked status wiped')
  if (lc.shouldWipeOnStart(null, true)) lc.wipeLocalCaches()
  t.is(wiped, 2, 'a first read that threw wipes too')
})

test('source: node.js wipes right after noteOwner in the first-status block only', async (t) => {
  const src = read('node.js')
  const call = 'if (shouldWipeOnStart(pk, pkFailed)) wipeLocalCaches()'
  t.is(src.split('shouldWipeOnStart(').length - 1, 1, 'called once in node.js')
  t.is(src.split(call).length - 1, 1, 'the call sits in one place')

  const statusAt = src.indexOf('try { pk = await identity.status() } catch (err) { pkErr = errorText(err); pkFailed = true }')
  t.ok(statusAt > 0, 'the first identity.status() of a connection')
  const block = src.slice(statusAt)
  const noteAt = block.indexOf('noteOwner(pk)')
  const callAt = block.indexOf(call)
  t.ok(noteAt > 0, 'noteOwner(pk) follows the status read')
  const between = block.slice(noteAt + 'noteOwner(pk)'.length, callAt)
  t.is(between.trim(), '', 'the wipe is the statement right after noteOwner(pk)')
  t.ok(callAt < block.indexOf('setPkStatus(pk)'), 'before the status is published')

  const passkey = src.slice(src.indexOf('const readPasskey'))
  const passkeyEnd = passkey.indexOf('const passkeyOp = useCallback')
  t.absent(passkey.slice(0, passkeyEnd > 0 ? passkeyEnd : undefined).includes('shouldWipeOnStart'), 'not in readPasskey')
})
