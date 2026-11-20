'use strict'

// App.js wiring for the DM push notices: the wake key handed to the node, and
// notice taps. The shell cannot render in Node, so its handlers run in a VM.
const test = require('brittle')
const { readFileSync } = require('fs')
const { join } = require('path')
const { runInNewContext } = require('node:vm')

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

test('group opens switch from a Pagina to the member before the DM open path; DMs keep the Pagina', async (t) => {
  const { createActingAs } = await import('../src/actingAs.js')
  const { onDmOpen, requestDmOpen } = await import('../src/dm-open.js')
  const actingAs = createActingAs()
  const page = 'a'.repeat(64)
  const effect = block('useEffect(() => onDmOpen(', '// The worker shows no notice')
  const launch = block('// A DM wake names nobody:', '// A Pagina DM notice')
  for (const dmReady of [false, true]) {
    const calls = []
    let off
    const context = {
      actingAs,
      onDmOpen,
      requestDmOpen,
      useEffect: (fn) => { off = fn() },
      clearStack: () => calls.push(['clear', actingAs.pageKey()]),
      setConvCompose: (value) => calls.push(['compose', value]),
      setTab: (value) => calls.push(['tab', value]),
      setDmOpenCount: (fn) => calls.push(['count', fn(0)]),
      dmReady,
      dmRequest: async (method, params) => { calls.push([method, params]) },
      bumpDm: () => calls.push(['bump'])
    }
    runInNewContext(effect, context)
    try {
      for (const kind of ['group', 'dm']) {
        for (const atLoad of [false, true]) {
          actingAs.asPage({ key: page })
          calls.length = 0
          if (atLoad) runInNewContext('(function () { ' + launch + ' })()', { ...context, intent: { kind } })
          else if (kind === 'dm') requestDmOpen()
          else requestDmOpen(kind)
          await new Promise((resolve) => setImmediate(resolve))
          const expectedKey = kind === 'group' ? null : page
          t.is(actingAs.pageKey(), expectedKey, kind + ': acting identity, atLoad=' + atLoad)
          t.alike(JSON.parse(JSON.stringify(calls)), [
            ['clear', expectedKey], ['compose', false], ['tab', 'comunidades'], ['count', 1],
            ...(dmReady ? [['dm.pull', {}], ['bump']] : [])
          ], 'same navigation and refresh, dmReady=' + dmReady)
        }
      }
    } finally {
      off()
    }
  }
})

test('the web listener accepts only the DM or group open type without extra fields', (t) => {
  const source = readFileSync(join(__dirname, '../src/usePush.web.js'), 'utf8')
  const calls = []
  let receive
  runInNewContext(source.slice(source.indexOf('function isDmOpen'), source.indexOf('export function getPush')), {
    navigator: { serviceWorker: { addEventListener: (type, fn) => { receive = fn } } },
    requestDmOpen: (kind) => calls.push(kind),
    requestDmWake: () => { throw new Error('unexpected wake') }
  })
  for (const [type, kind] of [['varanda-dm-open', 'dm'], ['varanda-group-open', 'group']]) {
    calls.length = 0
    receive({ data: { type } })
    t.alike(calls, [kind])
    for (const data of [null, [type], { type: type + ' ' }, { type, actor: 'a'.repeat(64) }, { type, group: 'b'.repeat(64) }]) receive({ data })
    t.alike(calls, [kind], 'malformed open messages are ignored')
  }
})

test('DM and group launch queries keep distinct intents and strip the notice fields', async (t) => {
  const { parseLaunch, stripLaunch } = await import('../src/push-state.js')
  const source = readFileSync(join(__dirname, '../src/pushClient.web.js'), 'utf8')
  const code = source.slice(source.indexOf('export function dmLaunch'), source.indexOf('// A click while a window')).replaceAll('export function ', 'function ')
  for (const [aviso, kind] of [['dm', 'dm'], ['grupo', 'group']]) {
    const valid = '?conta=x%20y&aviso=' + aviso
    for (const search of [valid, '?aviso=' + aviso, '?aviso=' + aviso + '&aviso=' + aviso, '?aviso=' + aviso + '&aviso=follow', '?aviso=' + aviso + '&actor=', '?aviso=' + aviso + '&recipient=', '?aviso=' + aviso + '&ref=', '?aviso=' + aviso + '%20']) {
      let cleaned
      const intent = runInNewContext(code + '\ncaptureLaunch()', {
        URLSearchParams,
        hostedPage: true,
        location: { search, pathname: '/', hash: '#kept' },
        history: { state: null, replaceState: (state, title, url) => { cleaned = url } },
        parseLaunch,
        stripLaunch
      })
      t.alike(JSON.parse(JSON.stringify(intent)), search === valid || search === '?aviso=' + aviso ? { kind } : null, search)
      t.is(cleaned, search === valid ? '/?conta=x%20y#kept' : '/#kept', 'notice fields are consumed')
    }
  }
})
