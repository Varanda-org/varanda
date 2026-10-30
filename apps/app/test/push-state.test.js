'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/push-state.js')

const b64url = (bytes) => Buffer.from(bytes).toString('base64url')
const point = b64url(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]))
const auth = b64url(Buffer.alloc(16, 9))
const actor = 'a'.repeat(64)
const recipient = 'b'.repeat(64)
const ref = recipient + ':12'
const subJson = (over = {}) => ({
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  expirationTime: null,
  keys: { p256dh: point, auth },
  ...over
})

test('the fixed texts are the approved Portuguese', async (t) => {
  const m = await load()
  t.alike(m.PUSH_KINDS, ['follow', 'reply', 'like', 'repost'])
  t.ok(Object.isFrozen(m.PUSH_KINDS))
  t.is(m.PUSH_LABEL, 'Avisos no aparelho')
  t.is(m.PUSH_ON, 'Ativar avisos neste aparelho')
  t.is(m.PUSH_OFF, 'Desligar avisos neste aparelho')
  t.is(m.PUSH_HINT, 'Receba um aviso quando alguém seguir você, responder, curtir ou republicar o que você publicou. Mostra o nome de quem fez a ação. Só neste aparelho.')
  t.is(m.PUSH_DENIED, 'Os avisos do sistema estão desligados neste aparelho.')
  t.is(m.PUSH_UNAVAILABLE, 'Os avisos ainda não estão disponíveis nesta associação.')
  t.is(m.PUSH_UNSUPPORTED, 'No iPhone e no iPad, os avisos só funcionam com o Varanda na Tela de Início.')
  t.is(m.PUSH_FAILED, 'Não foi possível mudar os avisos. Tente de novo.')
  t.is(m.PUSH_UNCERTAIN, 'incerto: pode ter sido aplicado; confira o botão antes de repetir')
  t.is(m.PUSH_RELOAD, 'Feche todas as janelas do Varanda e abra de novo para ligar os avisos.')
  t.is(m.PUSH_UNKNOWN, 'Não deu para confirmar os avisos agora.')
})

test('the module imports nothing and carries no em dash', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'push-state.js'), 'utf8')
  t.absent(/^\s*import\s/m.test(src), 'no import statement')
  t.absent(/\brequire\s*\(/.test(src), 'no require')
  t.absent(src.includes('\u2014'))
})

test('pushSupport: ok, unsupported and not-hosted', async (t) => {
  const { pushSupport } = await load()
  const all = { mode: 'browser', hosted: true, hasMarker: true, hasServiceWorker: true, hasPushManager: true, hasNotification: true }
  t.is(pushSupport(all), 'ok')
  t.is(pushSupport({ ...all, hasPushManager: false }), 'unsupported')
  t.is(pushSupport({ ...all, hasNotification: false }), 'unsupported')
  t.is(pushSupport({ ...all, hasServiceWorker: false }), 'unsupported')
  t.is(pushSupport({ ...all, mode: 'serve' }), 'not-hosted')
  t.is(pushSupport({ ...all, hosted: false }), 'not-hosted')
  t.is(pushSupport({ ...all, hasMarker: false }), 'not-hosted')
  t.is(pushSupport({ ...all, hosted: 'yes' }), 'not-hosted')
  t.is(pushSupport(), 'not-hosted')
})

test('applicationServerKey takes only a canonical 65-byte uncompressed point', async (t) => {
  const { applicationServerKey } = await load()
  const key = applicationServerKey(point)
  t.ok(key instanceof Uint8Array)
  t.is(key.length, 65)
  t.is(key[0], 0x04)
  t.alike(Buffer.from(key), Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]))
  t.is(applicationServerKey(b64url(Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 7)]))), null, 'not 0x04')
  t.is(applicationServerKey(point + '='), null, 'padded')
  t.is(applicationServerKey(point.slice(0, 86)), null, 'short')
  t.is(applicationServerKey(point.slice(0, 86) + 'B'), null, 'non-zero trailing bits')
  t.is(applicationServerKey(point.slice(0, 10) + '+' + point.slice(11)), null, 'standard alphabet')
  t.is(applicationServerKey('not a key'), null)
  t.is(applicationServerKey(null), null)
})

test('subscriptionJsonOf: a valid subscription becomes a fresh triple', async (t) => {
  const { subscriptionJsonOf } = await load()
  const input = subJson()
  const out = subscriptionJsonOf(input)
  t.alike(out, { endpoint: input.endpoint, p256dh: point, auth })
  t.alike(Object.keys(out), ['endpoint', 'p256dh', 'auth'])
  t.is(subscriptionJsonOf(subJson({ endpoint: 'https://x.example/' + 'a'.repeat(2048 - 18) })).endpoint.length, 2048)
})

test('subscriptionJsonOf refuses an invalid subscription', async (t) => {
  const { subscriptionJsonOf } = await load()
  const bad = [
    null,
    'x',
    [],
    { endpoint: 'https://a.example/x' },
    subJson({ endpoint: 'http://fcm.googleapis.com/x' }),
    subJson({ endpoint: 'https://user:pw@fcm.googleapis.com/x' }),
    subJson({ endpoint: 'https://fcm.googleapis.com/x#frag' }),
    subJson({ endpoint: 'https:///x' }),
    subJson({ endpoint: 'https://a.example/x y' }),
    subJson({ endpoint: 'https://a.example/' + 'a'.repeat(2048 - 17) }),
    subJson({ endpoint: 42 }),
    subJson({ keys: { p256dh: point + '=', auth } }),
    subJson({ keys: { p256dh: point.slice(0, 86), auth } }),
    subJson({ keys: { p256dh: b64url(Buffer.concat([Buffer.from([0x03]), Buffer.alloc(64, 7)])), auth } }),
    subJson({ keys: { p256dh: point, auth: auth + '==' } }),
    subJson({ keys: { p256dh: point, auth: b64url(Buffer.alloc(17)) } }),
    subJson({ keys: { p256dh: point } }),
    subJson({ keys: null })
  ]
  for (const value of bad) t.is(subscriptionJsonOf(value), null)
})

test('pushUiState: hidden, unsupported and unavailable', async (t) => {
  const { pushUiState, PUSH_UNSUPPORTED, PUSH_UNAVAILABLE } = await load()
  t.alike(pushUiState({ support: 'not-hosted' }), { visible: false, on: false, disabled: true, note: null })
  t.alike(pushUiState({ support: 'unsupported', keyAvailable: true }), { visible: true, on: false, disabled: true, note: PUSH_UNSUPPORTED })
  t.alike(pushUiState({ support: 'ok', keyAvailable: false, permission: 'default', subscribed: false, registered: false, swUpToDate: true }),
    { visible: true, on: false, disabled: true, note: PUSH_UNAVAILABLE })
})

test('pushUiState: on only when the browser and the service agree', async (t) => {
  const { pushUiState, PUSH_UNKNOWN } = await load()
  const base = { support: 'ok', keyAvailable: true, permission: 'granted', pending: false, swUpToDate: true }
  t.alike(pushUiState({ ...base, subscribed: true, registered: true }), { visible: true, on: true, disabled: false, note: null })
  t.alike(pushUiState({ ...base, subscribed: true, registered: false }), { visible: true, on: false, disabled: false, note: null })
  t.alike(pushUiState({ ...base, subscribed: true, registered: null }), { visible: true, on: false, disabled: false, note: PUSH_UNKNOWN })
  t.alike(pushUiState({ ...base, subscribed: false, registered: null }), { visible: true, on: false, disabled: false, note: null })
  t.alike(pushUiState({ ...base, subscribed: false, registered: true }), { visible: true, on: false, disabled: false, note: null })
  t.alike(pushUiState({ ...base, permission: 'default', subscribed: false, registered: false }), { visible: true, on: false, disabled: false, note: null })
  t.alike(pushUiState({ ...base, subscribed: true, registered: true, pending: true }), { visible: true, on: true, disabled: true, note: null })
})

test('pushUiState: an outdated worker blocks turning on, a denied permission blocks both', async (t) => {
  const { pushUiState, PUSH_RELOAD, PUSH_DENIED } = await load()
  const base = { support: 'ok', keyAvailable: true, permission: 'granted', pending: false }
  t.alike(pushUiState({ ...base, subscribed: false, registered: false, swUpToDate: false }), { visible: true, on: false, disabled: true, note: PUSH_RELOAD })
  t.alike(pushUiState({ ...base, subscribed: true, registered: false, swUpToDate: false }), { visible: true, on: false, disabled: true, note: PUSH_RELOAD })
  t.alike(pushUiState({ ...base, subscribed: true, registered: true, swUpToDate: false }), { visible: true, on: true, disabled: false, note: null }, 'on can still be turned off')
  t.alike(pushUiState({ ...base, subscribed: true, registered: true, swUpToDate: false, pending: true }), { visible: true, on: true, disabled: true, note: null }, 'disabled only while pending')
  t.alike(pushUiState({ ...base, permission: 'denied', subscribed: true, registered: true, swUpToDate: true }), { visible: true, on: false, disabled: true, note: PUSH_DENIED })
  t.alike(pushUiState({ ...base, permission: 'denied', subscribed: true, registered: true, swUpToDate: false }), { visible: true, on: false, disabled: true, note: PUSH_DENIED }, 'a block wins over the reload note')
})

test('parseLaunch reads a valid launch query', async (t) => {
  const { parseLaunch } = await load()
  t.alike(parseLaunch('?aviso=reply&actor=' + actor + '&recipient=' + recipient + '&ref=' + ref), { kind: 'reply', actor, recipient, ref })
  t.alike(parseLaunch('?conta=x&aviso=like&actor=' + actor + '&recipient=' + recipient + '&ref=' + recipient + '%3A12'), { kind: 'like', actor, recipient, ref })
  t.alike(parseLaunch('?aviso=follow&actor=' + actor + '&recipient=' + recipient), { kind: 'follow', actor, recipient, ref: null })
})

test('parseLaunch refuses a planted or broken query', async (t) => {
  const { parseLaunch } = await load()
  const q = (s) => parseLaunch('?' + s)
  const other = 'c'.repeat(64)
  t.is(q('aviso=reply&actor=' + actor + '&recipient=' + recipient + '&ref=' + other + ':12'), null, 'ref author is not the recipient')
  t.is(q('aviso=reply&actor=' + actor + '&recipient=' + recipient), null, 'reply without ref')
  t.is(q('aviso=reply&actor=' + actor + '&recipient=' + recipient + '&ref=' + recipient + ':0'), null, 'seq 0')
  t.is(q('aviso=reply&actor=' + actor + '&recipient=' + recipient + '&ref=' + recipient + ':012'), null, 'leading zero')
  t.is(q('aviso=reply&actor=' + actor + '&recipient=' + recipient + '&ref=' + recipient + ':1234567890123456'), null, '16 digits')
  t.is(q('aviso=follow&actor=' + actor + '&recipient=' + recipient + '&ref=' + ref), null, 'follow with ref')
  t.is(q('aviso=follow&actor=' + actor + '&recipient=' + recipient + '&ref='), null, 'follow with empty ref')
  t.is(q('aviso=follow&actor=' + actor + '&recipient=' + actor), null, 'actor is recipient')
  t.is(q('aviso=follow&actor=' + actor.toUpperCase() + '&recipient=' + recipient), null, 'upper-case hex')
  t.is(q('aviso=mention&actor=' + actor + '&recipient=' + recipient), null, 'unknown kind')
  t.is(q('aviso=follow&aviso=follow&actor=' + actor + '&recipient=' + recipient), null, 'repeated field')
  t.is(q('aviso=follow&actor=%E0%A4%A&recipient=' + recipient), null, 'bad escape')
  t.is(q('conta=x'), null, 'no launch')
  t.is(parseLaunch(''), null)
  t.is(parseLaunch(null), null)
})

test('parseMessage reads only the worker message', async (t) => {
  const { parseMessage } = await load()
  t.alike(parseMessage({ source: 'varanda-push', kind: 'repost', actor, recipient, ref }), { kind: 'repost', actor, recipient, ref })
  t.alike(parseMessage({ source: 'varanda-push', kind: 'follow', actor, recipient, ref: null }), { kind: 'follow', actor, recipient, ref: null })
  t.is(parseMessage({ source: 'other', kind: 'repost', actor, recipient, ref }), null, 'another source')
  t.is(parseMessage({ source: 'varanda-push', kind: 'repost', actor, recipient, ref, extra: 1 }), null, 'extra key')
  t.is(parseMessage({ source: 'varanda-push', kind: 'follow', actor, recipient }), null, 'missing ref key')
  t.is(parseMessage({ source: 'varanda-push', kind: 'like', actor, recipient, ref: 'c'.repeat(64) + ':3' }), null, 'bad ref')
  t.is(parseMessage(null), null)
  t.is(parseMessage('varanda-push'), null)
})

test('stripLaunch drops the launch fields and keeps the rest in order', async (t) => {
  const { stripLaunch } = await load()
  t.is(stripLaunch('?conta=abc&aviso=follow&actor=' + actor + '&recipient=' + recipient), '?conta=abc')
  t.is(stripLaunch('?a=1&aviso=reply&b=2&ref=' + ref + '&c=3'), '?a=1&b=2&c=3')
  t.is(stripLaunch('?aviso=follow&actor=' + actor + '&recipient=' + recipient), '')
  t.is(stripLaunch('?conta=x%20y'), '?conta=x%20y')
  t.is(stripLaunch(''), '')
  t.is(stripLaunch(undefined), '')
})

const reg = { pushManager: {} }
const subA = { id: 'a' }
const endpointA = 'https://fcm.googleapis.com/fcm/send/a'
const shown = (over = {}) => ({ support: 'ok', permission: 'granted', key: 'K', registration: reg, subscribed: false, subscription: null, endpoint: null, swUpToDate: true, registered: null, ...over })

test('pushStateAfter: a turn-on shows the fresh read, not the stale snapshot', async (t) => {
  const { pushStateAfter } = await load()
  // The press saw no subscription; the step and the read agree it is on.
  const before = shown()
  const after = shown({ subscribed: true, subscription: subA, endpoint: endpointA, registered: true })
  const s = pushStateAfter({ action: 'on', result: { ok: true, subscription: subA, endpoint: endpointA }, before, after })
  t.is(s.subscribed, true)
  t.is(s.registered, true)
  t.is(s.subscription, subA)
  t.is(s.error, null)
  // The check failed after a success on the same endpoint: the step stands.
  const unchecked = pushStateAfter({ action: 'on', result: { ok: true, subscription: subA, endpoint: endpointA }, before, after: { ...after, registered: null } })
  t.is(unchecked.registered, true)
  // A refused turn-on that kept a reused subscription shows it still held.
  const kept = pushStateAfter({ action: 'on', result: { ok: false, reason: 'failed', subscription: subA }, before: shown({ subscribed: true, subscription: subA, endpoint: endpointA }), after: shown({ subscribed: true, subscription: subA, endpoint: endpointA, registered: true }) })
  t.is(kept.subscribed, true)
  t.is(kept.registered, true, 'the service still has it: on')
  t.is(kept.error, 'failed')
  // An empty key from the re-read keeps the one already shown.
  t.is(pushStateAfter({ action: 'on', result: { ok: true, subscription: subA, endpoint: endpointA }, before, after: { ...after, key: null } }).key, 'K')
})

test('pushStateAfter: a failed turn-off with the subscription still present is not shown as off', async (t) => {
  const { pushStateAfter, pushUiState } = await load()
  const before = shown({ subscribed: true, subscription: subA, endpoint: endpointA, registered: true })
  // Server refused and the browser unsubscribe also failed.
  const result = { ok: false, reason: 'failed', unsubscribed: false }
  const s = pushStateAfter({ action: 'off', result, before, after: shown({ subscribed: true, subscription: subA, endpoint: endpointA, registered: true }) })
  t.is(s.subscribed, true)
  t.is(s.registered, true)
  t.is(s.error, 'failed')
  t.is(pushUiState({ ...s, keyAvailable: true }).on, true, 'the toggle still reads on, so a tap retries turning off')
  // The re-read failed: the step's own report decides, never an assumption.
  const blind = pushStateAfter({ action: 'off', result, before, after: { support: 'ok', registration: null } })
  t.is(blind.subscribed, true)
  t.is(blind.subscription, subA)
  t.is(blind.error, 'failed')
  const uncertain = pushStateAfter({ action: 'off', result: { ok: false, reason: 'uncertain', unsubscribed: false }, before, after: null })
  t.is(uncertain.subscribed, true)
  t.is(uncertain.registered, null)
  t.is(uncertain.error, 'uncertain')
})

test('pushStateAfter: a turn-off that dropped the browser subscription shows off', async (t) => {
  const { pushStateAfter } = await load()
  const before = shown({ subscribed: true, subscription: subA, endpoint: endpointA, registered: true })
  const s = pushStateAfter({ action: 'off', result: { ok: false, reason: 'failed', unsubscribed: true }, before, after: shown() })
  t.is(s.subscribed, false)
  t.is(s.subscription, null)
  t.is(s.error, null)
  const blind = pushStateAfter({ action: 'off', result: { ok: true, unsubscribed: true }, before, after: null })
  t.is(blind.subscribed, false)
  t.is(blind.subscription, null)
  // Server row gone but the browser kept the subscription: off, no error.
  const half = pushStateAfter({ action: 'off', result: { ok: true, unsubscribed: false }, before, after: null })
  t.is(half.subscribed, true)
  t.is(half.registered, false)
  t.is(half.error, null)
})

test('pushUiState: an unreadable browser subscription is unknown, never off', async (t) => {
  const { pushUiState, PUSH_UNKNOWN, PUSH_RELOAD } = await load()
  const base = { support: 'ok', keyAvailable: true, permission: 'granted', pending: false, swUpToDate: true }
  t.alike(pushUiState({ ...base, subscribed: null, registered: null }), { visible: true, on: false, disabled: false, note: PUSH_UNKNOWN })
  t.alike(pushUiState({ ...base, subscribed: null, registered: null, pending: true }), { visible: true, on: false, disabled: true, note: PUSH_UNKNOWN })
  t.alike(pushUiState({ ...base, subscribed: null, registered: null, swUpToDate: false }), { visible: true, on: false, disabled: true, note: PUSH_RELOAD })
})

// The re-read found the worker registration but getSubscription() failed.
const unreadable = (over = {}) => shown({ subscribed: null, subscription: null, endpoint: null, registered: null, ...over })

test('pushStateAfter: a failed turn-off followed by a failed read stays unknown with its error', async (t) => {
  const { pushStateAfter, pushUiState, PUSH_UNKNOWN } = await load()
  const before = shown({ subscribed: true, subscription: subA, endpoint: endpointA, registered: true })
  const s = pushStateAfter({ action: 'off', result: { ok: false, reason: 'failed', unsubscribed: false }, before, after: unreadable() })
  t.is(s.subscribed, null, 'not off')
  t.is(s.registered, null)
  t.is(s.error, 'failed', 'the turn-off error stays shown')
  t.is(s.subscription, subA, 'the held subscription is kept')
  const ui = pushUiState({ ...s, keyAvailable: true })
  t.is(ui.on, false)
  t.is(ui.note, PUSH_UNKNOWN)
  const uncertain = pushStateAfter({ action: 'off', result: { ok: false, reason: 'uncertain', unsubscribed: false }, before, after: unreadable() })
  t.is(uncertain.subscribed, null)
  t.is(uncertain.error, 'uncertain')
  // A read failure inside disablePush itself reports the same shape.
  const unread = pushStateAfter({ action: 'off', result: { ok: false, reason: 'failed', unsubscribed: false }, before: shown({ subscribed: null }), after: unreadable() })
  t.is(unread.subscribed, null)
  t.is(unread.error, 'failed')
  // The browser confirmed the drop: off, whatever the later read says.
  const dropped = pushStateAfter({ action: 'off', result: { ok: false, reason: 'failed', unsubscribed: true }, before, after: unreadable() })
  t.is(dropped.subscribed, false)
  t.is(dropped.subscription, null)
  t.is(dropped.error, null)
})

test('pushStateAfter: a turn-on followed by a failed read keeps the step report', async (t) => {
  const { pushStateAfter } = await load()
  const ok = pushStateAfter({ action: 'on', result: { ok: true, subscription: subA, endpoint: endpointA }, before: shown(), after: unreadable() })
  t.is(ok.subscribed, true)
  t.is(ok.registered, true)
  t.is(ok.subscription, subA)
  t.is(ok.endpoint, endpointA)
  t.is(ok.error, null)
  // The failed turn-on dropped its own subscription for sure.
  const dropped = pushStateAfter({ action: 'on', result: { ok: false, reason: 'failed', subscription: null }, before: shown(), after: unreadable() })
  t.is(dropped.subscribed, false)
  t.is(dropped.error, 'failed')
  // Cleanup not confirmed: the subscription is still shown as held.
  const kept = pushStateAfter({ action: 'on', result: { ok: false, reason: 'failed', subscription: subA, endpoint: endpointA }, before: shown(), after: unreadable() })
  t.is(kept.subscribed, true)
  t.is(kept.subscription, subA)
  t.is(kept.registered, null)
  t.is(kept.error, 'failed')
})

test('nextLaunch keeps the newest valid intent, also while locked', async (t) => {
  const { nextLaunch } = await load()
  const one = { kind: 'follow', actor, recipient, ref: null }
  const two = { kind: 'like', actor, recipient, ref }
  t.is(nextLaunch({ held: one, intent: two, locked: true }), two)
  t.is(nextLaunch({ held: null, intent: one, locked: true }), one)
  t.is(nextLaunch({ held: one, intent: two, locked: false }), two)
  t.is(nextLaunch({ held: one, intent: null, locked: true }), one)
})
