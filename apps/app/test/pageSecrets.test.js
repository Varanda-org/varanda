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
