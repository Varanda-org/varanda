'use strict'

// Entrar with a passkey that opens no account, the pure part
// (src/emptyAccount.js): the status-gated lookup of a passkey without a user
// handle, the `empty` mark and the card's two buttons, every effect
// injected. No network, no React. Plus the wiring the provider and the
// screen keep (source checks, as passkeysScreen.test.js does).
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/emptyAccount.js')
const OWN = 'aa'.repeat(32)
const MEMBER = 'bb'.repeat(32)
const LOOKUP = 'cc'.repeat(32)
const NEW_HERE = { exists: false, publicKey: null }
const BLOB = { v: 1, kind: 'passkey' }

// A fake handle and account service: what was asked, in order.
function world ({ status = { linked: false }, entry = null, fetchFails = false, statusFails = false, wrappedFails = null } = {}) {
  const calls = []
  return {
    calls,
    accountStatus: async (key) => { calls.push(['status', key]); if (statusFails) throw new Error('offline'); return status },
    recoveryFetch: async (id) => { calls.push(['fetch', id]); if (fetchFails) throw new Error('indisponivel'); return entry },
    direct: async () => { calls.push(['direct']); return { publicKey: OWN, created: false } },
    wrapped: async (arg) => {
      calls.push(['wrapped', arg])
      if (wrappedFails) throw Object.assign(new Error('x'), { code: wrappedFails })
      return { publicKey: arg.member, created: false }
    }
  }
}
const held = { check: true, publicKey: OWN, lookupId: LOOKUP }

test('keyState and newHere', async (t) => {
  const { keyState, newHere } = await load()
  t.is(keyState({ linked: false }), 'free')
  t.is(keyState({ linked: true, username: 'ana' }), 'taken')
  t.is(keyState({ linked: false, deleted: 'pendente' }), 'taken')
  t.is(keyState({ linked: false, unavailable: true }), 'taken', 'a Página key is not a free one')
  for (const v of [null, undefined, {}, 'x', { linked: 'no' }]) t.is(keyState(v), 'unknown')
  t.ok(newHere(NEW_HERE, OWN))
  t.absent(newHere({ exists: true, publicKey: OWN }, OWN), 'a diary that was here before')
  t.absent(newHere(null, OWN), 'an unread status is not new')
  t.absent(newHere(NEW_HERE, 'zz'))
})

test('no handle, key not linked, entry found: opens the member identity', async (t) => {
  const { settleSignIn } = await load()
  const w = world({ entry: { member: MEMBER, blob: BLOB } })
  const out = await settleSignIn(held, { before: NEW_HERE, ...w })
  t.alike(out, { publicKey: MEMBER, created: false }, 'the member, not a new identity')
  t.alike(w.calls, [['status', OWN], ['fetch', LOOKUP], ['wrapped', { blob: BLOB, member: MEMBER }]], 'status first, then the lookup')
})

test('no handle, key not linked, recovery 404: direct install marked empty', async (t) => {
  const { settleSignIn } = await load()
  const w = world({ entry: null })
  t.alike(await settleSignIn(held, { before: NEW_HERE, ...w }), { publicKey: OWN, created: false, empty: true })
  t.alike(w.calls, [['status', OWN], ['fetch', LOOKUP], ['direct']])
  const again = world({ entry: null })
  t.alike(await settleSignIn(held, { before: { exists: true, publicKey: OWN }, ...again }), { publicKey: OWN, created: false }, 'no card for a diary that was here before')
})

test('no handle, key linked, deleted or a Página: direct install, nothing fetched', async (t) => {
  const { settleSignIn } = await load()
  for (const status of [{ linked: true, username: 'ana' }, { linked: false, deleted: 'concluida' }, { linked: false, unavailable: true }]) {
    const w = world({ status })
    t.alike(await settleSignIn(held, { before: NEW_HERE, ...w }), { publicKey: OWN, created: false })
    t.alike(w.calls, [['status', OWN], ['direct']], JSON.stringify(status) + ': no lookup id sent')
  }
})

test('no handle, status unreadable: direct install as before, no card', async (t) => {
  const { settleSignIn } = await load()
  const unread = world({ statusFails: true })
  t.alike(await settleSignIn(held, { before: NEW_HERE, ...unread }), { publicKey: OWN, created: false })
  t.alike(unread.calls, [['status', OWN], ['direct']], 'no fetch when the status is unknown')
  const odd = world({ status: { linked: 'maybe' } })
  t.alike(await settleSignIn(held, { before: NEW_HERE, ...odd }), { publicKey: OWN, created: false })
  t.alike(odd.calls, [['status', OWN], ['direct']])
})

test('no handle, key free, the lookup fails or the blob does not open: the direct install gets the card', async (t) => {
  const { settleSignIn } = await load()
  const down = world({ fetchFails: true })
  t.alike(await settleSignIn(held, { before: NEW_HERE, ...down }), { publicKey: OWN, created: false, empty: true }, 'a failed lookup')
  t.alike(down.calls, [['status', OWN], ['fetch', LOOKUP], ['direct']])
  const bad = world({ entry: { member: MEMBER, blob: BLOB }, wrappedFails: 'RECOVERY_BAD' })
  t.alike(await settleSignIn(held, { before: NEW_HERE, ...bad }), { publicKey: OWN, created: false, empty: true }, 'a blob that does not open')
  const known = world({ fetchFails: true })
  t.alike(await settleSignIn(held, { before: { exists: true, publicKey: OWN }, ...known }), { publicKey: OWN, created: false }, 'no card for a diary that was here before')
})

test('no handle, other refusals of the blob stand', async (t) => {
  const { settleSignIn } = await load()
  const other = world({ entry: { member: MEMBER, blob: BLOB }, wrappedFails: 'MISMATCH' })
  t.is((await settleSignIn(held, { before: NEW_HERE, ...other }).catch((e) => e)).code, 'MISMATCH')
  t.absent(other.calls.some((c) => c[0] === 'direct'))
})

test('a newer sign-in makes the settle stop with null', async (t) => {
  const { settleSignIn } = await load()
  const w = world({ entry: { member: MEMBER, blob: BLOB } })
  t.is(await settleSignIn(held, { before: NEW_HERE, ...w, stale: () => true }), null)
  t.alike(w.calls, [['status', OWN]], 'nothing fetched or installed')
})

test('a plain sign-in: empty only for a key new here without an account', async (t) => {
  const { settleSignIn } = await load()
  const plain = { publicKey: OWN, created: false }
  let w = world()
  t.alike(await settleSignIn(plain, { before: NEW_HERE, ...w }), { ...plain, empty: true }, 'a fresh unlinked identity')
  t.alike(w.calls, [['status', OWN]], 'a status read, never a fetch')
  w = world()
  t.alike(await settleSignIn(plain, { before: { exists: true, publicKey: OWN }, ...w }), plain, 'not new here')
  t.alike(w.calls, [], 'no status read')
  w = world()
  t.alike(await settleSignIn(plain, { before: null, ...w }), plain, 'status unknown before: no card')
  w = world({ status: { linked: true, username: 'ana' } })
  t.alike(await settleSignIn(plain, { before: NEW_HERE, ...w }), plain, 'linked')
  w = world({ status: { linked: false, deleted: 'pendente' } })
  t.alike(await settleSignIn(plain, { before: NEW_HERE, ...w }), plain, 'deleted keeps its own flow')
  w = world({ statusFails: true })
  t.alike(await settleSignIn(plain, { before: NEW_HERE, ...w }), plain, 'status unreadable')
  w = world()
  t.alike(await settleSignIn({ publicKey: OWN, created: true }, { before: NEW_HERE, ...w }), { publicKey: OWN, created: true }, 'a creation never')
  for (const r of [{ pending: true }, { wrapped: true, lookupId: LOOKUP }, { needsPasskey: true }, null]) {
    t.alike(await settleSignIn(r, { before: NEW_HERE, ...world() }), r)
  }
})

test('the card shows only for the identity it was raised for', async (t) => {
  const { emptyCardShown } = await load()
  const unlocked = (publicKey, exists = true) => ({ unlocked: true, exists, publicKey })
  t.ok(emptyCardShown(OWN, { locked: false, status: unlocked(OWN) }), 'that identity, unlocked')
  t.ok(emptyCardShown(OWN, { locked: false, status: unlocked(null, false) }), 'unlocked, its diary not made yet')
  t.absent(emptyCardShown(OWN, { locked: false, status: unlocked(MEMBER) }), 'another identity signed in since')
  t.absent(emptyCardShown(OWN, { locked: true, status: unlocked(OWN) }), 'locked')
  t.absent(emptyCardShown(OWN, { locked: false, status: { unlocked: false, exists: false, publicKey: null } }), 'not unlocked')
  t.absent(emptyCardShown(OWN, { locked: false, status: null }))
  t.absent(emptyCardShown(null, { locked: false, status: unlocked(OWN) }), 'no card raised')
})

test('the key a result raises the card for; none after a creation reset', async (t) => {
  const { emptyKeyOf } = await load()
  t.is(emptyKeyOf({ publicKey: OWN, created: false, empty: true }), OWN)
  t.is(emptyKeyOf({ publicKey: OWN, created: false, empty: true }, { afterCreateReset: true }), null, 'MISMATCH, recomeçar, Entrar: the creation goes on')
  for (const r of [{ publicKey: OWN, created: false }, { empty: true }, null]) t.is(emptyKeyOf(r), null)
})

test('the card buttons: forget then sign in, or go on', async (t) => {
  const { chooseEmpty, EMPTY_TITLE, EMPTY_TEXT, EMPTY_OTHER_LABEL, EMPTY_CREATE_LABEL } = await load()
  t.is(EMPTY_TITLE, 'Esta passkey não abriu nenhuma conta')
  t.is(EMPTY_TEXT, 'Ela não está ligada a nenhuma conta do Varanda neste endereço. Se você tem outra passkey do Varanda, entre com ela. Para começar uma conta nova com esta passkey, siga em frente.')
  t.is(EMPTY_OTHER_LABEL, 'Entrar com outra passkey')
  t.is(EMPTY_CREATE_LABEL, 'Criar conta com ela')
  for (const s of [EMPTY_TITLE, EMPTY_TEXT, EMPTY_OTHER_LABEL, EMPTY_CREATE_LABEL]) t.absent(s.includes('\u2014'))
  const log = []
  const fx = { forget: async () => log.push('forget'), signIn: () => log.push('signIn'), proceed: () => log.push('proceed') }
  await chooseEmpty('other', fx)
  t.alike(log, ['forget', 'signIn'])
  log.length = 0
  await chooseEmpty('other', { ...fx, canSignIn: () => false })
  t.alike(log, ['forget'], 'without the tap activation: forgotten, Entrar left to the next tap')
  log.length = 0
  await chooseEmpty('create', fx)
  t.alike(log, ['proceed'], 'nothing forgotten')
  log.length = 0
  const failed = await chooseEmpty('other', { ...fx, forget: async () => { throw new Error('não deu') } }).catch((e) => e)
  t.is(failed.message, 'não deu')
  t.alike(log, [], 'no sign-in after a failed forget')
})

test('wiring: hosted Entrar passes check and settles; the screen holds the card', (t) => {
  const node = fs.readFileSync(path.join(__dirname, '../src/node.js'), 'utf8')
  const unlock = node.slice(node.indexOf('const pkUnlock = useCallback'), node.indexOf('const pkComplete ='))
  t.ok(unlock.includes("passkeyOp('unlock', { ...opts, check: true })"), 'hosted sign-ins ask for the check')
  t.ok(unlock.includes('if (!hosted) return passkeyOp(\'unlock\', opts).then(resolveWrapped)'), 'manual setups unchanged')
  t.ok(unlock.includes("direct: () => passkeyOp('unlockDirect')"))
  t.ok(/IDENTITY_OPS = new Set\(\[[^\]]*'unlockDirect'/.test(node))
  t.ok(node.includes('result.check === true'), 'a held check installs nothing')
  const screen = fs.readFileSync(path.join(__dirname, '../src/screens/Identidade.js'), 'utf8')
  const success = screen.slice(screen.indexOf('setNoCredential(false)\n        // A card raised'), screen.indexOf('await afterUnlock()\n      }, (err) => {'))
  t.ok(success.indexOf('passkey.setEmptyCard(null)') !== -1 && success.indexOf('passkey.setEmptyCard(null)') < success.indexOf('if (empty !== null) return passkey.setEmptyCard(empty)'), 'an earlier card is cleared, then the card before afterUnlock')
  t.ok(success.includes('emptyKeyOf(r, { afterCreateReset })'))
  t.ok(screen.includes('emptyCardShown(emptyKey, { locked, status: pkStatus })'), 'the card only for its own identity')
  t.ok(screen.includes('createResetRef.current = mismatch !== null && mismatch.signUp === true'))
  t.ok(screen.includes("signUp: created === true && mode !== 'finish'"), 'a code recovery\'s MISMATCH is no sign-up')
  const rejected = screen.slice(screen.indexOf('await afterUnlock()\n      }, (err) => {'), screen.indexOf('pkFail(err, created, mode)'))
  t.ok(rejected.includes('createResetRef.current = false'), 'a failed sign-in ends the skip')
  t.ok(unlock.includes("if (r && r.check === true && !stale()) passkeyOp('cancelRecovery').catch(() => {})"), 'a refused settle drops the held output')
  t.ok(screen.includes("const known = mode !== 'card' &&"), 'Entrar from the card names no lost passkey')
  const other = screen.slice(screen.indexOf('const onEmptyOther'), screen.indexOf('const onEmptyCreate'))
  t.ok(other.includes("passkey.unlock({ any: true }), false, false, 'card')"))
  t.ok(other.includes('if (forgot) passkey.setEmptyCard(null)'), 'a failed forget keeps the card')
  t.ok(screen.includes("chooseEmpty('create', { proceed: afterUnlock })"), 'Criar conta com ela goes on as before')
  t.ok(screen.includes('await passkey.reset()') && screen.includes('canSignIn: tapActive'))
  t.absent(screen.slice(screen.indexOf('const onEmptyOther'), screen.indexOf('const onEmptyCreate')).includes('Platform.OS'))
})

test('wiring: the card lives in the shared passkey context, so the shell renders it before the Termos gate', (t) => {
  const node = fs.readFileSync(path.join(__dirname, '../src/node.js'), 'utf8')
  t.ok(node.includes('const [emptyCard, setEmptyCardKey] = useState(null)'), 'the provider holds the card')
  t.ok(node.includes("const setEmptyCard = useCallback((key) => setEmptyCardKey(typeof key === 'string' ? key : null), [])"))
  const op = node.slice(node.indexOf('const passkeyOp = useCallback'), node.indexOf('await readPasskey(conn, changed)'))
  t.ok(op.includes('if (changed) setEmptyCardKey(null)'), 'a sign-in, lock, sign-out or reset clears it')
  t.ok(node.includes('recovering, beginRecovery, endRecovery, recover, emptyCard, setEmptyCard }'), 'exposed with the recovery')
  t.ok(node.includes('emptyCard: null,\n        setEmptyCard: () => {}'), 'the fixture node has none')
  const screen = fs.readFileSync(path.join(__dirname, '../src/screens/Identidade.js'), 'utf8')
  t.absent(/\[emptyKey, setEmptyKey\] = useState/.test(screen), 'no screen-local card: a remount would lose it')
  t.ok(screen.includes("const emptyKey = passkey !== null && typeof passkey.emptyCard === 'string' ? passkey.emptyCard : null"))
  const create = screen.slice(screen.indexOf('const onEmptyCreate'), screen.indexOf('// A profile invite (App.js'))
  t.ok(create.indexOf('passkey.setEmptyCard(null)') !== -1 && create.indexOf('passkey.setEmptyCard(null)') < create.indexOf("chooseEmpty('create'"), 'Criar conta com ela takes the card down first')
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes('const emptyCard = passkey !== null ? passkey.emptyCard : null'))
  t.ok(app.includes('const recoverProbe = recoverView({ hosted: mode === \'hosted\', locked, member, claim: terms.claim, decision, card: emptyCard, status: pkStatus })'), 'the probe sees the card')
  t.ok(app.includes('decision, card: emptyCard, status: pkStatus, recovering: passkey !== null && passkey.recovering === true, elapsedMs: recoverElapsed }).wait'), 'the wait sees the card')
  t.ok(app.includes("const gateDecision = recoverProbe.card ? 'accepted' : (held.wait || recoverWait ? 'loading' : (modePass ? 'accepted' : decision))"), 'the card renders the shell')
})
