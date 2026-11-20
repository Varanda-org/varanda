// The pure rules of a page's device-held Conversas keys (src/pageSecrets.js).
'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/pageSecrets.js')
const O = 'aa'.repeat(32)
const A = 'bb'.repeat(32)
const B = 'cc'.repeat(32)
const P = 'dd'.repeat(32)
const BOX = 'ee'.repeat(32)

test('planShares: owner first, each once, members without a dm-key go to missing', async (t) => {
  const { planShares } = await load()
  t.alike(planShares({ owner: O, admins: [A, B, A, 'x'], boxes: { [O]: BOX, [A]: null } }), {
    recipients: [{ member: O, box: BOX }],
    missing: [A, B]
  })
  t.alike(planShares({ owner: O, admins: [A], boxes: { [O]: BOX, [A]: BOX } }).missing, [])
  t.alike(planShares(), { recipients: [], missing: [] })
  t.alike(planShares({ owner: O, admins: [], boxes: { [O]: 'not a key' } }).missing, [O])
})

test('planShares and actorBoxOf: a stated box only for a member without a dm-key, well formed', async (t) => {
  const { planShares, actorBoxOf } = await load()
  const SIG = 'ab'.repeat(64)
  const AT = '2026-11-17T12:00:00.000Z'
  const AB = 'f0'.repeat(32)
  const entry = { member: A, box: AB, gen: 3, at: AT, sig: SIG }
  const status = { actorBoxes: [entry, { member: O, box: AB, gen: 1, at: AT, sig: SIG }] }
  t.alike(actorBoxOf(status, A), { box: AB, proof: { gen: 3, at: AT, sig: SIG } })
  t.is(actorBoxOf(status, B), null)
  t.is(actorBoxOf(null, A), null)
  t.is(actorBoxOf({ actorBoxes: 'x' }, A), null)
  t.is(actorBoxOf(status, 'x'), null)
  for (const bad of [{ box: 'x' }, { box: '0'.repeat(63) }, { gen: 0 }, { gen: 1.5 }, { gen: '3' }, { at: '2026-11-17' }, { at: 5 }, { sig: 'x' }, { sig: SIG.toUpperCase() }]) {
    t.is(actorBoxOf({ actorBoxes: [{ ...entry, ...bad }] }, A), null, 'malformed: ' + JSON.stringify(bad))
  }
  t.alike(planShares({ owner: O, admins: [A, B], boxes: { [O]: BOX, [A]: null, [B]: null }, status }), {
    recipients: [{ member: O, box: BOX }, { member: A, box: AB, proof: { gen: 3, at: AT, sig: SIG } }],
    missing: [B]
  }, 'the owner keeps its dm-key, the delegate gets its stated box')
  t.alike(planShares({ owner: O, admins: [A], boxes: { [O]: BOX, [A]: BOX }, status }).recipients, [{ member: O, box: BOX }, { member: A, box: BOX }], 'a dm-key always wins')
  t.alike(planShares({ owner: O, admins: [A], boxes: { [O]: BOX, [A]: null } }).missing, [A], 'no status: missing')
})

test('nextGen: 1 for a new page, 2 for a legacy one, else gen + 1', async (t) => {
  const { nextGen, expectedGen } = await load()
  t.is(nextGen(null), 1)
  t.is(nextGen({ gen: 0, legacy: false }), 1)
  t.is(nextGen({ legacy: true }), 2)
  t.is(nextGen({ gen: 1, legacy: true }), 2)
  t.is(nextGen({ gen: 3, legacy: false }), 4)
  t.is(expectedGen({ gen: 3 }), 3)
  t.is(expectedGen({ gen: 0 }), 0)
})

test('activationSteps: import only on a legacy page', async (t) => {
  const { activationSteps } = await load()
  t.alike(activationSteps({ legacy: true }), ['import', 'generate', 'publish', 'confirm'])
  t.alike(activationSteps({ legacy: false }), ['generate', 'publish', 'confirm'])
  t.alike(activationSteps(null), ['generate', 'publish', 'confirm'])
})

test('pageDmState and hasDeviceKeys read a dm-box-read answer', async (t) => {
  const { pageDmState, hasDeviceKeys, isLegacyPage } = await load()
  const share = { gen: 2, sealed: 's', by: O, sig: 'a1'.repeat(64) }
  t.is(pageDmState(null), 'unknown')
  t.is(pageDmState({ gen: 2, groupBox: BOX, rotatePending: true, share: null }), 'rotating')
  t.is(pageDmState({ gen: 2, groupBox: BOX, share }), 'share')
  t.is(pageDmState({ gen: 0, groupBox: null, share: null }, { owner: true }), 'activate')
  t.is(pageDmState({ gen: 1, groupBox: null, legacy: false, share: null }, { owner: true }), 'activate', 'a legacy box without rows')
  t.is(pageDmState({ gen: 0, groupBox: null, share: null }), 'ask-owner')
  t.is(pageDmState({ gen: 2, groupBox: BOX, share: null }, { owner: true }), 'rotate', 'an owner without a share, as after a transfer, issues a new gen')
  t.is(pageDmState({ gen: 2, groupBox: BOX, share: null }), 'ask-owner', 'an admin still asks the owner')
  t.is(pageDmState({ gen: 2, groupBox: BOX, share: null, rotatePending: true }, { owner: true }), 'rotating')
  t.is(hasDeviceKeys({ gen: 0, groupBox: null, rotatePending: true }), false, 'a pending first rotation is no promoted gen: a move carries no dmBox')
  t.is(hasDeviceKeys({ gen: 1, groupBox: BOX }), true)
  t.is(hasDeviceKeys({ gen: 1, groupBox: null, legacy: true }), false)
  t.is(hasDeviceKeys({ gen: 0, groupBox: null }), false)
  t.is(isLegacyPage({ gen: 1, groupBox: null, legacy: false }), true)
  t.is(isLegacyPage({ gen: 1, groupBox: BOX, legacy: false }), false)
})

test('missingShares lists roster members without a current share', async (t) => {
  const { missingShares } = await load()
  t.alike(missingShares({ shared: [O] }, { owner: O, admins: [A, B] }), [A, B])
  t.alike(missingShares({}, { owner: O, admins: [A] }), [], 'an admin read has no shared list')
})

test('secretsParams and pageKeyText', async (t) => {
  const { secretsParams, pageKeyText, PAGE_DM_MISMATCH, PAGE_DM_ASK_OWNER, PAGE_DM_CONFLICT, PAGE_DM_ROTATING } = await load()
  const share = { gen: 2, sealed: 's', by: O, sig: 'a1'.repeat(64) }
  t.alike(secretsParams({ page: P, share, box: BOX, groupBox: BOX, cert: {}, legacy: { sealed: 'L', gen: 1 } }), { page: P, gen: 2, sealed: 's', by: O, sig: share.sig, box: BOX, groupBox: BOX, cert: {} }, 'no legacy envelope any more')
  t.is(secretsParams({ page: P, share, box: BOX, groupBox: null, cert: {} }), null)
  t.is(pageKeyText(new Error('chave da página não confere')), PAGE_DM_MISMATCH)
  t.is(pageKeyText(new Error('sem chave da página')), PAGE_DM_ASK_OWNER)
  t.is(pageKeyText(Object.assign(new Error('x'), { code: 'conflito' })), PAGE_DM_CONFLICT)
  t.is(pageKeyText(Object.assign(new Error('x'), { code: 'rotacao-necessaria' })), PAGE_DM_ROTATING)
  t.is(pageKeyText(new Error('outro')), '')
})

test('pageSecrets.js stays pure', (t) => {
  const src = readFileSync(join(__dirname, '../src/pageSecrets.js'), 'utf8')
  t.absent(src.split('\n').some((l) => l.startsWith('import ')))
  t.absent(src.includes(String.fromCharCode(0x2014)))
})

test('legacy bundle and card: the import first, then the pending blocks', async (t) => {
  const { legacyBundleOf, legacyCardLabel, reapplyBlocksLabel, PAGE_DM_LEGACY_IMPORT } = await load()
  t.alike(legacyBundleOf({ legacyBundle: { id: BOX, count: 3, extra: 1 } }), { id: BOX, count: 3 })
  t.is(legacyBundleOf({ legacyBundle: null }), null)
  t.is(legacyBundleOf({ legacyBundle: { id: 'x', count: 3 } }), null)
  t.is(legacyBundleOf({ legacyBundle: { id: BOX, count: 0 } }), null)
  t.is(legacyBundleOf({ legacyBundle: { id: BOX, count: 1025 } }), null)
  t.is(legacyBundleOf(null), null)
  t.is(PAGE_DM_LEGACY_IMPORT, 'Concluir a importação das conversas antigas')
  t.is(legacyCardLabel({ bundle: { id: BOX, count: 1 }, pending: 2 }), PAGE_DM_LEGACY_IMPORT)
  t.is(legacyCardLabel({ bundle: null, pending: 2 }), 'Reaplicar 2 bloqueios antigos')
  t.is(legacyCardLabel({ bundle: null, pending: 0 }), null)
  t.is(legacyCardLabel(), null)
  t.is(reapplyBlocksLabel(1), 'Reaplicar 1 bloqueio antigo')
})

test('no per-device done list, no import batches', async (t) => {
  const mod = await load()
  for (const name of ['blocksDone', 'noteBlockDone', 'legacyBlocksKey', 'pendingBlocks', 'legacyRow', 'importBatches']) t.absent(Object.hasOwn(mod, name), name)
})

test('a new owner after a transfer rotates: the next gen is current + 1, expected the current one', async (t) => {
  const { pageDmState, nextGen, expectedGen, isLegacyPage, activationSteps, PAGE_DM_ROTATE_TITLE } = await load()
  const status = { gen: 3, box: BOX, groupBox: BOX, share: null, legacy: false, rotatePending: false, shared: [A] }
  t.is(pageDmState(status, { owner: true }), 'rotate')
  t.is(nextGen(status), 4)
  t.is(expectedGen(status), 3)
  t.absent(isLegacyPage(status))
  t.alike(activationSteps(status), ['generate', 'publish', 'confirm'])
  t.is(PAGE_DM_ROTATE_TITLE, 'Gerar nova chave da página')
})

test('pageKeysOf: a read for another page counts as none', async (t) => {
  const { pageKeysOf, PAGE_KEYS_IDLE } = await load()
  const a = { ...PAGE_KEYS_IDLE, page: P, phase: 'activate', status: { gen: 0 }, roster: { owner: O }, member: O }
  t.is(pageKeysOf(a, P), a)
  const b = pageKeysOf(a, A)
  t.is(b.page, A)
  t.is(b.phase, 'idle')
  t.is(b.status, null)
  t.is(b.roster, null)
  t.is(b.member, null)
  t.alike(b.peers, [])
  t.is(pageKeysOf(a, null).phase, 'idle')
  t.is(pageKeysOf(null, P).phase, 'idle')
})

test('blockPeersLine names each peer once, @nome when known, else the short key', async (t) => {
  const { blockPeersLine } = await load()
  const names = { [A]: '@ana' }
  t.is(blockPeersLine([A, B, A, 'x'], (k) => names[k] || null), 'Serão bloqueados de novo: @ana, ' + B.slice(0, 8))
  t.is(blockPeersLine([], () => '@x'), '')
  t.is(blockPeersLine(null), '')
  t.is(blockPeersLine([B]), 'Serão bloqueados de novo: ' + B.slice(0, 8))
})

test('mismatch notes: a page is noted once, cleared once, and the same Set comes back when nothing changes', async (t) => {
  const { NO_PAGE_MISMATCH, notePageMismatch, clearPageMismatch, pageMismatchNote, PAGE_DM_MISMATCH } = await load()
  const one = notePageMismatch(NO_PAGE_MISMATCH, P)
  t.not(one, NO_PAGE_MISMATCH)
  t.is(NO_PAGE_MISMATCH.size, 0, 'the empty Set is never changed')
  t.is(notePageMismatch(one, P), one, 'a repeated event renders nothing new')
  t.is(notePageMismatch(one, 'not a key'), one)
  t.is(pageMismatchNote(one, P), PAGE_DM_MISMATCH)
  t.is(pageMismatchNote(one, O), '')
  t.is(pageMismatchNote(null, P), '')
  t.is(clearPageMismatch(one, O), one)
  const none = clearPageMismatch(one, P)
  t.is(none.size, 0)
  t.is(one.size, 1, 'the old Set is left as it was')
  t.is(notePageMismatch(undefined, P).has(P), true)
})

test('pagesNoLongerRun: closed pages, and pages named before or flagged that the list dropped, go once', async (t) => {
  const { pagesRun, pagesNoLongerRun } = await load()
  const list = { owned: [{ page: O, closed: false, movedTo: null }, { page: B, closed: true, movedTo: null }], admin: [{ page: A, closed: true, movedTo: P }], invites: [{ page: P }] }
  t.alike(pagesRun(list), { run: [O, A], closed: [B] }, 'a moved page is still run; invites never count')
  t.alike(pagesNoLongerRun(list), { run: [O, A], gone: [B] }, 'a closed page goes')
  t.alike(pagesNoLongerRun(list, { before: [O, A, P] }).gone, [B, P], 'a page an earlier list named goes')
  t.alike(pagesNoLongerRun(list, { also: new Set([P, O]) }).gone, [B, P], 'a flagged page goes only when not run')
  t.alike(pagesNoLongerRun(list, { also: [P, P], before: [P] }).gone, [B, P], 'once each')
  t.alike(pagesNoLongerRun(list, { before: [P], tried: new Set([B, P]) }).gone, [], 'a page tried this session is not tried again')
  t.alike(pagesNoLongerRun({ owned: [], admin: [] }, { before: [O] }), { run: [], gone: [O] })
  t.is(pagesNoLongerRun({ owned: [] }, { before: [O] }), null, 'a malformed answer forgets nothing')
  t.is(pagesNoLongerRun({ owned: [{ page: 'x' }], admin: [] }, { before: [O] }), null, 'a malformed row forgets nothing')
  t.is(pagesNoLongerRun(null), null)
})

test('actingPageStopped: a closed, moved or no longer run page stops; a run page, the new key and a malformed answer do not', async (t) => {
  const { actingPageStopped } = await load()
  const list = { owned: [{ page: O }, { page: B, closed: true, movedTo: null }], admin: [{ page: A, closed: true, movedTo: P }, { page: P }], invites: [] }
  t.is(actingPageStopped(list, O), false, 'a page still run stays')
  t.is(actingPageStopped(list, P), false, 'the new key after a move stays')
  t.is(actingPageStopped(list, B), true, 'a closed page stops')
  t.is(actingPageStopped(list, A), true, 'the old key of a moved page stops')
  t.is(actingPageStopped(list, BOX), true, 'a page the list no longer shows stops')
  t.is(actingPageStopped({ owned: [], admin: [] }, O), true, 'a member who runs none stops')
  t.is(actingPageStopped({ owned: [] }, O), false, 'a malformed answer changes nothing')
  t.is(actingPageStopped(null, O), false)
  t.is(actingPageStopped(list, 'x'), false, 'not a key')
})
