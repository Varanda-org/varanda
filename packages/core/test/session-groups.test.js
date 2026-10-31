'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createClient, createServerDispatcher, validateResponse, validateEvent } = require('@varanda/rpc')
const { tmpDir } = require('./helpers/tmp')
const { newSession, failure } = require('./helpers/net')
const { createCert, createIssuerCert, createUsernameRecord } = require('../lib/cert')
const { groupJoinRecord } = require('../lib/records')
const member = require('../lib/member')
const store = require('../lib/store')

const BOOTSTRAP = ['127.0.0.1:49737']
const OTHER = 'ab'.repeat(32)
const hex = (key) => b4a.toString(key, 'hex')

async function connect (t, session, { timeoutMs = 90000, hold = null } = {}) {
  const requests = []
  const held = []
  const events = []
  const dispatcher = createServerDispatcher({
    handlers: session.handlers,
    send (message, text) {
      if (message.event) {
        t.ok(validateEvent(message).ok, 'valid event envelope')
        events.push({ event: message.event, data: message.data })
      } else {
        t.ok(validateResponse(message).ok, 'valid response envelope')
        if (requests.some((r) => r.id === message.id && r.method === hold)) {
          held.push(message)
          return
        }
      }
      queueMicrotask(() => client.receive(JSON.parse(text)))
    },
    onProtocolError: () => t.fail('unexpected protocol error')
  })
  const client = createClient({
    timeoutMs,
    send (message, text) {
      requests.push(message)
      queueMicrotask(() => dispatcher.receive(JSON.parse(text)))
    }
  })
  session.attach(dispatcher.emit)
  t.teardown(() => {
    client.close()
    dispatcher.close()
  }, { force: true })
  await client.request('session.open')
  return { call: (method, params) => client.request(method, params), client, events, requests, held }
}

async function person (t, { kp = crypto.keyPair(), name = 'Ana', cert = true } = {}) {
  const dataDir = tmpDir(t)
  const association = hex(kp.publicKey)
  const session = newSession(t, { dataDir, association, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  if (cert) {
    await link.call('cert.add', { cert: createCert({ member: publicKey }, kp) })
    await link.call('profile.set', { name })
  }
  return { dataDir, association, session, publicKey, kp, ...link }
}

// Replication uses in-process streams, without opening sockets or a DHT.
async function exchange (from, to) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  let left
  let right
  try {
    const copies = []
    for await (const dk of a.list()) {
      const source = a.get({ discoveryKey: dk, writable: false })
      await source.ready()
      const target = b.get({ key: source.key, writable: false })
      await target.ready()
      copies.push({ source, target })
    }
    left = a.replicate(true)
    right = b.replicate(false)
    left.pipe(right).pipe(left)
    for (const { source, target } of copies) {
      for (let seq = 0; seq < source.contiguousLength; seq++) {
        await target.get(seq, { raw: true, timeout: 10000 })
      }
    }
  } finally {
    if (left) left.destroy()
    if (right) right.destroy()
    await b.close()
    await a.close()
  }
}

async function headerTime (m, group) {
  return member.withIdentity(m, async ({ store: s }) => {
    const local = store.readGroups(m.dataDir).find((g) => g.group === group)
    const core = await store.openGroupWriter(s, local.nonce)
    return (await core.get(0)).at
  })
}

test('group create, idempotent join, list, info and members expose every field', async (t) => {
  const m = await person(t)
  const issuer = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuer.publicKey) }, m.kp)
  await m.call('username.add', { record: createUsernameRecord({ member: m.publicKey, username: 'ana' }, issuer, issuerCert) })
  t.alike(await m.call('group.list'), { groups: [], total: 0 })
  const created = await m.call('group.create', { name: 'Horta', join: 'open' })
  t.alike(Object.keys(created), ['group'])
  t.ok(/^[0-9a-f]{64}$/.test(created.group))
  const { group } = created
  const log = await m.call('log.read')
  t.alike(await m.call('group.join', { group }), { state: 'member' })
  t.alike(await m.call('group.join', { group }), { state: 'member' })
  t.alike(await m.call('log.read'), log, 'joining again appends no diary record')
  const summary = { group, name: 'Horta', join: 'open', role: 'creator', members: 1 }
  t.alike(await m.call('group.list'), { groups: [summary], total: 1 })
  t.alike(await m.call('group.list', { offset: 1, limit: 1 }), { groups: [], total: 1 })
  t.alike(await m.call('group.info', { group }), { ...summary, creator: m.publicKey, state: 'member', communities: [], visibility: 'public' })
  t.alike(await m.call('group.members', { group }), {
    members: [{ member: m.publicKey, name: 'Ana', username: 'ana', admin: true, banned: false, joinedAt: await headerTime(m, group) }],
    total: 1
  })
  t.alike(await m.call('group.members', { group, offset: 1 }), { members: [], total: 1 })
  t.alike(await m.call('group.requests', { group }), { requests: [], total: 0 })
  t.alike(await m.call('group.read', { group }), { items: [], next: null, hidden: 0, incomplete: false, sealed: 0, epoch: null, state: 'ok' })
  t.alike(m.events, Array.from({ length: 3 }, () => ({ event: 'groups.changed', data: { group } })))
  t.alike(m.session.internal, [])
})

test('group posts serialize, page with cursors and retain hidden items', async (t) => {
  const m = await person(t)
  const { group } = await m.call('group.create', { name: 'Horta', join: 'open' })
  const replyTo = { writer: group, seq: 1 }
  t.alike(await Promise.all([
    m.call('group.post', { group, text: 'um' }),
    m.call('group.post', { group, text: 'dois', replyTo }),
    m.call('group.post', { group, text: 'três' })
  ]), [{ seq: 1 }, { seq: 2 }, { seq: 3 }])
  const page = await m.call('group.read', { group, limit: 2 })
  t.is(page.items.length, 2)
  for (const [index, text] of ['três', 'dois'].entries()) {
    const item = page.items[index]
    t.is(new Date(item.at).toISOString(), item.at)
    t.alike(item, {
      writer: group,
      diary: m.publicKey,
      seq: 3 - index,
      at: item.at,
      text,
      replyTo: index === 1 ? replyTo : null,
      hidden: false,
      name: 'Ana',
      username: null
    })
  }
  t.alike(page.next, { at: page.items[1].at, writer: group, seq: 2 })
  t.is(page.hidden, 0)
  t.is(page.incomplete, false)
  const older = await m.call('group.read', { group, limit: 2, before: page.next })
  t.alike(older, {
    items: [{ writer: group, diary: m.publicKey, seq: 1, at: older.items[0].at, text: 'um', replyTo: null, hidden: false, name: 'Ana', username: null }],
    next: null,
    hidden: 0,
    incomplete: false,
    sealed: 0,
    epoch: null,
    state: 'ok'
  })
  t.alike(await m.call('group.hide', { group, target: { writer: group, seq: 2 }, on: true }), { ok: true })
  const hidden = await m.call('group.read', { group, limit: 2 })
  t.alike(hidden, { ...page, items: [page.items[0], { ...page.items[1], text: '', hidden: true }], hidden: 1 })
  t.alike(await m.call('group.hide', { group, target: { writer: group, seq: 2 }, on: false }), { ok: true })
  t.alike(await m.call('group.read', { group, limit: 2 }), page)
  await member.withIdentity(m, async ({ diary }) => {
    await store.appendRecord(diary, groupJoinRecord({ group, writer: OTHER, on: true }))
  })
  t.alike(await m.call('group.read', { group, limit: 2 }), { ...page, incomplete: true })
  t.alike(m.session.internal, [])
})

test('group requests, admission, administration, bans, metadata and leave through RPC', async (t) => {
  const a = await person(t)
  const b = await person(t, { kp: a.kp, name: 'Bia' })
  const { group } = await a.call('group.create', { name: 'Horta', join: 'approval' })
  await exchange(a, b)
  t.alike(await b.call('group.join', { group }), { state: 'requested' })
  const log = await b.call('log.read')
  t.alike(await b.call('group.join', { group }), { state: 'requested' })
  t.alike(await b.call('log.read'), log)
  const denied = { code: 'USAGE', message: 'sem permissão no grupo' }
  t.alike(await failure(b.call('group.post', { group, text: 'cedo' })), denied)
  t.alike(await failure(b.call('group.requests', { group })), denied)
  await exchange(b, a)
  const joinedAt = await headerTime(b, group)
  t.alike(await a.call('group.requests', { group }), {
    requests: [{ member: b.publicKey, name: 'Bia', username: null, at: joinedAt }], total: 1
  })
  t.alike(await a.call('group.requests', { group, offset: 1, limit: 1 }), { requests: [], total: 1 })
  t.alike(await a.call('group.admit', { group, member: b.publicKey, on: true }), { ok: true })
  t.alike(await a.call('group.requests', { group }), { requests: [], total: 0 })
  await exchange(a, b)
  const { seq } = await b.call('group.post', { group, text: 'olá' })
  await exchange(b, a)
  const writer = store.readGroups(b.dataDir)[0].writer
  const read = await a.call('group.read', { group })
  t.alike(read, {
    items: [{ writer, diary: b.publicKey, seq, at: read.items[0].at, text: 'olá', replyTo: null, hidden: false, name: 'Bia', username: null }],
    next: null,
    hidden: 0,
    incomplete: false,
    sealed: 0,
    epoch: null,
    state: 'ok'
  })
  t.alike(await a.call('group.admin', { group, member: b.publicKey, on: true }), { ok: true })
  const admins = await a.call('group.members', { group })
  t.is(admins.total, 2)
  t.alike(admins.members.find((m) => m.member === b.publicKey), {
    member: b.publicKey, name: 'Bia', username: null, admin: true, banned: false, joinedAt
  })
  t.alike(await failure(a.call('group.ban', { group, member: b.publicKey, on: true })), denied)
  t.alike(await a.call('group.admin', { group, member: b.publicKey, on: false }), { ok: true })
  t.alike(await a.call('group.ban', { group, member: b.publicKey, on: true }), { ok: true })
  t.alike((await a.call('group.members', { group })).members.find((m) => m.member === b.publicKey), {
    member: b.publicKey, name: 'Bia', username: null, admin: false, banned: true, joinedAt
  })
  t.alike(await a.call('group.ban', { group, member: b.publicKey, on: false }), { ok: true })
  t.alike(await a.call('group.meta', { group, name: 'Jardim', join: 'open' }), { ok: true })
  t.alike(await a.call('group.info', { group }), {
    group, name: 'Jardim', join: 'open', creator: a.publicKey, role: 'creator', members: 2, state: 'member', communities: [], visibility: 'public'
  })
  await exchange(a, b)
  t.alike(await b.call('group.leave', { group }), { state: 'left' })
  t.alike(await b.call('group.leave', { group }), { state: 'left' }, 'a repeated leave answers the state and writes nothing')
  t.alike(await failure(b.call('group.post', { group, text: 'depois' })), denied)
  t.alike(await b.call('group.info', { group }), {
    group, name: 'Jardim', join: 'open', creator: a.publicKey, role: 'left', members: 1, state: 'left', communities: [], visibility: 'public'
  })
  t.alike([a.session.internal, b.session.internal], [[], []])
})

test('group errors map to USAGE and NOT_FOUND without leaking internals', async (t) => {
  const m = await person(t, { cert: false })
  t.alike(await failure(m.call('group.create', { name: 'Horta', join: 'open' })), {
    code: 'USAGE', message: 'grave o certificado de membro antes de publicar'
  })
  for (const method of ['group.info', 'group.read', 'group.members', 'group.requests', 'group.leave']) {
    t.alike(await failure(m.call(method, { group: OTHER })), { code: 'NOT_FOUND', message: 'grupo não encontrado' })
  }
  // A join of a root not held yet is recorded as pending, so it needs the
  // certificate a published join requires.
  t.alike(await failure(m.call('group.join', { group: OTHER })), {
    code: 'USAGE', message: 'grave o certificado de membro antes de publicar'
  })
  t.alike(await failure(m.call('group.meta', { group: OTHER })), { code: 'USAGE', message: 'nada a alterar' })
  t.alike(await failure(m.call('group.post', { group: OTHER, text: 'x', seen: null })), { code: 'USAGE', message: 'parâmetro desconhecido' })
  const original = member.groupCreate
  try {
    for (const message of ['sem permissão no grupo', 'limite de grupos atingido', 'nada a alterar', 'limite do grupo atingido']) {
      member.groupCreate = async () => { throw new Error(message) }
      t.alike(await failure(m.call('group.create', { name: 'Horta', join: 'open' })), { code: 'USAGE', message })
    }
  } finally {
    member.groupCreate = original
  }
  t.alike(m.events, [])
  t.alike(m.session.internal, [])
})

test('a timeout after a group append is uncertain and rereading finds one post', async (t) => {
  const m = await person(t)
  const { group } = await m.call('group.create', { name: 'Horta', join: 'open' })
  const link = await connect(t, m.session, { timeoutMs: 1000, hold: 'group.post' })
  const error = await link.call('group.post', { group, text: 'uma vez' }).catch((err) => err)
  t.is(error.code, 'TIMEOUT')
  t.is(error.uncertain, true)
  t.is(link.held.length, 1, 'the append completed before the response was lost')
  t.alike(link.held[0].result, { seq: 1 })
  t.is(link.requests.filter((r) => r.method === 'group.post').length, 1, 'no automatic retry')
  const page = await m.call('group.read', { group })
  t.is(page.items.length, 1)
  t.is(page.items[0].seq, 1)
  t.is(page.items[0].text, 'uma vez')
  t.is(link.client.receive(link.held[0]), false, 'a late response does not revive the request')
  t.alike(await m.call('group.read', { group }), page)
  t.alike(m.session.internal, [])
})

test('group reports retain the core signing restriction and node.info has no capabilities', async (t) => {
  const m = await person(t)
  const params = { nonce: 'a'.repeat(43), target: OTHER, reason: 'outro', seq: 1, quote: 'texto' }
  const denied = { code: 'USAGE', message: 'assinatura disponível só no navegador' }
  t.alike(await failure(m.call('report.sign', params)), denied)
  t.alike(await failure(m.call('report.sign', { ...params, writer: OTHER, group: OTHER })), denied)
  t.alike(await m.call('node.info'), {
    publicKey: m.publicKey, memberCert: true, followCount: 0, sync: { state: 'idle' }, publicDht: false
  })
})

test('community create, link, info and admin through RPC emit groups.changed for every affected key', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, { kp })
  const b = await person(t, { kp, name: 'Bia' })
  for (const method of ['community.create', 'community.link', 'community.info', 'community.admin']) t.is(typeof a.session.handlers[method], 'function', method)
  const { community } = await a.call('community.create', { name: 'Bairro' })
  t.alike(a.events.splice(0), [{ event: 'groups.changed', data: { group: community } }])
  const { group } = await a.call('group.create', { name: 'Horta', join: 'open' })
  a.events.splice(0)
  t.alike(await a.call('community.link', { community, group, on: true }), { community, group, on: true, sides: ['community', 'group'] })
  t.alike(a.events.splice(0).map((e) => e.data.group).sort(), [community, group].sort())
  t.alike((await a.call('group.info', { group })).communities, [community])
  await exchange(a, b)
  t.alike(await b.call('group.join', { group }), { state: 'member' })
  await exchange(b, a)
  t.alike(await a.call('community.admin', { community, member: b.publicKey, on: true }), { community, member: b.publicKey, on: true })
  t.alike(a.events.splice(0).map((e) => e.data.group).sort(), [community, group].sort())
  t.alike(await a.call('community.info', { community }), {
    community, name: 'Bairro', creator: a.publicKey, groups: [{ group, name: 'Horta' }], admins: 2, state: 'ready', incomplete: false
  })
  t.alike(await failure(a.call('community.admin', { community, member: a.publicKey, on: true })), { code: 'USAGE', message: 'o criador da comunidade já administra' })
  t.alike(await failure(b.call('community.link', { community, group, on: false })), { code: 'USAGE', message: 'sem permissão na comunidade' })
  t.alike(await failure(b.call('community.info', { community: group })), { code: 'NOT_FOUND', message: 'comunidade não encontrada' })
  t.alike([a.session.internal, b.session.internal], [[], []])
})

test('group.rekey: a private group rotates for its creator, a public one is refused', async (t) => {
  const m = await person(t)
  const { group } = await m.call('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  const info = await m.call('group.info', { group })
  t.is(info.visibility, 'private')
  t.is(info.join, 'approval')
  t.is(info.name, 'Segredo')
  t.alike((await m.call('group.read', { group })).epoch, { writer: group, seq: 1 })
  const r = await m.call('group.rekey', { group })
  t.is(r.group, group)
  t.alike(Object.keys(r).sort(), ['epoch', 'group'], 'only the kid, never a key')
  t.alike((await m.call('group.read', { group })).epoch, r.epoch, 'the new epoch is in use')
  const pub = await m.call('group.create', { name: 'Praça', join: 'open' })
  t.alike(await failure(m.call('group.rekey', { group: pub.group })), { code: 'USAGE', message: 'grupo público não usa chave' })
  t.ok(m.events.some((e) => e.event === 'groups.changed' && e.data.group === group), 'groups.changed after rekey')
  t.alike(m.session.internal, [])
})
