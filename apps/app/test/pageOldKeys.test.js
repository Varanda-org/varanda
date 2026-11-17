'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/pageOldKeys.js')
const src = (file) => readFileSync(join(__dirname, '../src', file), 'utf8')

const K2 = '22'.repeat(32)
const K1 = '11'.repeat(32)
const K0 = '00'.repeat(32)
const J = 'ff'.repeat(32)

function chain (map) {
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (method !== 'page.read') throw new Error('unexpected ' + method)
    if (!(params.key in map)) throw new Error('sem página')
    return { movedFrom: map[params.key] }
  }
  return { request, calls }
}

test('oldPageKeys follows movedFrom, newest first, never the start key', async (t) => {
  const { oldPageKeys } = await load()
  const { request } = chain({ [K2]: { from: K1, fromSeq: 3 }, [K1]: { from: K0, fromSeq: 1 }, [K0]: null })
  t.alike(await oldPageKeys(request, K2), [K1, K0])
})

test('oldPageKeys stops at max, at a repeat, at a failed read and at a malformed movedFrom', async (t) => {
  const { oldPageKeys } = await load()
  t.alike(await oldPageKeys(chain({ [K2]: { from: K1 }, [K1]: { from: K0 }, [K0]: { from: J } }).request, K2, { max: 2 }), [K1, K0], 'max')
  t.alike(await oldPageKeys(chain({ [K2]: { from: K1 }, [K1]: { from: K2 } }).request, K2), [K1], 'a loop back to the start')
  t.alike(await oldPageKeys(chain({ [K2]: { from: K1 }, [K1]: { from: K1 } }).request, K2), [K1], 'a repeat')
  t.alike(await oldPageKeys(chain({ [K2]: { from: K1 } }).request, K2), [K1], 'a failed read keeps what was found')
  t.alike(await oldPageKeys(chain({ [K2]: { from: 'nope' } }).request, K2), [], 'not a key')
  t.alike(await oldPageKeys(chain({ [K2]: 'x' }).request, K2), [], 'not an object')
  t.alike(await oldPageKeys(chain({}).request, K2), [], 'the first read fails')
})

test('heldOldKeys keeps readable keys with a conversation and drops refused or empty ones', async (t) => {
  const { heldOldKeys } = await load()
  const request = async (method, params) => {
    t.is(method, 'dm.list')
    t.is(params.limit, 1)
    if (params.page === J) throw new Error('sem chave da página')
    if (params.page === K1) return { conversations: params.folder === 'request' ? [{ peer: 'x' }] : [] }
    if (params.page === K0) return { conversations: [] }
    return { conversations: [{ peer: 'y' }] }
  }
  t.alike(await heldOldKeys(request, [J, K1, K0, K2]), [K1, K2])
})

test('oldThreadClient reads with the old page and refuses everything else', async (t) => {
  const { oldThreadClient, OLD_KEY_READONLY } = await load()
  const calls = []
  const client = oldThreadClient({ request: async (m, p) => { calls.push([m, p]); return { ok: true } }, page: K1 })
  await client('dm.list', { folder: 'inbox' })
  await client('dm.thread', { peer: J })
  await client('dm.seen', { peer: J })
  await client('dm.pull', { page: K2, x: 1 })
  t.alike(calls, [
    ['dm.list', { folder: 'inbox', page: K1 }],
    ['dm.thread', { peer: J, page: K1 }],
    ['dm.seen', { peer: J, page: K1 }],
    ['dm.pull', {}]
  ])
  const before = calls.length
  for (const method of ['dm.send', 'dm.set', 'dm.pageDraft', 'dm.pageSend', 'dm.react', 'dm-sign', 'blocks.set']) {
    await t.exception(() => client(method, {}), new RegExp(OLD_KEY_READONLY.slice(0, 20)))
  }
  t.is(calls.length, before, 'refusals never reach request')
})

test('the screens wire the old key read-only', (t) => {
  const mensagem = src('screens/Mensagem.js')
  t.ok(mensagem.includes('oldThreadClient({ request, page: old })'), 'Mensagem reads through the old client')
  t.ok(mensagem.includes('OLD_KEY_READONLY') && mensagem.includes('if (old !== null) {\n    composer = ('), 'the composer is replaced by the read-only line')
  t.ok(mensagem.includes('mediaPage={old !== null ? old : pageKey}'), 'media reads the old key store')
  t.ok(mensagem.includes('if (!readOnly) actions.push') && mensagem.includes('canForward && !readOnly') && mensagem.includes('reportable && !readOnly'), 'only Copiar stays')
  t.ok(mensagem.includes('dispatchDisabled: reactionGate.disabled || old !== null'), 'no reactions')
  t.ok(mensagem.includes("(typeof props.oldPage === 'string' ? ':' + props.oldPage : '')"), 'its own remount identity')
  t.ok(mensagem.includes('/^[0-9a-f]{64}$/.test(oldPage) ? oldPage : null') && !mensagem.includes('.test(oldPage) && pageKey !== null'), 'an oldPage entry is read-only whoever acts')
  t.ok(mensagem.includes('buttons.rate && old === null') && mensagem.includes('loaded && !loadError && old === null'), 'no rating and no quick greetings in an old thread')
  const mensagens = src('screens/Mensagens.js')
  t.ok(mensagens.includes('/^[0-9a-f]{64}$/.test(oldPage) ? oldPage : null') && mensagens.includes("{ folder: 'request' }).catch(() => null)"), 'the old list needs no Página and keeps the inbox when requests fail')
  t.ok(mensagens.includes('OLD_KEY_NOTE') && mensagens.includes('old !== null ? OLD_KEY_TITLE'), 'Mensagens shows the old key note and title')
  t.ok(mensagens.includes('onOpenThread(item.peer, { oldPage: old })'), 'rows open an old thread')
  const conversas = src('screens/Conversas.js')
  t.ok(conversas.includes('enabled: ready && allowed && pageKey !== null'), 'Conversas reads old keys only as a Página, after the first show')
  t.ok(conversas.includes('chains.current.set(pageKey, chain)') && conversas.includes("'old-key': { label:"), 'the chain is cached and the strip names the row')
  t.ok(conversas.includes('onOpenOldKey(item.page)'), 'the row opens the old list')
})
