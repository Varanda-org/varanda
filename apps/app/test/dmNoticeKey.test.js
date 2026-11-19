'use strict'

// App.js wiring for the DM push notices: the wake key handed to the node, and
// the dm-page tap. The shell cannot render in Node, so this reads its source.
const test = require('brittle')
const { readFileSync } = require('fs')
const { join } = require('path')

const app = readFileSync(join(__dirname, '../App.js'), 'utf8')

function block (start, end) {
  const from = app.indexOf(start)
  const to = from === -1 ? -1 : app.indexOf(end, from)
  return from === -1 || to === -1 ? '' : app.slice(from, to)
}

test('the wake key reaches the node once per epoch, from the account service only', (t) => {
  const effect = block('const noticeKeyEpochRef', '// --- Visto em todos')
  t.ok(effect.length > 0, 'the effect is there')
  t.ok(effect.includes('const noticeKeyReady = dmReady && node.online === true'), 'hosted, unlocked, terms accepted and online')
  t.ok(effect.includes('noticeKeyEpochRef.current === nodeEpoch) return'), 'once per node epoch')
  t.ok(effect.includes('pushWakeKey()'), 'read from the account service')
  t.ok(effect.includes("request('dm.noticeKey', { key })"), 'handed to the node as is')
  t.ok(effect.includes('if (!current()) return\n        if (key === null) return retry()'), 'a stale run sends nothing; no key tries again')
  t.ok(effect.includes('if (current()) noticeKeyEpochRef.current = epoch'), 'only a stored key marks the epoch done')
  t.ok(effect.includes('}, retry)') && effect.includes('.catch(retry)'), 'a refused handoff or a failed read tries again')
  t.ok(effect.includes('if (n > NOTICE_KEY_TRIES) return'), 'a bounded number of tries per epoch')
  t.ok(effect.includes('const n = fails.epoch === epoch ? fails.n + 1 : 1'), 'a new epoch starts the tries over')
  t.ok(effect.includes('NOTICE_KEY_RETRY_MS * 2 ** (n - 1)'), 'doubling waits')
  t.ok(effect.includes('if (retryTimer !== null) clearTimeout(retryTimer)'), 'a pending try is dropped with the run')
  t.ok(app.includes('const NOTICE_KEY_TRIES = 5') && app.includes('const NOTICE_KEY_RETRY_MS = 30000'), '5 tries from 30 s')
  t.ok(effect.includes('}, [noticeKeyReady, nodeEpoch, noticeKeyTry])'), 'a new epoch, coming online or a due try asks again')
  t.absent(/console\.|log\(/.test(effect), 'the key is never logged')
  t.absent(effect.includes('pushKey'), 'not tied to the member own push switch')
})

test('a dm-page tap opens Paginas, or Conversas without them', (t) => {
  const handler = block("if (intent.kind === 'dm-page') {", "if (intent.kind === 'convite') {")
  t.ok(handler.length > 0, 'the dm-page branch is there')
  t.ok(handler.includes("pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin })) pushScreen({ screen: 'paginas' })"), 'the Paginas list, as Ajustes opens it')
  t.ok(handler.includes('else requestDmOpen()'), 'falls back to Conversas')
  t.ok(app.indexOf("if (intent.kind === 'dm-page') {") < app.indexOf('if (intent.recipient !== launchKey.toLowerCase()) return'), 'before the recipient check: the notice names nobody')
})
