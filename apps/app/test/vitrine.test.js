'use strict'

const test = require('brittle')
const { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { METHODS, validateResponse, validateParams, FEED_LIMIT_MAX, LOG_LIMIT_MAX } = require('@varanda/rpc')

const clone = (value) => JSON.parse(JSON.stringify(value))
const unknown = 'f'.repeat(64)
const load = async () => {
  const { fixtures } = await import('../src/vitrine/fixtures.js')
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  return { fixtures, createVitrineRequest, request: createVitrineRequest(fixtures) }
}

// These lists come from docs/rpc.md section 5, independently of the handlers.
const resultKeys = {
  'session.open': ['protocol'],
  'identity.show': ['publicKey', 'association'],
  'identity.create': [],
  'identity.install': [],
  'identity.clear': [],
  'identity.reset': [],
  'identity.forget': [],
  'identity.sessionSaved': [],
  'identity.recoveryLookup': [],
  'identity.recoveryOpen': [],
  'identity.recoveryWrap': [],
  'identity.recoveryBind': [],
  'profile.delete': [],
  'cert.add': ['seq'],
  'account.sign': ['signature'],
  'age.sign': ['signature'],
  'phone.sign': ['signature'],
  'invite.sign': ['signature'],
  'inviteCard.sign': ['signature'],
  'inviteCard.verify': ['ok', 'reason'],
  'push.sign': ['signature'],
  'seen.sign': ['signature', 'prevHash'],
  'outbox.seal': ['box'],
  'outbox.open': ['to', 'text'],
  'seen.merge': ['avisos', 'pending', 'dmChanged', 'groupChanged', 'blocksChanged', 'testimonialsChanged', 'momentsChanged', 'caughtUp'],
  'seen.onceKey': ['key'],
  'report.sign': ['signature'],
  'appeal.sign': ['signature'],
  'dm.reportSign': ['signature'],
  'terms.sign': ['signature'],
  'recovery.sign': ['signature'],
  'page.sign': ['signature'],
  'page.register': ['actor'],
  'age.proof': ['ageVerifiedDate', 'ageSince', 'ageSinceUntil'],
  'phone.proof': ['phoneVerifiedDate', 'phoneSince'],
  'sync.start': ['runId'],
  'sync.stop': ['stopped'],
  'sync.status': ['state'],
  'node.close': ['closed'],
  'profile.set': ['seq', 'ref'],
  'username.add': ['changed', 'username', 'seq'],
  'post.create': ['seq', 'ref'],
  'post.reply': ['seq', 'ref'],
  'post.quote': ['seq'],
  'post.delete': ['seq', 'ref', 'changed', 'deleted'],
  'post.shared': ['shareSeq'],
  'post.share': ['shareSeq', 'created'],
  'post.unshare': ['ok', 'changed'],
  'like.set': ['seq', 'on', 'changed'],
  'repost.set': ['seq', 'on', 'changed'],
  'engagement.read': ['liked', 'reposted'],
  'block.set': ['changed', 'total'],
  'block.list': ['keys'],
  'follow.add': ['changed', 'followCount'],
  'follow.remove': ['changed', 'followCount'],
  'follow.list': ['follows', 'total'],
  'log.read': ['key', 'entries', 'invalid', 'entriesTruncated'],
  'peek.read': ['items', 'next', 'diaries', 'skipped', 'incomplete'],
  'page.read': ['page', 'owner', 'admins', 'gen', 'seq', 'isOwner', 'isAdmin', 'complete', 'follows', 'followsCount', 'followsTruncated', 'closed', 'movedTo', 'movedFrom', 'links'],
  'page.feed': ['items', 'incomplete'],
  'media.uploadFile': ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height'],
  'dm.putMedia': ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms'],
  'media.readFile': ['name', 'mime', 'w', 'h'],
  'dm.enable': ['box', 'gen', 'seq'],
  'dm.pull': ['added', 'cursor', 'incomplete'],
  'dm.noticeKey': [],
  'dm.set': ['ok'],
  'group.create': ['group'],
  'group.join': ['state'],
  'group.leave': ['state'],
  'group.hide': ['ok'],
  'group.react': ['ok'],
  'group.choose': ['ok'],
  'group.topics': ['items', 'next', 'incomplete'],
  'group.events': ['items', 'next', 'incomplete'],
  'group.voters': ['voters'],
  'choice.set': ['seq'],
  'choice.mine': ['pick', 'seq'],
  'group.reactors': ['reactions'],
  'group.rekey': ['group', 'epoch'],
  'group.members': ['members', 'total'],
  'group.requests': ['requests', 'total'],
  'group.admin': ['ok'],
  'group.ban': ['ok'],
  'group.admit': ['ok'],
  'group.meta': ['ok'],
  'group.invitePolicy': ['ok'],
  'community.create': ['community', 'group'],
  'community.join': ['state', 'group'],
  'community.leave': ['state'],
  'community.removeGroup': ['ok'],
  'community.members': ['members', 'total'],
  'community.requests': ['requests', 'total'],
  'community.admin': ['community', 'member', 'on'],
  'community.ban': ['ok'],
  'community.admit': ['ok'],
  'community.meta': ['ok'],
  'community.invitePolicy': ['ok'],
  'node.info': ['publicKey', 'memberCert', 'memberCertDate', 'ageVerifiedDate', 'ageSince', 'ageSinceUntil', 'phoneVerifiedDate', 'phoneSince', 'followCount', 'sync', 'publicDht', 'groups'],
  'identity.status': ['exists', 'publicKey', 'legacy', 'unlocked', 'synced', 'resumed', 'passkeyKnown', 'credentialId', 'rpId', 'signedOut'],
  'dm.list': ['conversations', 'next', 'requests', 'inboxUnread'],
  'listing.create': ['seq', 'ref'],
  'listing.edit': ['seq', 'ref'],
  'listing.status': ['seq', 'ref'],
  'listing.delete': ['seq', 'ref', 'changed', 'deleted'],
  'listing.consent': ['consent'],
  'listing.rate': ['seq', 'ref'],
  'listing.mine': ['items', 'next'],
  'device.hello': ['id', 'registered', 'off'],
  'device.list': ['self', 'off', 'devices', 'previous'],
  'device.disconnect': ['cut', 'empty'],
  'listing.ratings': ['items', 'dropped', 'incomplete'],
  'dm.thread': ['messages', 'next', 'folder', 'blocked', 'firstUnread'],
  'dm.seen': ['ok'],
  'dm.send': ['id', 'at'],
  'dm.react': ['ok'],
  'dm.lookup': ['box', 'gen'],
  'group.list': ['groups', 'total'],
  'group.read': ['items', 'next', 'hidden', 'incomplete', 'sealed', 'epoch', 'state', 'firstUnread'],
  'group.info': ['group', 'name', 'join', 'creator', 'role', 'members', 'state', 'community', 'orphan', 'visibility', 'memberInvite', 'writerHere', 'canWrite', 'writersBound', 'writersFrozen', 'frozenRoom'],
  'group.seen': ['ok'],
  'group.post': ['seq'],
  'community.list': ['communities'],
  'community.info': ['community', 'name', 'join', 'creator', 'role', 'state', 'members', 'admins', 'groups', 'general', 'incomplete', 'dropped', 'repair', 'leavePending', 'memberInvite', 'writerHere', 'canWrite', 'rootHere', 'authorityHere', 'writersBound', 'writersFrozen', 'frozenRoom', 'generalWritersBound', 'generalWritersFrozen', 'generalFrozenRoom'],
  'feed.read': ['items', 'skipped', 'skippedTruncated', 'future', 'futureTruncated', 'incomplete', 'incompleteTruncated'],
  'notices.list': ['notices', 'next', 'incomplete', 'supported', 'activity'],
  'profile.read': ['profiles', 'missing'],
  'diary.peek': ['key', 'length', 'entries', 'invalid', 'missing', 'profile', 'username', 'certDate'],
  'testimonial.write': ['seq', 'ref'],
  'testimonial.pending': ['items', 'kept', 'incomplete'],
  'testimonial.decide': ['changed'],
  'moment.seen': ['changed'],
  'moments.seen': ['refs'],
  'testimonial.show': ['seq', 'ref'],
  'testimonial.delete': ['seq', 'deleted'],
  'scrap.write': ['seq', 'ref'],
  'scrap.hide': ['seq', 'ref'],
  'scrap.wall': ['seq', 'ref'],
  'scrap.delete': ['seq', 'deleted'],
  'fan.set': ['seq', 'ref'],
  'top.set': ['seq', 'ref'],
  'profile.about': ['seq', 'ref'],
  'profile.mood': ['seq', 'ref'],
  'visits.set': ['on'],
  'visits.state': ['on', 'sentToday'],
  'visits.list': ['visits'],
  'visits.clear': ['ok'],
  'visits.note': ['queued'],
  'garden.set': ['on'],
  'garden.state': ['on', 'state', 'savesToday', 'helpsToday', 'given'],
  'garden.play': ['seq', 'ref', 'state'],
  'garden.help': ['seq', 'ref'],
  'garden.decor': ['seq', 'ref', 'items'],
  'garden.stall': ['open', 'decor', 'giftsToday', 'takesToday', 'gave', 'takes'],
  'garden.give': ['seq', 'ref', 'state'],
  'garden.take': ['seq', 'ref', 'changed'],
  'garden.drop': ['seq', 'deleted'],
  'profile.extra.delete': ['seq', 'deleted'],
  'moment.putMedia': ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms'],
  'moment.create': ['seq', 'ref'],
  'moments.read': ['authors', 'own', 'past'],
  'moment.lookup': ['mime', 'w', 'h', 'ms', 'at'],
  'moment.delete': ['seq', 'deleted']
}

function keys (t, obj, expected, label) {
  t.alike(Object.keys(obj).sort(), [...expected].sort(), label)
}

async function answer (t, request, method, params) {
  let result
  try {
    result = await request(method, params)
  } catch (err) {
    const error = { code: err.code, message: err.message }
    t.ok(validateResponse({ v: 1, id: 1, ok: false, error }).ok, method + ' error envelope')
    t.is(err.uncertain, false, 'a local refusal is certain')
    throw err
  }
  t.ok(validateResponse({ v: 1, id: 1, ok: true, result }).ok, method + ' success envelope')
  let expected = resultKeys[method]
  if (method === 'username.add' && !result.changed) expected = ['changed', 'username']
  if (method === 'group.read' && (params.topic || params.before)) expected = expected.filter((k) => k !== 'firstUnread')
  if (method === 'group.read' && params.topic) expected = [...expected, 'poll', 'event']
  if (method === 'sync.status' && result.state === 'running') expected = ['state', 'runId', 'once']
  if (method === 'page.sign') {
    if (['accept', 'remove', 'offer', 'transfer-accept', 'close'].includes(params.action)) expected = ['record']
    if (['create', 'invite'].includes(params.action)) expected = ['signature', 'record']
    if (params.action === 'move') expected = ['record', 'origin', 'roster']
  }
  keys(t, result, expected, method + ' result keys')
  return result
}

async function refused (t, request, method, params, code, message) {
  try {
    await answer(t, request, method, params)
    t.fail(method + ' must refuse')
  } catch (err) {
    t.is(err.code, code)
    if (message) t.is(err.message, message)
  }
}

test('vitrine fixtures cover the assessment scenarios deterministically', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  t.is(f.members.length, 6)
  t.is(f.pages.length, 2)
  t.is(f.conversations.length, 8)
  t.is(new Set(f.conversations.map((c) => c.peer)).size, 8)
  t.is(f.communities.length, 3)
  t.is(f.groups.length, 5)
  t.is(f.feed.length, 43, '36 base posts, one more photo post, 4 topic posts, a poll post and an event post')
  t.is(f.notices.length, 10)
  for (const p of [...f.members, ...f.pages]) {
    t.ok(/^[0-9a-f]{64}$/.test(p.author))
    t.ok(p.name.length > 0)
    t.ok(/^[a-z][a-z0-9_]{2,19}$/.test(p.username))
  }
  t.alike([...new Set(f.conversations.map((c) => c.folder))].sort(), ['inbox', 'request'])
  t.ok(f.conversations.some((c) => c.unread))
  t.ok(f.conversations.some((c) => !c.unread))
  t.ok(f.conversations.some((c) => new Set(c.messages.map((m) => m.at.slice(0, 10))).size > 1))
  t.ok(f.conversations.some((c) => c.messages.some((m) => m.replyTo)))
  t.is(f.uncertainSends.length, 1)
  t.is(f.uncertainSends[0].uncertain, true)
  t.is(f.uncertainSends[0].message, 'não deu para confirmar o envio')
  t.absent(f.conversations.flatMap((c) => c.messages).some((m) => m.text === f.uncertainSends[0].text))
  t.alike([...new Set(f.groups.map((g) => g.visibility))].sort(), ['private', 'public'])
  t.is(f.groups.filter((g) => g.items.length === 0).length, 1)
  t.ok(f.groups.some((g) => g.items.some((item) => item.replyTo)))
  t.is(f.feed.filter((p) => p.quote).length, 1)
  t.is(f.feed.filter((p) => p.media).length, 21)
  t.ok(f.feed.some((p) => p.text.includes('@')))
  t.ok(f.feed.some((p) => p.text.includes('https://')))
  for (const post of f.feed) t.ok(validateParams('post.create', { text: post.text, ...(post.media ? { media: post.media } : {}) }).ok)
  const a = createVitrineRequest(f)
  const b = createVitrineRequest(f)
  const params = { to: f.conversations[0].peer, text: 'Até amanhã!' }
  t.alike(await answer(t, a, 'dm.send', params), await answer(t, b, 'dm.send', params), 'same starting state and input produce the same output')
})

test('all vitrine methods match the documented result and row keys', async (t) => {
  const { fixtures: f, request } = await load()
  const peer = f.conversations[0].peer
  const group = f.groups[0].group
  const community = f.communities[0].community
  const info = await answer(t, request, 'node.info')
  t.is(info.memberCert, true)
  t.is(info.publicDht, false)
  t.is(info.publicKey, f.own)
  t.alike(info.sync, { state: 'idle' })
  const identity = await answer(t, request, 'identity.status', {})
  t.is(identity.publicKey, f.own)
  for (const field of ['exists', 'legacy', 'unlocked', 'synced', 'resumed', 'passkeyKnown', 'signedOut']) t.is(typeof identity[field], 'boolean')
  const dm = await answer(t, request, 'dm.list', {})
  for (const row of dm.conversations) {
    keys(t, row, ['peer', 'folder', 'preview', 'at', 'unread', 'mine'])
    t.is(typeof row.unread, 'boolean')
  }
  const thread = await answer(t, request, 'dm.thread', { peer })
  for (const row of thread.messages) keys(t, row, ['id', 'from', 'text', 'replyTo', 'at', 'mine', 'media', ...(row.card ? ['card'] : []), ...(row.reactions ? ['reactions'] : [])])
  t.alike(await answer(t, request, 'dm.seen', { peer }), { ok: true })
  const sent = await answer(t, request, 'dm.send', { to: peer, text: 'Combinado!' })
  t.ok(/^[0-9a-f]{32}$/.test(sent.id))
  t.is(new Date(sent.at).toISOString(), sent.at)
  const box = await answer(t, request, 'dm.lookup', { member: peer })
  t.ok(/^[0-9a-f]{64}$/.test(box.box))
  t.is(box.gen, 1)
  const listed = await answer(t, request, 'group.list', {})
  t.is(listed.total, 5)
  for (const row of listed.groups) keys(t, row, ['group', 'name', 'join', 'role', 'members', 'community'])
  const read = await answer(t, request, 'group.read', { group })
  for (const row of read.items) keys(t, row, ['writer', 'diary', 'seq', 'at', 'text', 'replyTo', 'hidden', 'media', 'name', 'username', ...(row.reactions ? ['reactions'] : [])])
  t.alike([read.hidden, read.incomplete, read.sealed, read.epoch, read.state], [0, false, 0, null, 'ok'])
  const groupInfo = await answer(t, request, 'group.info', { group })
  t.is(groupInfo.canWrite, true)
  t.alike(await answer(t, request, 'group.seen', { group }), { ok: true })
  const post = await answer(t, request, 'group.post', { group, text: 'Bom dia!' })
  t.ok(Number.isInteger(post.seq) && post.seq >= 1)
  const communities = await answer(t, request, 'community.list', {})
  t.is(communities.communities.length, 3)
  for (const row of communities.communities) keys(t, row, ['community', 'name', 'join', 'state', 'role', 'general'])
  const details = await answer(t, request, 'community.info', { community })
  for (const row of details.groups) {
    keys(t, row, ['group', 'name', 'visibility', 'join', 'role', 'general', 'last', 'unread'])
    t.ok(Number.isInteger(row.unread) && row.unread >= 0 && row.unread <= 99)
    keys(t, row.last, ['name', 'username', 'preview', 'at', 'mine', 'hidden'])
  }
  const feed = await answer(t, request, 'feed.read', {})
  for (const row of feed.items) {
    keys(t, row, ['kind', 'author', 'name', 'avatar', 'username', 'seq', 'at', 'text', 'replyTo', 'quote', 'media', ...(row.poll ? ['poll'] : []), ...(row.event ? ['event'] : [])])
    if (row.quote) keys(t, row.quote, ['author', 'seq'])
    if (row.media) for (const media of row.media) keys(t, media, ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height'])
  }
  const notices = await answer(t, request, 'notices.list', {})
  for (const row of notices.notices) {
    keys(t, row, ['kind', 'key', 'seq', 'at', 'name', 'username', 'seen', 'avatar', ...(row.kind === 'like' || row.kind === 'repost' ? ['post'] : [])])
    t.ok(/^[0-9a-f]{32}$/.test(row.seen))
  }
  const profiles = await answer(t, request, 'profile.read', { authors: [f.own, f.pages[0].author] })
  for (const row of profiles.profiles) keys(t, row, ['author', 'name', 'username', 'bio', 'avatar'])
  const peek = await answer(t, request, 'diary.peek', { author: f.own, seqs: [3], profileSeq: 1, usernameSeq: 2 })
  for (const entry of peek.entries) {
    keys(t, entry, ['seq', 'record'])
    keys(t, entry.record, ['type', 'text', 'at', 'replyTo', 'media'])
  }
  keys(t, peek.profile, ['name', 'bio', 'avatar'])
  t.is(peek.username, f.members[0].username)
})

test('DM pagination is exclusive and lists preserve folder and global dots', async (t) => {
  const { fixtures: f, request, createVitrineRequest } = await load()
  const peer = f.conversations[0].peer
  const first = await answer(t, request, 'dm.thread', { peer, limit: 2 })
  const second = await answer(t, request, 'dm.thread', { peer, before: first.next })
  t.alike([...second.messages, ...first.messages], f.conversations[0].messages)
  t.is(second.next, null)
  t.alike(await answer(t, request, 'dm.thread', { peer, limit: 2, before: 'f'.repeat(32) }), first, 'unknown cursor returns the newest page')
  t.is((await answer(t, request, 'dm.thread', { peer, before: second.messages[0].id })).messages.length, 0)
  const seen = []
  let before
  do {
    const page = await answer(t, request, 'dm.list', { limit: 2, ...(before ? { before } : {}) })
    seen.push(...page.conversations.map((c) => c.peer))
    t.is(page.requests, true)
    t.is(page.inboxUnread, true)
    if (page.next) keys(t, page.next, ['at', 'peer'])
    before = page.next
  } while (before)
  t.is(seen.length, 5)
  t.is(new Set(seen).size, 5)
  const requests = await answer(t, request, 'dm.list', { folder: 'request' })
  t.is(requests.conversations.length, 3)
  t.ok(requests.conversations.every((c) => c.folder === 'request'))
  t.alike(await answer(t, request, 'dm.thread', { peer: unknown }), { messages: [], next: null, folder: 'inbox', blocked: false, firstUnread: null })
  const tied = clone(f)
  tied.conversations[0].messages[2].id = tied.conversations[0].messages[1].id
  const tiedRequest = createVitrineRequest(tied)
  const page = await answer(t, tiedRequest, 'dm.thread', { peer, before: tied.conversations[0].messages[1].id })
  t.alike(page.messages, tied.conversations[0].messages.slice(0, 2), 'a shared id resolves to its newest message')
})

test('group pages use full cursors, private epochs and an empty last line', async (t) => {
  const { fixtures: f, request, createVitrineRequest } = await load()
  const group = f.groups[0].group
  const first = await answer(t, request, 'group.read', { group, limit: 2 })
  keys(t, first.next, ['at', 'writer', 'seq'])
  const second = await answer(t, request, 'group.read', { group, limit: 2, before: first.next })
  t.ok('firstUnread' in first, 'the newest page carries firstUnread')
  t.absent('firstUnread' in second, 'a before page carries no firstUnread')
  t.alike([...first.items, ...second.items], [...f.groups[0].items].reverse())
  t.is(second.next, null)
  t.ok(first.items[0].replyTo)
  const empty = await answer(t, request, 'group.read', { group: f.groups[4].group })
  t.alike(empty.items, [])
  t.is(empty.next, null)
  const info = await answer(t, request, 'community.info', { community: f.communities[2].community })
  t.is(info.groups[0].last, null)
  t.is(info.groups[0].unread, 0)
  const privatePage = await answer(t, request, 'group.read', { group: f.groups[3].group })
  keys(t, privatePage.epoch, ['writer', 'seq'])
  const listed = await answer(t, request, 'group.list', { offset: 3, limit: 1 })
  t.is(listed.groups[0].group, f.groups[3].group)
  t.is(listed.total, 5)
  const tied = clone(f)
  for (const item of tied.groups[0].items) { item.at = f.now; item.writer = f.groups[0].writer }
  tied.groups[0].items.forEach((item, i) => { item.seq = i + 2 })
  const tiedRequest = createVitrineRequest(tied)
  const a = await answer(t, tiedRequest, 'group.read', { group, limit: 2 })
  const b = await answer(t, tiedRequest, 'group.read', { group, limit: 2, before: a.next })
  t.alike([...a.items, ...b.items].map((item) => item.seq), [5, 4, 3, 2])
})

test('local mutations update previews and marks without leaking across requests', async (t) => {
  const { fixtures: f, request, createVitrineRequest } = await load()
  const original = clone(f)
  const peer = f.conversations[1].peer
  await answer(t, request, 'dm.seen', { peer })
  t.is((await answer(t, request, 'dm.list', {})).conversations.find((c) => c.peer === peer).unread, false)
  const replyTo = f.conversations[1].messages[0].id
  const sent = await answer(t, request, 'dm.send', { to: peer, text: 'Sim, obrigada!', replyTo })
  const thread = await answer(t, request, 'dm.thread', { peer })
  t.is(thread.messages.length, f.conversations[1].messages.length + 1)
  t.alike(thread.messages[thread.messages.length - 1], { ...sent, from: f.own, mine: true, text: 'Sim, obrigada!', replyTo, media: null })
  const list = await answer(t, request, 'dm.list', {})
  t.is(list.conversations[0].preview, 'Sim, obrigada!')
  t.is(list.conversations[0].mine, true)
  await answer(t, request, 'dm.send', { to: f.conversations[5].peer, text: 'Olá!' })
  t.is((await answer(t, request, 'dm.thread', { peer: f.conversations[5].peer })).folder, 'inbox')
  const group = f.groups[0].group
  const community = f.communities[0].community
  const summary = async () => (await answer(t, request, 'community.info', { community })).groups.find((g) => g.group === group)
  t.is((await summary()).unread, 4)
  const item = f.groups[0].items[1]
  await answer(t, request, 'group.seen', { group, upTo: { at: f.now, writer: item.writer, seq: item.seq } })
  t.is((await summary()).unread, 2, 'the stored time wins over the supplied time')
  await answer(t, request, 'group.seen', { group, upTo: { at: f.now, writer: unknown, seq: 100 } })
  t.is((await summary()).unread, 2, 'an unknown mark does not advance')
  const older = f.groups[0].items[0]
  await answer(t, request, 'group.seen', { group, upTo: { at: older.at, writer: older.writer, seq: older.seq } })
  t.is((await summary()).unread, 2, 'marks never move backwards')
  const reply = { writer: item.writer, seq: item.seq }
  const posted = await answer(t, request, 'group.post', { group, text: 'Já estou a caminho.', replyTo: reply })
  const page = await answer(t, request, 'group.read', { group })
  t.is(page.items.length, 5)
  t.is(page.items[0].seq, posted.seq)
  t.alike(page.items[0].replyTo, reply)
  reply.seq = 99
  t.is((await answer(t, request, 'group.read', { group })).items[0].replyTo.seq, item.seq, 'changing a caller param cannot change stored posts')
  t.is((await summary()).last.preview, 'Já estou a caminho.')
  t.is((await summary()).last.mine, true)
  t.is((await summary()).unread, 2, 'own posts do not increase the mark')
  await answer(t, request, 'group.seen', { group })
  t.is((await summary()).unread, 0)
  page.items[0].text = 'Alterado fora do request'
  t.is((await answer(t, request, 'group.read', { group })).items[0].text, 'Já estou a caminho.')
  const separate = createVitrineRequest(f)
  t.alike((await answer(t, separate, 'dm.thread', { peer })).messages, original.conversations[1].messages)
  t.alike(f, original, 'the exported fixtures remain unchanged')
})

test('feed, notices, profiles and diary peeks preserve paging and references', async (t) => {
  const { fixtures: f, request } = await load()
  const pages = []
  let before
  for (;;) {
    const page = await answer(t, request, 'feed.read', { limit: 10, ...(before ? { before } : {}) })
    if (page.items.length === 0) break
    pages.unshift(...page.items)
    const { at, author, seq } = page.items[0]
    before = { at, author, seq }
  }
  t.alike(pages.filter((item) => item.author === f.own || f.follows.includes(item.author)), pages)
  // Each item carries its author's avatar from the profile, as a node's does.
  const avatarOf = (author) => ([...f.members, ...f.pages, ...f.applicants].find((p) => p.author === author) || {}).avatar || null
  t.alike(pages, f.feed.filter((item) => item.author === f.own || f.follows.includes(item.author)).map((item) => ({ ...item, avatar: avatarOf(item.author) })))
  t.is((await answer(t, request, 'feed.read', { before: { at: f.feed[0].at, author: f.feed[0].author, seq: f.feed[0].seq } })).items.length, 0)
  const notices = []
  let after
  do {
    const page = await answer(t, request, 'notices.list', { limit: 3, ...(after ? { after } : {}) })
    notices.push(...page.notices)
    if (page.next) keys(t, page.next, ['at', 'key', 'seq'])
    after = page.next
  } while (after)
  t.is(notices.length, 10)
  t.is(new Set(notices.map((n) => n.seen)).size, 10)
  t.ok(notices.every((n, i) => i === 0 || n.at <= notices[i - 1].at))
  const profiles = await answer(t, request, 'profile.read', { authors: [f.own, unknown, f.own, f.pages[0].author, unknown] })
  t.alike(profiles.profiles.map((p) => p.author), [f.own, f.pages[0].author])
  t.alike(profiles.missing, [unknown])
  for (const post of f.feed.filter((p) => p.quote || p.media)) {
    const target = post.quote || { author: post.author, seq: post.seq }
    const peek = await answer(t, request, 'diary.peek', { author: target.author, seqs: [target.seq, 99] })
    t.is(peek.entries[0].seq, target.seq)
    t.alike(peek.missing, [99])
    t.alike(peek.invalid, [])
    t.ok(peek.length > target.seq)
    if (post.media) t.alike(peek.entries[0].record.media, post.media)
  }
  t.alike(await answer(t, request, 'dm.lookup', { member: unknown }), { box: null, gen: null })
})

test('notices resolve to real posts and follows match the feed', async (t) => {
  const { fixtures: f, request } = await load()
  const ownUsername = f.members[0].username
  const info = await answer(t, request, 'node.info')
  t.is(info.followCount, f.follows.length)
  t.absent(f.follows.includes(f.own))
  const feed = await answer(t, request, 'feed.read', { limit: FEED_LIMIT_MAX })
  const allowed = new Set([...f.follows, f.own])
  t.ok(feed.items.length > 0)
  t.ok(feed.items.every((item) => allowed.has(item.author)), 'feed shows only followed diaries and the own one')
  const notices = (await answer(t, request, 'notices.list', { limit: 30 })).notices
  const follows = notices.filter((n) => n.kind === 'follow')
  t.ok(follows.length >= 2)
  t.ok(follows.every((n) => !f.follows.includes(n.key) && n.key !== f.own), 'follow notices name people not followed')
  t.ok(f.members.some((m) => m.author !== f.own && !f.follows.includes(m.author) && !feed.items.some((item) => item.author === m.author)))
  const kinds = new Set(notices.map((n) => n.kind))
  for (const kind of ['follow', 'reply', 'quote', 'mention', 'like', 'repost']) t.ok(kinds.has(kind), kind)
  for (const n of notices) {
    if (n.kind === 'follow') {
      const peek = await answer(t, request, 'diary.peek', { author: n.key, seqs: [n.seq] })
      t.alike(peek.entries[0].record, { type: 'follow', key: f.own, on: true, at: n.at })
      continue
    }
    if (n.kind === 'like' || n.kind === 'repost') {
      const operation = await answer(t, request, 'diary.peek', { author: n.key, seqs: [n.seq] })
      t.is(operation.entries[0].record.type, n.kind)
      t.is(operation.entries[0].record.on, true)
      const [author, seq] = n.post.split(':')
      t.is(author, f.own)
      const peek = await answer(t, request, 'diary.peek', { author, seqs: [Number(seq)] })
      t.is(peek.entries.length, 1, n.kind + ' targets a real own post')
      continue
    }
    const peek = await answer(t, request, 'diary.peek', { author: n.key, seqs: [n.seq] })
    t.is(peek.entries.length, 1, n.kind + ' notice peeks a real post')
    const record = peek.entries[0].record
    t.is(record.type, 'post')
    t.is(record.at, n.at)
    if (n.kind === 'reply') {
      t.is(record.replyTo.author, f.own)
      const parent = await answer(t, request, 'diary.peek', { author: f.own, seqs: [record.replyTo.seq] })
      t.is(parent.entries.length, 1, 'the reply parent is an own post')
    }
    if (n.kind === 'quote') {
      t.is(record.quote.author, f.own)
      const quoted = await answer(t, request, 'diary.peek', { author: f.own, seqs: [record.quote.seq] })
      t.is(quoted.entries.length, 1, 'the quoted post is an own post')
    }
    if (n.kind === 'mention') t.ok(record.text.includes('@' + ownUsername))
  }
})

test('diary.peek answers the profile and username blocks and communities sort the rest last', async (t) => {
  const { fixtures: f, request, createVitrineRequest } = await load()
  const peek = await answer(t, request, 'diary.peek', { author: f.members[1].author, seqs: [1, 2], profileSeq: 1, usernameSeq: 2 })
  t.alike(peek.entries.map((e) => e.seq), [1, 2])
  t.is(peek.entries[0].record.type, 'profile')
  t.is(peek.entries[1].record.type, 'username')
  t.is(peek.entries[1].record.username, f.members[1].username)
  t.alike(peek.missing, [])
  t.is(peek.username, f.members[1].username)
  const odd = clone(f)
  odd.communities[0].role = 'requested'
  odd.communities[1].role = 'banned'
  odd.communities[2].role = 'member'
  const roles = (await answer(t, createVitrineRequest(odd), 'community.list', {})).communities.map((c) => c.role)
  t.alike([...roles].sort(), ['banned', 'member', 'requested'])
  t.is(roles[0], 'member')
})

test('unknown methods and bad params refuse before any local write', async (t) => {
  const { fixtures: f, request } = await load()
  await refused(t, request, 'vitrine.missing', {}, 'USAGE', 'método desconhecido')
  await refused(t, request, 'toString', {}, 'USAGE', 'método desconhecido')
  for (const method of Object.keys(resultKeys)) await refused(t, request, method, { extra: true }, 'USAGE', 'parâmetro desconhecido')
  for (const [method, params] of [
    ['dm.thread', { peer: unknown, limit: 0 }],
    ['dm.list', { folder: 'other' }],
    ['group.read', { group: f.groups[0].group, before: { at: f.now, writer: unknown } }],
    ['feed.read', { before: { at: f.now, author: unknown, seq: 0 } }],
    ['notices.list', { limit: 65 }],
    ['diary.peek', { author: f.own, seqs: [3, 3] }],
    ['dm.send', { to: f.conversations[0].peer, text: '' }],
    ['group.post', { group: f.groups[0].group, text: '' }],
    ['node.info', null]
  ]) await refused(t, request, method, params, 'USAGE')
  await refused(t, request, 'dm.send', { to: f.own, text: 'Olá' }, 'USAGE', 'não é possível enviar para si')
  await refused(t, request, 'dm.send', { to: unknown, text: 'Olá' }, 'USAGE', 'esta pessoa ainda não recebe mensagens')
  await refused(t, request, 'dm.send', { to: f.conversations[0].peer, text: 'Olá', replyTo: 'f'.repeat(32) }, 'USAGE', 'responda uma mensagem desta conversa')
  for (const method of ['group.read', 'group.info', 'group.seen']) await refused(t, request, method, { group: unknown }, 'NOT_FOUND', 'grupo não encontrado')
  await refused(t, request, 'group.post', { group: unknown, text: 'Olá' }, 'NOT_FOUND', 'grupo não encontrado')
  await refused(t, request, 'community.info', { community: unknown }, 'NOT_FOUND', 'comunidade não encontrada')
  await refused(t, request, 'diary.peek', { author: unknown, seqs: [1] }, 'NOT_FOUND', 'diário indisponível')
  t.alike((await answer(t, request, 'dm.thread', { peer: f.conversations[0].peer })).messages, f.conversations[0].messages)
  t.alike((await answer(t, request, 'group.read', { group: f.groups[0].group })).items, [...f.groups[0].items].reverse())
})

test('vitrine sources stay pure and omit forbidden status words', (t) => {
  const forbidden = new RegExp('(?<!\\p{L})(' + ['li' + 'da', 'entre' + 'gue', 'digi' + 'tando'].join('|') + ')(?!\\p{L})', 'iu')
  const expectedImports = {
    'fixtures.js': ["import { pictures } from './pictures.js'", "import { sha256 } from '@noble/hashes/sha2.js'", "import rpc from '@varanda/rpc'", "import { ed25519 } from '@noble/curves/ed25519.js'"],
    'publicMedia.js': ["import { fixtures, postPictureBytes } from './fixtures.js'"],
    'pictures.js': [],
    'media.js': ["import { pictures } from './pictures.js'", "import { PICTURE_BASE, postPictureIndex } from './fixtures.js'"],
    'request.js': ["import rpc from '@varanda/rpc'", "import { createVitrineMedia } from './media.js'", "import { sealedTestimonial, signVitrineConsent, testimonialHash, verifyVitrineConsent } from './fixtures.js'", "import { largeFeed } from './large.js'", "import { testimonialPointers, useTestimonialSource } from './testimonialIndex.js'"],
    'large.js': [],
    'indexResponder.js': ["import rpc from '@varanda/rpc'", "import { fixtures } from './fixtures.js'", "import { createVitrineRequest, vitrineFeiraState, vitrineLiveRecords } from './request.js'", "import { testimonialPointers, testimonialSource } from './testimonialIndex.js'"],
    'testimonialIndex.js': ["import { fixtures, testimonialHash } from './fixtures.js'"]
  }
  for (const file of Object.keys(expectedImports)) {
    const source = readFileSync(join(__dirname, '../src/vitrine', file), 'utf8')
    t.absent(forbidden.test(source), file + ' status vocabulary')
    t.absent(source.includes(String.fromCharCode(0x2014)))
    t.absent(/\b(?:require|process|Buffer|window|document|navigator|fetch|localStorage|setTimeout|setInterval)\b/.test(source))
    t.absent(/Date\.now|Math\.random/.test(source))
    const imports = source.split('\n').filter((line) => line.startsWith('import '))
    t.alike(imports, expectedImports[file], file + ' imports')
  }
})

const destructive = ['identity.create', 'identity.install', 'identity.clear', 'identity.reset', 'identity.forget', 'identity.recoveryLookup', 'identity.recoveryOpen', 'identity.recoveryWrap', 'identity.recoveryBind', 'profile.delete', 'group.seal', 'media.sealPageFile', 'dm.pageGenerate', 'dm.pageShare', 'dm.pageSecrets', 'dm.pageDraft', 'dm.pageSend', 'dm.pageLegacyChunk', 'dm.pageLegacyBlocks', 'dm.pageForget']

function samples (f) {
  const group = f.groups[3].group
  const forum = f.groups[2]
  const community = f.communities[1].community
  const member = f.members[2].author
  const to = `${f.own}:3`
  const nonce = 'v'.repeat(43)
  const card = { code: nonce, design: 'cordel', name: 'Ana', message: 'Vem pra praça.', expires: 1800000000 }
  const queued = { id: '0123456789abcdef', author: f.own, association: 'c'.repeat(64), kind: 'post', writtenAt: '2026-11-15T12:00:00.000Z' }
  const params = {
    'session.open': {},
    'node.info': {},
    'node.close': {},
    'identity.create': {},
    'identity.show': {},
    'identity.status': {},
    'identity.clear': {},
    'identity.reset': {},
    'identity.forget': {},
    'identity.sessionSaved': {},
    'identity.install': { prf: '0'.repeat(64), credentialId: 'vitrine', userId: '', rpId: 'vitrine.invalid', resumed: false },
    'cert.add': { cert: {} },
    'profile.set': { name: 'Lia na praça', bio: 'Um encontro por dia.' },
    'profile.delete': { to: `${f.own}:1` },
    'profile.read': { authors: [f.own, member] },
    'username.add': { record: { username: 'lia_praca' } },
    'post.create': { text: 'Bom dia, praça!' },
    'post.reply': { to, text: 'Até amanhã!' },
    'post.quote': { to, text: 'Vamos conversar sobre isso.' },
    'post.delete': { to },
    'post.shared': { to },
    'post.share': { to },
    'post.unshare': { to },
    'like.set': { to, on: true },
    'repost.set': { to, on: true },
    'engagement.read': { refs: [to] },
    'block.set': { key: f.members[4].author, on: true },
    'block.list': {},
    'follow.add': { key: f.members[4].author },
    'follow.remove': { key: member },
    'follow.list': {},
    'log.read': {},
    'feed.read': {},
    'peek.read': {},
    'notices.list': {},
    'diary.peek': { author: f.own, seqs: [3] },
    'testimonial.write': { to: member, text: 'Uma vizinha de muitas conversas boas.' },
    'testimonial.pending': {},
    'testimonial.decide': { from: f.members[4].author, seq: 60, state: 'kept' },
    'moment.seen': { author: f.members[4].author, seq: 1 },
    'moments.seen': {},
    'testimonial.show': { from: f.members[4].author, seq: 60 },
    'testimonial.delete': { to: `${f.own}:38` },
    'scrap.write': { to: member, text: 'Oi, Cecília! Passei para deixar um abraço.' },
    'scrap.hide': { from: f.members[1].author, seq: 90 },
    'scrap.wall': { who: 'everyone' },
    'scrap.delete': { seq: 49 },
    'fan.set': { key: f.members[4].author, on: true },
    'top.set': { keys: [f.members[4].author] },
    'profile.about': { about: 'Café, livros e encontros na praça.', city: 'Curitiba', work: null, studies: null, interests: null, birthday: '05-20', theme: 'varanda' },
    'visits.set': { on: true },
    'visits.state': {},
    'visits.list': {},
    'visits.clear': {},
    'visits.note': { key: f.members[1].author },
    'garden.set': { on: true },
    'garden.state': {},
    'garden.play': { acts: [{ op: 'plant', pot: 4, plant: 'tomate' }] },
    'garden.help': { to: f.members[3].author, pot: 0 },
    'garden.decor': { items: ['rede', 'gato'] },
    'garden.stall': {},
    'garden.give': { to: f.members[3].author, pot: 0 },
    'garden.take': { from: f.members[3].author, seq: 135 },
    'garden.drop': { kind: 'take', seq: 55 },
    'profile.mood': { emoji: '☕', text: 'Café na praça' },
    'profile.extra.delete': { kind: 'about' },
    'moment.putMedia': { name: '0'.repeat(32) + '.bin', mime: 'image/jpeg', width: 512, height: 512 },
    'moment.create': { text: 'Bom dia, praça!', media: f.diaryRecords.find((e) => e.record.type === 'moment').record.media },
    'moments.read': {},
    'moment.lookup': { author: f.follows.find((a) => f.diaryRecords.some((e) => e.author === a && e.record.type === 'moment')), seq: Math.max(...f.diaryRecords.filter((e) => e.record.type === 'moment' && e.author === f.follows.find((a) => f.diaryRecords.some((x) => x.author === a && x.record.type === 'moment'))).map((e) => e.seq)) },
    'moment.delete': { to: `${f.own}:48` },
    'account.sign': { phase: 'reserve', nonce, username: 'lia_praca', sub: '' },
    'age.sign': { action: 'result', nonce },
    'age.proof': { verified: { date: f.now }, since: null },
    'phone.sign': { action: 'send', nonce },
    'phone.proof': { verified: { date: f.now }, since: null },
    'invite.sign': { action: 'issue', nonce },
    'inviteCard.sign': card,
    'inviteCard.verify': { ...card, member: 'ab'.repeat(32), signature: '0'.repeat(128) },
    'push.sign': { action: 'on', nonce, endpoint: 'https://push.example.org/vitrine', p256dh: 'vitrine', auth: 'vitrine' },
    'outbox.seal': { ...queued, to: null, text: 'Fica para depois.' },
    'outbox.open': { ...queued, box: Buffer.from(JSON.stringify([1, queued.id, queued.author, queued.association, queued.kind, null, 'Fica para depois.', queued.writtenAt])).toString('base64url') },
    'seen.sign': { nonce, action: 'read' },
    'seen.merge': { blob: null, avisos: { own: [] }, unchanged: false },
    'seen.onceKey': {},
    'report.sign': { nonce, target: member, reason: 'outro' },
    'appeal.sign': { nonce, text: 'Foi um engano.' },
    'dm.reportSign': { nonce, target: member, reason: 'outro', quote: 'Uma mensagem de exemplo.' },
    'terms.sign': { nonce, version: 1 },
    'recovery.sign': { action: 'list', nonce },
    'identity.recoveryLookup': { kind: 'passkey', secret: 'a'.repeat(64) },
    'identity.recoveryOpen': { blob: { v: 1, kind: 'passkey', nonce: 'b'.repeat(48), ciphertext: 'c'.repeat(164) }, member: 'd'.repeat(64) },
    'identity.recoveryWrap': { kind: 'passkey', secret: 'e'.repeat(64) },
    // A marked user id: 16 bytes, then utf8 'varanda-wrap-v1\n'.
    'identity.recoveryBind': { credentialId: 'vitrine', userId: '00'.repeat(16) + '766172616e64612d777261702d76310a' },
    'page.sign': { action: 'list', nonce, page: '', op: {} },
    'page.register': {},
    'page.read': { key: f.pages[0].author },
    'page.feed': { page: f.pages[0].author, keys: f.follows },
    'media.uploadFile': { name: '0'.repeat(32) + '.bin', mime: 'image/jpeg', width: 512, height: 512 },
    'dm.putMedia': { name: '0'.repeat(32) + '.bin', to: 'a'.repeat(64), mime: 'image/jpeg', width: 512, height: 512 },
    'media.readFile': { kind: 'dm', from: f.members[1].author, id: f.conversations[2].messages[4].id, index: 0 },
    'media.sealPageFile': { name: '0'.repeat(32) + '.bin', page: 'a'.repeat(64), mime: 'image/jpeg', width: 512, height: 512 },
    'dm.enable': {},
    'dm.lookup': { member },
    'dm.pull': {},
    'dm.noticeKey': { key: 'a'.repeat(64) },
    'dm.list': {},
    'dm.thread': { peer: member },
    'dm.pageGenerate': { page: member, gen: 1, recipients: [{ member, box: member }] },
    'dm.pageShare': { page: member, member, box: member },
    'dm.pageSecrets': { page: member, gen: 1, sealed: 'abc', by: member, sig: 'ab'.repeat(64), box: member, groupBox: member, cert: {} },
    'dm.pageDraft': { page: member, kind: 'msg', to: f.own, text: 'Oi' },
    'dm.pageSend': { page: member, id: 'ab'.repeat(16), signature: 'ab'.repeat(64), expiresAt: 1800000000000 },
    'dm.pageLegacyChunk': { page: member, id: member, index: 0, count: 1, sealed: 'abc' },
    'dm.pageLegacyBlocks': { page: member },
    'dm.pageForget': { page: member },
    'dm.seen': { peer: member },
    'dm.set': { peer: member, state: 'accepted' },
    'dm.send': { to: member, text: 'Olá!' },
    'dm.react': { to: f.conversations[0].peer, target: { from: f.conversations[0].messages[0].from, id: f.conversations[0].messages[0].id }, emoji: '👍' },
    'group.create': { name: 'Encontro na praça', join: 'open', community },
    'group.list': {},
    'group.info': { group },
    'group.join': { group },
    'group.leave': { group },
    'group.read': { group },
    'group.seal': { group, page: group, text: 'Vamos nos encontrar!' },
    'group.post': { group, text: 'Vamos nos encontrar!' },
    'group.seen': { group },
    'group.hide': { group, target: { writer: f.groups[3].items[0].writer, seq: 2 }, on: true },
    'group.react': { group, target: { writer: f.groups[3].items[0].writer, seq: 2 }, emoji: '👍' },
    'group.reactors': { group, target: { writer: f.groups[3].items[0].writer, seq: 2 } },
    'group.rekey': { group },
    'group.topics': { group: forum.group },
    'group.events': { group: forum.group },
    'group.voters': { group: forum.group, target: { writer: forum.topics[0].writer, seq: forum.topics[0].seq } },
    'group.choose': { group: forum.group, target: { writer: forum.topics[0].writer, seq: forum.topics[0].seq }, pick: 1 },
    'choice.set': { to: `${f.own}:60`, pick: 1 },
    'choice.mine': { to: `${f.own}:60` },
    'community.create': { name: 'Amigos da praça', join: 'open' },
    'community.list': {},
    'community.info': { community },
    'community.join': { community },
    'community.leave': { community },
    'community.removeGroup': { community, group },
    'listing.create': { kind: 'produto', title: 'Bicicleta aro 26', text: 'Pouco uso.', price: 25000, unit: null, cat: 'esporte', place: { uf: 'SP', city: 'São Paulo', bairro: null } },
    'listing.edit': { to: `${f.own}:40`, expectedRevision: 44, title: 'Bicicleta aro 26', text: 'Pouco uso.', price: 24000, unit: null, cat: 'esporte', place: { uf: 'SP', city: 'São Paulo', bairro: null }, media: null },
    'listing.status': { to: `${f.own}:40`, status: 'reservado' },
    'listing.delete': { to: `${f.own}:40` },
    'listing.mine': {},
    'device.hello': { name: 'Pixel 8' },
    'device.list': {},
    'device.disconnect': { id: '2'.repeat(64) },
    'device.reconnect': { name: 'Pixel 8' },
    'listing.ratings': { author: member, seq: 3, refs: [{ rater: f.own, seq: 4 }] },
    'listing.consent': { to: `${f.own}:40`, rater: f.members[1].author, offer: f.conversations[0].messages.find((m) => m.card?.title === 'Proposta').id },
    'listing.rate': { to: `${f.members[1].author}:40`, offer: f.conversations[0].messages.at(-1).replyTo, consent: f.conversations[0].messages.at(-1).card.url.split('&aceite=')[1], stars: 5, text: 'Tudo certo.' },
    'sync.start': { once: true },
    'sync.stop': {},
    'sync.status': {}
  }
  for (const kind of ['group', 'community']) {
    const target = { [kind]: kind === 'group' ? group : community }
    params[`${kind}.members`] = target
    params[`${kind}.requests`] = target
    params[`${kind}.meta`] = { ...target, name: 'Novo encontro' }
    params[`${kind}.invitePolicy`] = { ...target, members: true }
    for (const action of ['admin', 'ban', 'admit']) params[`${kind}.${action}`] = { ...target, member, on: true }
  }
  return params
}

function appSources (dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'vitrine') return []
    const file = join(dir, entry.name)
    return entry.isDirectory() ? appSources(file) : entry.name.endsWith('.js') ? [file] : []
  })
}

test('the demo outbox seal opens as itself only, and skips another identity', async (t) => {
  const { fixtures: f, request } = await load()
  const item = { id: '00000000000000aa', author: f.own, association: 'c'.repeat(64), kind: 'reply', writtenAt: '2026-11-15T12:00:00.000Z' }
  const text = 'Até já 😀\nde novo'
  const { box } = await answer(t, request, 'outbox.seal', { ...item, to: `${f.own}:3`, text })
  t.alike(await answer(t, request, 'outbox.open', { ...item, box }), { to: `${f.own}:3`, text })
  await refused(t, request, 'outbox.open', { ...item, writtenAt: '2026-11-15T12:00:01.000Z', box }, 'USAGE', 'item da fila de saída inválido')
  await refused(t, request, 'outbox.open', { ...item, box: 'QUFB' }, 'USAGE', 'item da fila de saída inválido')
  await refused(t, request, 'outbox.open', { ...item, author: f.members[2].author, box }, 'USAGE', 'item da fila de saída de outra identidade')
  await refused(t, request, 'outbox.seal', { ...item, author: f.members[2].author, to: `${f.own}:3`, text }, 'USAGE', 'item da fila de saída de outra identidade')
})

test('every quoted RPC method used by the app has a documented vitrine answer', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  const sources = [join(__dirname, '../App.js'), ...appSources(join(__dirname, '../src'))].map((file) => readFileSync(file, 'utf8'))
  const used = METHODS.filter((method) => sources.some((source) => ["'", '"', '`'].some((quote) => source.includes(quote + method + quote))))
  const params = samples(f)
  t.ok(used.length >= 84, 'the scan includes the current app surface')
  for (const method of used) {
    t.ok(Object.hasOwn(params, method), method + ' has valid example params')
    t.ok(validateParams(method, params[method]).ok, method + ' params match the contract')
    const request = createVitrineRequest(f)
    // moment.create takes only an item the media handle just prepared.
    const given = method === 'moment.create' ? { ...params[method], media: await request.media.putMoment({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg', width: 640, height: 480 }) } : params[method]
    // profile.extra.delete needs a live record; the own fixture diary has none.
    if (method === 'profile.extra.delete') await request('profile.about', params['profile.about'])
    if (method === 'device.reconnect') await refused(t, request, method, given, 'USAGE', 'este aparelho está conectado')
    // The demo clock is a Thursday, so a give is the documented refusal.
    else if (method === 'garden.give') await refused(t, request, method, given, 'USAGE', 'a barraquinha só abre aos sábados')
    else if (destructive.includes(method)) await refused(t, request, method, given, 'USAGE', 'indisponível no modo vitrine')
    else await answer(t, request, method, given)
  }
})

test('device answers: list, disconnect and the node refusals, per instance', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  const request = createVitrineRequest(f)
  const call = (method, params) => answer(t, request, method, params)
  const pixel = '2'.repeat(64)
  const firefox = '3'.repeat(64)
  const before = await call('device.list', {})
  t.is(before.self, null, 'no id before the first hello')
  const hello = await call('device.hello', { name: 'Chrome no Android' })
  t.alike(hello, { id: '1'.repeat(64), registered: true, off: false })
  t.is((await call('device.hello', { name: 'Chrome no Android' })).registered, false, 'a second hello writes nothing')
  const list = await call('device.list', {})
  t.alike(list.devices.map((d) => [d.name, d.on, d.self]), [['Chrome no Android', true, true], ['Pixel 8', true, false], ['Firefox no Linux', false, false]])
  t.alike(list.previous, { writers: 2 })
  await refused(t, request, 'device.disconnect', { id: '1'.repeat(64) }, 'USAGE', 'não dá para desconectar este aparelho por aqui')
  await refused(t, request, 'device.disconnect', { id: firefox }, 'USAGE', 'aparelho não encontrado')
  await refused(t, request, 'device.disconnect', { id: 'f'.repeat(64) }, 'USAGE', 'aparelho não encontrado')
  await refused(t, request, 'device.disconnect', {}, 'USAGE', 'informe id ou previous')
  const cut = await call('device.disconnect', { id: pixel })
  t.ok(cut.empty > 0 && cut.empty <= cut.cut, 'one device has empty cuts')
  t.is((await call('device.list', {})).devices.find((d) => d.id === pixel).on, false, 'flipped to disconnected')
  await refused(t, request, 'device.disconnect', { id: pixel }, 'USAGE', 'aparelho não encontrado')
  t.alike(await call('device.disconnect', { previous: true }), { cut: 2, empty: 0 })
  t.is((await call('device.list', {})).previous, null)
  await refused(t, request, 'device.reconnect', { name: 'Pixel 8' }, 'USAGE', 'este aparelho está conectado')
  const other = createVitrineRequest(f)
  t.is((await other('device.list', {})).devices.length, 0, 'the state is per instance')
})

test('the own likes and reposts in the fixtures start active and toggle off', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  const seeded = f.diaryRecords.filter((e) => e.author === f.own && (e.record.type === 'like' || e.record.type === 'repost') && e.record.on)
  t.ok(seeded.some((e) => e.record.type === 'like') && seeded.some((e) => e.record.type === 'repost'))
  for (const { seq, record } of seeded) {
    const ref = `${record.to.author}:${record.to.seq}`
    const key = record.type === 'like' ? 'liked' : 'reposted'
    t.alike((await call('engagement.read', { refs: [ref] }))[key], [ref], ref + ' starts active')
    t.alike(await call(record.type + '.set', { to: ref, on: true }), { seq, on: true, changed: false })
    const off = await call(record.type + '.set', { to: ref, on: false })
    t.is(off.changed, true)
    t.alike((await call('engagement.read', { refs: [ref] }))[key], [])
  }
})

test('a published link card reaches the diary and A Rua', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  const own = async (seq) => (await call('feed.read')).items.find((p) => p.author === f.own && p.seq === seq)
  const card = { url: 'https://example.com/a', host: 'example.com', title: 'Título', desc: '', image: null }
  for (const method of ['post.create', 'post.reply', 'post.quote']) {
    const target = method === 'post.create' ? {} : { to: (await call('post.create', { text: 'alvo' })).ref }
    const { seq } = await call(method, { ...target, text: 'com cartão ' + method, preview: card })
    const log = await call('log.read', { limit: 1 })
    t.alike(log.entries[0].record.preview, card, method + ' keeps the card in the diary')
    t.alike((await own(seq)).preview, card, method + ' keeps the card in A Rua')
  }
  const { seq } = await call('post.create', { text: 'sem cartão' })
  t.absent('preview' in (await call('log.read', { limit: 1 })).entries[0].record)
  t.is((await own(seq)).preview, null)
})

test('profile.extra.delete tombstones every live version of its kind and refuses when none is live', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  const request = createVitrineRequest(f)
  const call = (method, params) => answer(t, request, method, params)
  const about = samples(f)['profile.about']
  const one = await call('profile.about', about)
  const mood = await call('profile.mood', { emoji: '☕' })
  const two = await call('profile.about', { ...about, city: null })
  const r = await call('profile.extra.delete', { kind: 'about' })
  t.alike(r.deleted, [one.seq, two.seq])
  const tail = (await call('log.read', { limit: 2 })).entries
  t.alike(tail.map((e) => [e.seq, e.record.type, e.record.seq]), [[r.seq - 1, 'delete', one.seq], [r.seq, 'delete', two.seq]])
  await refused(t, request, 'profile.extra.delete', { kind: 'about' }, 'USAGE', 'nada para apagar')
  t.alike((await call('profile.extra.delete', { kind: 'mood' })).deleted, [mood.seq])
  await refused(t, request, 'profile.extra.delete', { kind: 'mood' }, 'USAGE', 'nada para apagar')
})

test('diary writes, tombstones, reactions, follows and profile changes are visible locally', async (t) => {
  const { fixtures: f, request, createVitrineRequest } = await load()
  const call = (method, params) => answer(t, request, method, params)
  const log = await call('log.read')
  t.is(log.key, f.own)
  // The fixture diary spans several pages: read back to its first block.
  const everyEntry = [...log.entries]
  for (let page = log; page.entriesTruncated > 0;) {
    page = await call('log.read', { before: page.entries[0].seq })
    everyEntry.unshift(...page.entries)
  }
  t.alike(everyEntry.filter((e) => e.record.type === 'post').map((e) => e.record.text), f.feed.filter((p) => p.author === f.own).map((p) => p.text))
  const original = clone(f)
  const uploaded = await call('media.uploadFile', samples(f)['media.uploadFile'])
  const uploadedNext = await call('media.uploadFile', samples(f)['media.uploadFile'])
  t.is(uploadedNext.start, uploaded.start + 1)
  const post = await call('post.create', { text: 'Um encontro novo', media: [uploaded] })
  const reply = await call('post.reply', { to: post.ref, text: 'Eu vou!' })
  const quote = await call('post.quote', { to: post.ref, text: 'Vamos juntos.' })
  const newest = await call('log.read', { limit: 2 })
  t.alike(newest.entries.map((e) => e.seq), [reply.seq, quote.seq])
  t.ok(newest.entriesTruncated > 0)
  t.alike(newest.entries[0].record.replyTo, { author: f.own, seq: post.seq })
  t.alike(newest.entries[1].record.quote, { author: f.own, seq: post.seq })
  const older = await call('log.read', { before: reply.seq, limit: 1 })
  t.is(older.entries[0].seq, post.seq)
  t.alike(older.entries[0].record.media, [uploaded])
  const feed = await call('feed.read')
  t.ok(feed.items.some((p) => p.seq === post.seq && p.author === f.own))
  for (const kind of ['like', 'repost']) {
    const first = await call(kind + '.set', { to: post.ref, on: true })
    t.is(first.changed, true)
    t.alike(await call(kind + '.set', { to: post.ref, on: true }), { ...first, changed: false })
    const engagement = await call('engagement.read', { refs: [post.ref] })
    t.alike(engagement[kind === 'like' ? 'liked' : 'reposted'], [post.ref])
    if (kind === 'repost') t.ok((await call('feed.read')).items.some((p) => p.kind === 'repost' && p.to.seq === post.seq))
    await call(kind + '.set', { to: post.ref, on: false })
    t.alike((await call('engagement.read', { refs: [post.ref] }))[kind === 'like' ? 'liked' : 'reposted'], [])
  }
  const removed = await call('post.delete', { to: post.ref })
  t.is(removed.changed, true)
  t.alike(await call('post.delete', { to: post.ref }), { ...removed, changed: false })
  const after = await call('log.read')
  t.ok(after.invalid.some((e) => e.seq === post.seq && e.reason === 'deleted'))
  t.ok(after.entries.some((e) => e.seq === removed.seq && e.record.type === 'delete'))
  t.absent((await call('feed.read')).items.some((p) => p.author === f.own && p.seq === post.seq))
  const peek = await call('diary.peek', { author: f.own, seqs: [post.seq] })
  t.alike(peek.invalid, [])
  t.alike(peek.missing, [post.seq])
  t.alike(peek.entries, [])
  await refused(t, request, 'post.delete', { to: `${f.members[1].author}:3` }, 'USAGE')
  const profile = await call('profile.set', { name: 'Lia da praça', bio: 'Café e encontros', avatar: uploaded })
  await call('profile.set', { name: 'Lia do bairro' })
  t.alike((await call('profile.read', { authors: [f.own] })).profiles[0].avatar, uploaded, 'omitted avatar is retained')
  const rename = await call('username.add', { record: { username: 'lia_praca' } })
  t.is(rename.changed, true)
  t.alike(await call('username.add', { record: { username: 'lia_praca' } }), { changed: false, username: 'lia_praca' })
  const names = await call('diary.peek', { author: f.own, seqs: [profile.seq], profileSeq: profile.seq, usernameSeq: rename.seq })
  t.is(names.username, 'lia_praca')
  t.is(names.profile.name, 'Lia da praça', 'profile hint resolves the requested version')
  t.ok((await call('feed.read')).items.filter((p) => p.author === f.own).every((p) => p.name === 'Lia do bairro' && p.username === 'lia_praca'))
  const key = f.members[4].author
  const followed = await call('follow.add', { key })
  t.is(followed.changed, true)
  t.is((await call('follow.add', { key })).changed, false)
  t.is((await call('node.info')).followCount, f.follows.length + 1)
  t.ok((await call('follow.list')).follows.includes(key))
  t.ok((await call('feed.read')).items.some((p) => p.author === key))
  await call('follow.remove', { key })
  t.absent((await call('feed.read')).items.some((p) => p.author === key))
  t.alike((await call('follow.list', { offset: 1, limit: 2 })).follows, [...f.follows].sort().slice(1, 3))
  t.alike(await answer(t, createVitrineRequest(f), 'log.read'), log, 'another request has the original diary')
  t.alike(f, original)
})

test('discovery and page reads have populated rows and exclusive pagination', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  const all = (await call('peek.read')).items
  t.ok(all.length > 0)
  const paged = []
  let after
  do {
    const page = await call('peek.read', { limit: 1, ...(after ? { after } : {}) })
    paged.push(...page.items)
    after = page.next
    if (after) keys(t, after, ['round', 'at', 'author', 'seq'])
  } while (after)
  t.alike(paged, all)
  for (const row of all) {
    keys(t, row, ['kind', 'author', 'name', 'username', 'seq', 'at', 'text', 'replyTo', 'quote', 'media', 'round', 'avatar'])
    t.absent(f.follows.includes(row.author) || row.author === f.own)
    t.ok(row.round >= 0 && row.round <= 2)
  }
  for (const p of f.pages) {
    const page = await call('page.read', { key: p.author, full: true })
    t.is(page.owner, f.own)
    t.is(page.isOwner, true)
    t.ok(page.follows.length > 0)
    for (const follow of page.follows) {
      keys(t, follow, ['key', 'seq'])
      const peek = await call('diary.peek', { author: p.author, seqs: [follow.seq] })
      t.is(peek.entries[0].record.type, 'follow')
      t.is(peek.entries[0].record.key, follow.key)
    }
    const feed = await call('page.feed', { page: p.author, keys: page.follows.map((p) => p.key) })
    t.ok(feed.items.length > 0)
    t.ok(feed.items.every((p) => page.follows.some((follow) => follow.key === p.author)))
  }
})

test('community and group actions update membership, catalogue, metadata and messages', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  for (const kind of ['group', 'community']) {
    const target = { [kind]: kind === 'group' ? f.groups[3].group : f.communities[1].community }
    const members = await call(kind + '.members', target)
    t.is(members.total, 6)
    for (const m of members.members) keys(t, m, ['member', 'name', 'username', 'admin', 'banned', 'joinedAt'])
    const paged = await call(kind + '.members', { ...target, offset: 2, limit: 2 })
    t.alike(paged.members, members.members.slice(2, 4))
    const requests = await call(kind + '.requests', target)
    t.ok(requests.total > 0)
    for (const m of requests.requests) keys(t, m, ['member', 'name', 'username', 'at'])
    const member = requests.requests[0].member
    t.alike((await call(kind + '.requests', { ...target, offset: 1, limit: 1 })).requests, requests.requests.slice(1, 2))
    await call(kind + '.admit', { ...target, member, on: true })
    t.is((await call(kind + '.requests', target)).total, requests.total - 1)
    t.is((await call(kind + '.members', target)).total, members.total + 1)
    await call(kind + '.admin', { ...target, member, on: true })
    t.is((await call(kind + '.members', target)).members.find((m) => m.member === member).admin, true)
    await call(kind + '.admin', { ...target, member, on: false })
    await call(kind + '.ban', { ...target, member, on: true })
    t.is((await call(kind + '.members', target)).members.find((m) => m.member === member).banned, true)
    await call(kind + '.ban', { ...target, member, on: false })
    t.is((await call(kind + '.members', target)).members.find((m) => m.member === member).banned, false)
    await call(kind + '.admit', { ...target, member, on: false })
    t.ok((await call(kind + '.requests', target)).requests.some((m) => m.member === member))
    await call(kind + '.meta', { ...target, name: 'Encontros e conversas', join: 'approval' })
    await call(kind + '.invitePolicy', { ...target, members: true })
    const info = await call(kind + '.info', target)
    t.is(info.name, 'Encontros e conversas')
    t.is(info.join, 'approval')
    t.is(info.memberInvite, true)
  }
  const created = await call('community.create', { name: 'Amigos da praça', join: 'open' })
  const community = created.community
  t.ok(/^[0-9a-f]{64}$/.test(community))
  const info = await call('community.info', { community })
  t.is(info.general, created.group)
  t.is(info.groups[0].general, true)
  t.is(info.role, 'creator')
  t.is(info.rootHere, true)
  t.is(info.members, 1)
  t.is(info.admins, 1)
  t.ok((await call('community.list')).communities.some((c) => c.community === community))
  const { group } = await call('group.create', { community, name: 'Ideias', join: 'open', visibility: 'private' })
  t.is((await call('group.info', { group })).join, 'approval')
  t.ok((await call('group.list')).groups.some((g) => g.group === group))
  const { seq } = await call('group.post', { group, text: 'Um encontro por semana.' })
  const posted = (await call('group.read', { group })).items[0]
  await call('group.hide', { group, target: { writer: posted.writer, seq }, on: true })
  const hidden = await call('group.read', { group })
  t.is(hidden.hidden, 1)
  t.is(hidden.items[0].text, '')
  t.is((await call('community.info', { community })).groups.find((g) => g.group === group).last.preview, '')
  await call('group.hide', { group, target: { writer: posted.writer, seq }, on: false })
  t.is((await call('group.read', { group })).items[0].text, posted.text)
  const rekey = await call('group.rekey', { group })
  keys(t, rekey.epoch, ['writer', 'seq'])
  t.alike((await call('group.read', { group })).epoch, rekey.epoch)
  await call('community.removeGroup', { community, group })
  t.alike((await call('community.info', { community })).dropped, [group])
  t.is((await call('group.info', { group })).orphan, true)
  t.absent((await call('group.list')).groups.some((g) => g.group === group))
  await call('community.removeGroup', { community, group, undo: true })
  t.ok((await call('community.info', { community })).groups.some((g) => g.group === group))
  await call('group.leave', { group })
  t.is((await call('group.info', { group })).canWrite, false)
  t.is((await call('group.join', { group })).state, 'requested')
  await call('group.admit', { group, member: f.own, on: true })
  t.is((await call('group.info', { group })).canWrite, true)
  await call('community.leave', { community })
  t.is((await call('community.info', { community })).role, 'left')
  t.is((await call('group.info', { group: created.group })).state, 'left')
  const joined = await call('community.join', { community })
  t.alike(joined, { state: 'member', group: created.group })
  t.is((await call('group.info', { group: created.group })).canWrite, true)
})

test('DM controls, age memory and sync transitions stay local and repeatable', async (t) => {
  const { fixtures: f, request } = await load()
  const { nodeVouches } = await import('../src/ageMemory.js')
  const call = (method, params) => answer(t, request, method, params)
  const peer = f.conversations[5].peer
  await call('dm.set', { peer, state: 'accepted' })
  t.is((await call('dm.thread', { peer })).folder, 'inbox')
  await call('dm.set', { peer, state: 'blocked' })
  t.is((await call('dm.thread', { peer })).blocked, true)
  t.absent((await call('dm.list')).conversations.some((c) => c.peer === peer))
  await refused(t, request, 'dm.send', { to: peer, text: 'Olá!' }, 'USAGE', 'você bloqueou esta pessoa')
  await call('dm.set', { peer, state: 'unblocked' })
  t.is((await call('dm.thread', { peer })).folder, 'inbox', 'acceptance survives a block')
  for (const state of ['declined', 'deleted']) {
    const peer = state === 'declined' ? f.conversations[6].peer : f.conversations[0].peer
    await call('dm.set', { peer, state })
    t.alike((await call('dm.thread', { peer })).messages, [])
  }
  const enabled = await call('dm.enable')
  t.ok(enabled.seq > 0)
  t.is((await call('dm.enable')).seq, null)
  t.alike(await call('dm.lookup', { member: f.own }), { box: enabled.box, gen: enabled.gen })
  const pull = await call('dm.pull')
  t.alike(await call('dm.pull'), pull)
  t.is(pull.added, 0, 'all fixture messages were already filed')
  const age = await call('age.proof', { verified: { date: f.now }, since: { since: f.now, date: f.now } })
  t.is(nodeVouches(age), true)
  let info = await call('node.info')
  for (const name of Object.keys(age)) t.is(info[name], age[name])
  await call('age.proof', { since: null })
  info = await call('node.info')
  t.is(info.ageSince, null)
  t.is(info.ageSinceUntil, null)
  t.is(nodeVouches(info), true)
  const run = await call('sync.start')
  t.alike(await call('sync.status'), { state: 'running', runId: run.runId, once: false })
  t.alike((await call('node.info')).sync, await call('sync.status'))
  t.alike(await call('sync.stop'), { stopped: true })
  t.alike(await call('sync.stop'), { stopped: false })
  t.is((await call('sync.start', { once: true })).runId, run.runId + 1)
  t.alike(await call('sync.status'), { state: 'idle' }, 'offline one-shot sync completes immediately')
  await call('sync.start')
  t.alike(await call('node.close'), { closed: true })
  t.alike(await call('sync.status'), { state: 'idle' })
  const params = samples(f)
  for (const method of destructive) await refused(t, request, method, params[method], 'USAGE', 'indisponível no modo vitrine')
  t.is((await call('identity.show')).publicKey, f.own)
})

test('page signing covers every documented result variant with fake signatures', async (t) => {
  const { fixtures: f, request } = await load()
  const nonce = 'v'.repeat(43)
  const signature = '0'.repeat(128)
  const page = f.pages[0].author
  const base = { gen: 1, at: f.now, nonce }
  const roster = { ...base, owner: f.own, admins: [], prev: null }
  const operations = {
    accept: { ...base, rosterSignature: signature },
    remove: roster,
    'transfer-accept': roster,
    offer: { ...base, to: f.members[1].author, exp: f.now },
    close: base,
    move: { ...base, to: f.pages[1].author, fromSeq: 9, owner: f.own, admins: [] },
    create: { username: 'pagina_praca', name: 'Praça', bio: '', roster: { ...base, admins: [], prev: null } },
    invite: { member: f.members[1].author, gen: 2, rosterSignature: '', roster: { owner: f.own, admins: [f.members[1].author], prev: signature, at: f.now, nonce } },
    terms: { version: 1, diary: f.own }
  }
  const fields = {
    'page-roster': ['type', 'page', 'gen', 'owner', 'admins', 'prev', 'at', 'nonce', 'association', 'signature'],
    'page-accept': ['type', 'page', 'gen', 'rosterSignature', 'at', 'nonce', 'actor', 'signature'],
    'page-offer': ['type', 'page', 'to', 'exp', 'gen', 'at', 'nonce', 'actor', 'signature'],
    'page-close': ['type', 'page', 'gen', 'at', 'nonce', 'actor', 'association', 'signature'],
    'page-moved': ['type', 'page', 'to', 'gen', 'at', 'nonce', 'actor', 'association', 'signature'],
    'page-origin': ['type', 'page', 'from', 'fromSeq', 'gen', 'owner', 'admins', 'at', 'nonce', 'actor', 'association', 'signature']
  }
  for (const [action, op] of Object.entries(operations)) {
    const result = await answer(t, request, 'page.sign', { action, nonce, page, op })
    if (result.signature) t.is(result.signature, signature)
    for (const field of ['record', 'origin', 'roster']) {
      const record = result[field]
      if (!record) continue
      keys(t, record, fields[record.type], action + ' ' + field)
      t.is(record.signature, signature)
    }
  }
  const cancelled = await answer(t, request, 'page.sign', { action: 'offer', nonce, page, op: { ...base, to: null, exp: null } })
  t.is(cancelled.record.to, null)
  t.is(cancelled.record.exp, null)
  for (const method of ['account.sign', 'age.sign', 'phone.sign', 'invite.sign', 'inviteCard.sign', 'push.sign', 'report.sign', 'appeal.sign', 'dm.reportSign', 'terms.sign', 'recovery.sign']) {
    t.is((await answer(t, request, method, samples(f)[method])).signature, signature)
  }
  // The development build never vouches for a card.
  t.alike(await answer(t, request, 'inviteCard.verify', samples(f)['inviteCard.verify']), { ok: false, reason: 'bad-signature' })
})

test('review shots retries collisions but stops on permanent failures and the retry cap', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vitrine-shots-'))
  t.teardown(() => rmSync(root, { recursive: true, force: true }))
  const script = join(__dirname, '../scripts/review-shots.sh')
  // Only a hang guard: the 1000-collision case forks a subshell per name, so
  // its time follows the load (about 1 s at load 5, past 5 s on a busier machine,
  // where the child was killed and the status came back null).
  const capture = (out, label) => spawnSync('bash', ['-c', `
    xcrun () {
      if [ "$2" = list ]; then echo '(Booted)'; else echo 'fixture-png' > "$6"; fi
    }
    export -f xcrun
    exec bash "$@"
  `, 'shots-test', script, 'ios', out, label], { encoding: 'utf8', timeout: 120000 })
  const out = join(root, 'shots')
  mkdirSync(out)
  writeFileSync(join(out, 'praca-ios-1.png'), 'previous')
  let result = capture(out, 'praca')
  t.is(result.status, 0, result.stderr)
  t.is(result.stdout.trim(), join(out, 'praca-ios-2.png'))
  t.is(readFileSync(join(out, 'praca-ios-1.png'), 'utf8'), 'previous')
  result = capture(out, 'x'.repeat(300))
  t.is(result.status, 1)
  t.ok(result.stderr.includes('Não foi possível criar o arquivo em ' + out))
  if (!process.getuid || process.getuid() !== 0) {
    chmodSync(out, 0o500)
    try {
      result = capture(out, 'unwritable')
      t.is(result.status, 1)
      t.ok(result.stderr.includes('Não foi possível criar o arquivo em ' + out))
    } finally {
      chmodSync(out, 0o700)
    }
  }
  const nonDirectory = join(root, 'file')
  writeFileSync(nonDirectory, 'occupied')
  result = capture(nonDirectory, 'praca')
  t.is(result.status, 1)
  t.ok(result.stderr.includes('Não foi possível criar o arquivo em ' + nonDirectory))
  mkdirSync(join(out, 'directory-ios-1.png'))
  result = capture(out, 'directory')
  t.is(result.status, 1, 'a directory at the target is not a filename collision')
  for (let n = 1; n <= 1000; n++) writeFileSync(join(out, `full-ios-${n}.png`), '')
  result = capture(out, 'full')
  t.is(result.status, 1, '1000 collisions stop')
  t.ok(result.stderr.includes('Não foi possível criar o arquivo em ' + out))
})

test('fixture chat photos validate, open through the Vitrine media handle and stay offline', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  const { mediaBounds } = require('@varanda/rpc')
  const dm = f.conversations.flatMap((c) => c.messages.filter((m) => m.media).map((m) => ({ c, m })))
  t.is(dm.length, 2)
  t.alike(dm.map(({ m }) => [m.text === '', m.media.length]), [[true, 1], [false, 2]], 'one photo-only message and one caption with two photos')
  for (const { c, m } of dm) t.ok(validateParams('dm.send', { to: c.peer, text: m.text, media: m.media }).ok, 'dm media items match the contract')
  const groupItems = f.groups.flatMap((g) => g.items.filter((item) => item.media).map((item) => ({ g, item })))
  t.alike(groupItems.map(({ g, item }) => [g.visibility, item.media.length]), [['public', 1], ['public', 3], ['private', 1]])
  for (const { g, item } of groupItems) {
    const sealed = g.visibility === 'private'
    t.ok(validateParams('group.post', { group: g.group, text: item.text, media: item.media, ...(sealed ? { sealed: true } : {}) }).ok, 'group media items match the contract')
  }

  const request = createVitrineRequest(f)
  const media = request.media
  const thread = (await answer(t, request, 'dm.thread', { peer: dm[1].c.peer })).messages
  t.alike(thread[thread.length - 1].media, dm[1].m.media)
  const refs = [
    ...dm.flatMap(({ m }) => m.media.map((item, index) => ({ kind: 'dm', from: m.from, id: m.id, index }))),
    ...groupItems.filter(({ g }) => g.visibility === 'private').flatMap(({ item }) => item.media.map((m) => ({ kind: 'group', diary: item.diary, item: m })))
  ]
  t.is(refs.length, 4)
  for (const ref of refs) {
    const got = await media.read(ref)
    t.is(got.mime, 'image/jpeg')
    t.is(mediaBounds(got.bytes, got.mime).width, got.w)
    got.bytes.fill(0)
    t.ok((await media.read(ref)).bytes.some((b) => b !== 0), 'every read hands over fresh bytes')
  }
  // Public items open from the same pictures (the sha256 names the drawing).
  for (const { g, item } of groupItems) {
    if (g.visibility === 'public') for (const m of item.media) t.is((await media.read({ kind: 'group', diary: item.diary, item: m })).mime, 'image/jpeg')
  }
  for (const bad of [null, {}, { kind: 'dm', from: f.own, id: 'f'.repeat(32), index: 0 }, { kind: 'group', diary: f.own, item: { sha256: unknown } }]) {
    try {
      await media.read(bad)
      t.fail('an unknown ref must reject')
    } catch (err) {
      t.ok(err instanceof Error)
    }
  }

  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
  const item = await media.putDm({ bytes, mime: 'image/jpeg', width: 640, height: 480 })
  const peer = f.conversations[0].peer
  t.ok(validateParams('dm.send', { to: peer, text: '', media: [item] }).ok)
  const sent = await answer(t, request, 'dm.send', { to: peer, text: '', media: [item] })
  t.alike((await media.read({ kind: 'dm', from: f.own, id: sent.id, index: 0 })).bytes, bytes, 'a photo sent here opens again')
  t.is((await answer(t, request, 'dm.list', {})).conversations.find((c) => c.peer === peer).preview, 'Foto')
  const pub = await media.upload({ bytes, mime: 'image/jpeg', width: 640, height: 480 })
  const sealed = await media.upload({ bytes, mime: 'image/jpeg', width: 640, height: 480, sealed: true })
  t.ok(validateParams('group.post', { group: f.groups[0].group, text: '', media: [pub] }).ok)
  t.ok(validateParams('group.post', { group: f.groups[3].group, text: '', media: [sealed], sealed: true }).ok)
  await answer(t, request, 'group.post', { group: f.groups[3].group, text: '', media: [sealed], sealed: true })
  t.alike((await media.read({ kind: 'group', diary: f.own, item: sealed })).bytes, bytes)
  t.is(media.forgetReadFile('x'), undefined)
  t.is(media.clearReadFiles(), undefined)
  await t.exception(() => media.putDm({ bytes: new Uint8Array(0), mime: 'image/jpeg', width: 1, height: 1 }))
  await t.exception(() => media.upload({ bytes, mime: 'image/bmp', width: 1, height: 1 }))

  for (const file of ['media.js', 'pictures.js']) {
    const source = readFileSync(join(__dirname, '../src/vitrine', file), 'utf8')
    t.absent(/https?:\/\//.test(source), file + ' has no network address')
  }
})

test('the Mural has photo posts to show: own, followed and not followed', async (t) => {
  const { fixtures: f, request } = await load()
  const { tilesFromLog, tilesFromItems } = await import('../src/mural.js')
  const rows = []
  let before
  const pages = []
  for (;;) {
    const page = await answer(t, request, 'log.read', { limit: LOG_LIMIT_MAX, ...(before !== undefined ? { before } : {}) })
    if (page.entries.length === 0) break
    pages.push(page.entries)
    rows.push(...page.entries.map((entry) => ({ seq: entry.seq, entry })))
    before = page.entries[0].seq
    if (before === 0) break
  }
  t.ok(pages.length >= 2, 'the own log needs more than one page')
  const tiles = tilesFromLog(f.own, rows)
  t.ok(tiles.length >= 8, 'at least 8 own tiles')
  t.ok(pages.every((entries) => tilesFromLog(f.own, entries.map((entry) => ({ seq: entry.seq, entry }))).length > 0), 'every log page holds tiles')
  for (const tile of tiles) t.ok(tile.media.length >= 1 && tile.media.length <= 4)
  t.ok(tiles.some((tile) => tile.media.length === 1) && tiles.some((tile) => tile.media.length === 4))
  const ownPosts = f.feed.filter((p) => p.author === f.own)
  t.ok(ownPosts.some((p) => p.media && p.text === ''), 'some photo-only posts')
  const reply = ownPosts.find((p) => p.replyTo && p.media)
  t.ok(reply, 'a reply with media')
  t.absent(tiles.some((tile) => tile.seq === reply.seq), 'the reply is no tile')
  const repost = rows.find((row) => row.entry.record.type === 'repost')
  t.ok(repost, 'a repost in the own log')
  t.absent(tiles.some((tile) => tile.seq === repost.seq), 'the repost is no tile')
  const followed = f.members[1]
  const stranger = f.members[4]
  t.ok(f.follows.includes(followed.author))
  t.absent(f.follows.includes(stranger.author))
  for (const member of [followed, stranger]) {
    t.ok(tilesFromItems(f.feed.filter((p) => p.author === member.author)).length >= 4, member.username + ' has tiles')
  }
})

test('public post photos are valid descriptors that name a real drawing', async (t) => {
  const { fixtures: f } = await load()
  const { postPictureBytes } = await import('../src/vitrine/fixtures.js')
  const { validDescriptor } = await import('../src/media/fetch.js')
  const { sha256 } = await import('@noble/hashes/sha2.js')
  const seen = new Set()
  const media = f.feed.flatMap((p) => (p.media || []).map((d) => ({ p, d })))
  t.ok(media.length >= 20)
  for (const { p, d } of media) {
    t.ok(validDescriptor(d), 'descriptor is valid')
    const bytes = postPictureBytes(d.sha256)
    t.ok(bytes, 'names a drawing')
    t.is(bytes.byteLength, d.bytes)
    t.is(Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join(''), d.sha256)
    const id = [p.author, d.core, d.start].join(':')
    t.absent(seen.has(id), 'one drawing per author, core and start')
    seen.add(id)
  }
})

test('the media client reads a fixture post photo through the Vitrine responder', async (t) => {
  const { fixtures: f } = await load()
  const { fetchMedia } = await import('../src/media/fetch.js')
  const { vitrineMediaResponse } = await import('../src/vitrine/publicMedia.js')
  const { postPictureBytes } = await import('../src/vitrine/fixtures.js')
  const post = f.feed.find((p) => p.author === f.own && p.media)
  const d = post.media[0]
  const bytes = await fetchMedia(post.author, d, { fetch: vitrineMediaResponse })
  t.alike(Array.from(bytes), Array.from(postPictureBytes(d.sha256)))
  const url = '/media/' + post.author + '/' + d.core + '/' + d.start + '/' + d.blocks
  const first = await vitrineMediaResponse(url)
  t.is(first.status, 200)
  t.is(first.url, '')
  t.is(first.redirected, false)
  const one = new Uint8Array(await first.arrayBuffer())
  one[0] = 0
  t.is(new Uint8Array(await (await vitrineMediaResponse(url)).arrayBuffer())[0], 0xff, 'fresh copy each call')
  for (const bad of [
    '/media/' + post.author + '/' + d.core + '/' + (d.start + 500) + '/1',
    '/media/' + 'f'.repeat(64) + '/' + d.core + '/' + d.start + '/1',
    '/media/' + post.author + '/' + d.core + '/' + d.start,
    '/media/' + post.author + '/' + d.core + '/' + d.start + '/1/x',
    '/media/__proto__/constructor/1/1',
    '/other/' + post.author + '/' + d.core + '/' + d.start + '/1'
  ]) t.is((await vitrineMediaResponse(bad)).status, 404, bad)
})

test('depoimentos: fixtures validate, pending is shown, removed and revoked', async (t) => {
  const { fixtures: f, request } = await load()
  const { validateRecord } = require('@varanda/core/lib/records')
  const { verifyShow } = require('@varanda/core/lib/testimonials')
  const call = (method, params) => answer(t, request, method, params)
  const [joao, cecilia, bia] = [f.members[1].author, f.members[2].author, f.members[4].author]
  const records = f.diaryRecords.filter((e) => e.record.type === 'testimonial' || e.record.type === 'testimonial-show')
  t.is(records.length, 7)
  for (const e of records) t.is(validateRecord(e.record, e.seq), null, e.record.type + ' ' + e.author.slice(0, 4) + ':' + e.seq + ' validates')
  for (const s of f.sealed) {
    t.ok([...s.text].length <= 400 && !s.text.includes(String.fromCharCode(0x2014)), 'text fits and has no em dash')
    const show = records.find((e) => e.record.type === 'testimonial-show' && e.record.from === s.author && e.record.seq === s.seq)
    const block = records.find((e) => e.author === s.author && e.seq === s.seq).record
    if (show) t.ok(verifyShow(show.record, block, show.author), 'fixture show verifies like the web node')
  }
  t.ok(f.sealed.some((s) => s.text.length > 200), 'one long text checks wrapping')
  const refs = f.diaryRecords.map((e) => e.author + ':' + e.seq)
  t.is(new Set(refs).size, refs.length, 'every (author, seq) is unique')

  await refused(t, request, 'testimonial.write', { to: f.own, text: 'Eu mesma.' }, 'USAGE', 'não pode escrever um depoimento para si')
  await refused(t, request, 'testimonial.write', { to: 'e'.repeat(64), text: 'Olá!' }, 'USAGE', 'a pessoa ainda não recebe mensagens')
  await refused(t, request, 'testimonial.write', { to: cecilia, text: 'a' + String.fromCharCode(7) }, 'USAGE', 'registro inválido: malformed')
  const written = await call('testimonial.write', { to: cecilia, text: 'Cecília cuida da horta e de todo mundo.' })
  const writtenPeek = await call('diary.peek', { author: f.own, seqs: [written.seq] })
  t.is(validateRecord(writtenPeek.entries[0].record, written.seq), null, 'a written block validates')
  t.is(writtenPeek.entries[0].record.to, cecilia)

  const pending = await call('testimonial.pending', {})
  t.alike(pending.items.map((i) => [i.from, i.seq]), [[bia, 60]], 'only the pending block, never a shown one')
  for (const item of pending.items) keys(t, item, ['from', 'seq', 'text', 'at'])
  t.alike((await call('testimonial.pending', {})).kept, [], 'nothing kept yet')
  await refused(t, request, 'testimonial.decide', { from: f.own, seq: 60, state: 'kept' }, 'USAGE', 'referência inválida')
  await refused(t, request, 'testimonial.decide', { from: bia, seq: 60, state: 'nope' }, 'USAGE', 'parâmetro inválido: state')
  t.alike(await call('testimonial.decide', { from: bia, seq: 60, state: 'kept' }), { changed: true })
  t.alike(await call('testimonial.decide', { from: bia, seq: 60, state: 'kept' }), { changed: false }, 'same decision changes nothing')
  t.alike((await call('testimonial.pending', {})).items, [], 'a kept one leaves the pending list')
  t.alike((await call('testimonial.pending', {})).kept.map((i) => [i.from, i.seq]), [[bia, 60]])
  t.alike(await call('testimonial.decide', { from: bia, seq: 60, state: 'declined', ifNew: true }), { changed: false }, 'ifNew keeps the decision')
  await refused(t, request, 'testimonial.show', { from: joao, seq: 3 }, 'USAGE', 'depoimento não encontrado')
  const shown = await call('testimonial.show', { from: bia, seq: 60 })
  t.alike(await call('testimonial.show', { from: bia, seq: 60 }), shown, 'showing again writes nothing')
  t.alike((await call('testimonial.pending', {})).items, [])
  const peek = await call('diary.peek', { author: f.own, seqs: [36, 37, shown.seq] })
  t.alike(peek.entries.map((e) => e.seq), [36, 37, shown.seq])
  t.alike(peek.invalid, [])

  const removed = await call('testimonial.delete', { to: shown.ref })
  t.alike(removed.deleted, [shown.seq])
  t.alike(await call('testimonial.delete', { to: shown.ref }), removed, 'a removed show answers its tombstone')
  t.alike((await call('diary.peek', { author: f.own, seqs: [shown.seq] })).missing, [shown.seq])
  t.alike((await call('testimonial.pending', {})).items, [], 'a removed show never returns to pending')
  t.alike((await call('testimonial.pending', {})).kept.map((i) => [i.from, i.seq]), [[bia, 60]], 'a kept one returns to kept after its show is removed')

  // Lia revokes the one she wrote to João: João's show of it turns invalid.
  await refused(t, request, 'testimonial.delete', { to: `${f.own}:38`, about: cecilia }, 'USAGE', 'referência inválida')
  await refused(t, request, 'testimonial.delete', { to: `${f.own}:36`, about: joao }, 'USAGE', 'referência inválida')
  const revoked = await call('testimonial.delete', { to: `${f.own}:38`, about: joao })
  t.alike(revoked.deleted, [38])
  const joaoPeek = await call('diary.peek', { author: joao, seqs: [61] })
  t.alike(joaoPeek.invalid, [61])
  t.alike(joaoPeek.entries, [])
  await refused(t, request, 'testimonial.delete', { to: `${f.own}:3` }, 'USAGE', 'referência inválida')
  await refused(t, request, 'testimonial.delete', { to: `${joao}:61` }, 'USAGE', 'referência inválida')
})

test('momentos: a reaction keeps its moment seq on dm.thread', async (t) => {
  const { fixtures: f, request } = await load()
  const peer = f.follows.find((a) => f.diaryRecords.some((e) => e.author === a && e.record.type === 'moment'))
  const seq = Math.max(...f.diaryRecords.filter((e) => e.record.type === 'moment' && e.author === peer).map((e) => e.seq))
  await answer(t, request, 'moment.lookup', { author: peer, seq })
  const gone = await request('dm.send', { to: peer, text: '❤️', moment: 999999 }).then(() => null, (err) => err)
  t.is(gone && gone.message, 'momento não encontrado', 'a seq that is not showing is refused, like the node')
  t.absent((await answer(t, request, 'dm.thread', { peer })).messages.some((m) => m.moment === 999999), 'the refused reaction is not stored')
  const listed = async () => (await answer(t, request, 'dm.list', { folder: 'inbox' })).conversations.find((c) => c.peer === peer).preview
  const withMoment = await answer(t, request, 'dm.send', { to: peer, text: '❤️', moment: seq })
  t.is(await listed(), 'Reagiu a um momento ❤️', 'the list shows the node label, never the seq')
  const plain = await answer(t, request, 'dm.send', { to: peer, text: 'Oi' })
  t.is(await listed(), 'Oi', 'a plain message after it previews its text')
  const rows = (await answer(t, request, 'dm.thread', { peer })).messages
  t.is(rows.find((m) => m.id === withMoment.id).moment, seq, 'the reaction carries the moment')
  t.absent('moment' in rows.find((m) => m.id === plain.id), 'a plain message stores no moment key')
})

test('momentos: fixtures validate, moments.read follows the 24 h rule and the caps', async (t) => {
  const { fixtures: f, request, createVitrineRequest } = await load()
  const { validateRecord } = require('@varanda/core/lib/records')
  const call = (method, params) => answer(t, request, method, params)
  const [joao, cecilia, andre] = [f.members[1].author, f.members[2].author, f.members[3].author]
  const records = f.diaryRecords.filter((e) => e.record.type === 'moment')
  t.is(records.length, 7)
  for (const e of records) {
    t.is(validateRecord(e.record, e.seq), null, 'moment ' + e.author.slice(0, 4) + ':' + e.seq + ' validates')
    t.ok(validateParams('moment.create', { text: e.record.text, media: e.record.media }).ok, 'its media item matches the contract')
    t.ok([...e.record.text].length <= 200 && !e.record.text.includes(String.fromCharCode(0x2014)), 'text fits and has no em dash')
    t.ok(e.author === f.own || f.follows.includes(e.author), 'only followed diaries and Lia have moments')
  }
  t.is(new Set(records.map((e) => e.record.media.id)).size, records.length, 'every moment has its own blob')

  const read = await call('moments.read', {})
  t.alike(read.authors.map((a) => [a.author, a.items.map((i) => i.seq)]), [[joao, [71, 70]], [cecilia, [70]], [andre, [70]]], 'authors by newest moment, items newest first')
  for (const a of read.authors) {
    keys(t, a, ['author', 'items'])
    for (const item of a.items) {
      keys(t, item, ['seq', 'ref', 'text', 'at', 'media', 'music'])
      t.is(item.ref, a.author + ':' + item.seq)
      const age = Date.parse(f.now) - Date.parse(item.at)
      t.ok(age >= 0 && age < 86400000, 'inside the 24 h of the demo clock')
    }
  }
  t.alike(read.own.map((i) => i.seq), [48])
  t.alike(read.past.map((i) => i.seq), [47, 46], 'past moments newest first')
  for (const item of read.past) keys(t, item, ['seq', 'ref', 'text', 'at'])
  t.absent(read.authors.some((a) => a.author === f.own), 'the own key is never among the authors')

  await call('follow.remove', { key: cecilia })
  t.alike((await call('moments.read', {})).authors.map((a) => a.author), [joao, andre], 'an unfollowed diary leaves the strip')

  // The app hides moments by the device clock: options.clock moves every
  // date by the same distance, so the ages stay those of the demo clock.
  const later = Date.parse(f.now) + 3 * 86400000
  const moved = await answer(t, createVitrineRequest(f, { clock: () => later }), 'moments.read', {})
  t.alike(moved.authors.map((a) => a.items.map((i) => Date.parse(i.at) - 3 * 86400000)), read.authors.map((a) => a.items.map((i) => Date.parse(i.at))))
  t.is(Date.parse(moved.past[0].at), Date.parse(read.past[0].at) + 3 * 86400000)
  t.alike(moved.authors.map((a) => a.items.map((i) => i.seq)), read.authors.map((a) => a.items.map((i) => i.seq)), 'the same moments show')
})

test('momentos: putMoment, moment.create, the photo read and moment.delete', async (t) => {
  const { fixtures: f, request } = await load()
  const { mediaBounds } = require('@varanda/rpc')
  const call = (method, params) => answer(t, request, method, params)
  const media = request.media
  const joao = f.members[1].author

  const got = await media.read({ kind: 'moment', author: joao, seq: 71 })
  t.is(got.mime, 'image/jpeg')
  t.is(mediaBounds(got.bytes, got.mime).width, got.w)
  const gone = async (ref, label) => {
    try {
      await media.read(ref)
      t.fail(label + ' must reject')
    } catch (err) {
      t.is(err.code, 'NOT_FOUND', label)
      t.is(err.message, 'foto indisponível')
    }
  }
  await gone({ kind: 'moment', author: f.own, seq: 46 }, 'a past moment')
  await gone({ kind: 'moment', author: joao, seq: 3 }, 'a post is no moment')
  await gone({ kind: 'moment', author: unknown, seq: 1 }, 'an unknown diary')

  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
  const given = new Uint8Array(bytes)
  const item = await media.putMoment({ bytes: given, mime: 'image/jpeg', width: 640, height: 480 })
  t.ok(given.every((b) => b === 0), 'putMoment wipes the bytes it was given')
  t.ok(validateParams('moment.create', { text: '', media: item }).ok, 'the item matches the contract')
  // A photo past one 32 KiB chunk still makes a valid item.
  const big = await media.putMoment({ bytes: new Uint8Array(100000).fill(1), mime: 'image/jpeg', width: 1080, height: 1350 })
  t.is(big.chunks, Math.ceil((100000 + 16) / 32768), 'chunks follow the ciphertext size')
  t.ok(validateParams('moment.create', { text: '', media: big }).ok, 'a large photo matches the contract too')
  const other = await media.putMoment({ bytes: new Uint8Array(bytes), mime: 'image/png', width: 10, height: 10 })
  t.not(other.id, item.id, 'every photo is a fresh blob')
  await t.exception(() => media.putMoment({ bytes: new Uint8Array(0), mime: 'image/jpeg', width: 1, height: 1 }))
  await t.exception(() => media.putMoment({ bytes, mime: 'audio/mp4', width: 1, height: 1 }))

  await refused(t, request, 'moment.create', { text: 'Oi', media: f.diaryRecords.find((e) => e.record.type === 'moment').record.media }, 'USAGE', 'prepare a mídia de novo')
  const created = await call('moment.create', { text: 'Na praça agora.', media: item })
  t.is(created.ref, f.own + ':' + created.seq)
  await refused(t, request, 'moment.create', { text: 'De novo', media: item }, 'USAGE', 'prepare a mídia de novo')
  const peek = await call('diary.peek', { author: f.own, seqs: [created.seq] })
  t.alike(Object.keys(peek.entries[0].record).sort(), ['at', 'media', 'text', 'type'])
  t.alike((await call('moments.read', {})).own.map((i) => i.seq), [created.seq, 48], 'the new moment shows first')
  t.alike((await media.read({ kind: 'moment', author: f.own, seq: created.seq })).bytes, bytes, 'its photo opens again')

  for (let i = 0; i < 4; i++) await call('moment.create', { text: 'Mais um ' + i, media: await media.putMoment({ bytes: new Uint8Array(bytes), mime: 'image/jpeg', width: 8, height: 8 }) })
  const full = await call('moments.read', {})
  t.is(full.own.length, 4, 'at most four own moments')

  await refused(t, request, 'moment.delete', { to: joao + ':70' }, 'USAGE', 'referência inválida')
  await refused(t, request, 'moment.delete', { to: f.own + ':3' }, 'USAGE', 'referência inválida')
  await refused(t, request, 'moment.delete', { to: f.own + ':999' }, 'USAGE', 'referência inválida')
  const removed = await call('moment.delete', { to: f.own + ':48' })
  t.alike(removed.deleted, [48])
  t.alike(await call('moment.delete', { to: f.own + ':48' }), removed, 'a deleted moment answers its tombstone')
  await gone({ kind: 'moment', author: f.own, seq: 48 }, 'a deleted moment')
  const pastRemoved = await call('moment.delete', { to: f.own + ':47' })
  t.alike(pastRemoved.deleted, [47])
  const after = await call('moments.read', {})
  t.absent(after.own.some((i) => i.seq === 48))
  t.alike(after.past.map((i) => i.seq), [46], 'a past moment can be deleted too')
  t.alike((await call('diary.peek', { author: f.own, seqs: [48] })).missing, [48])
})

test('group reactions replace, remove and hide without leaking reactor keys in reads', async (t) => {
  const { fixtures: f, request, createVitrineRequest } = await load()
  const group = f.groups[0].group
  const item = f.groups[0].items[0]
  const target = { writer: item.writer, seq: item.seq }
  const read = async () => (await request('group.read', { group })).items.find((p) => p.writer === target.writer && p.seq === target.seq)
  const react = (emoji) => answer(t, request, 'group.react', { group, target, emoji })
  t.alike((await read()).reactions, item.reactions)
  await react('❤️')
  t.alike((await read()).reactions, item.reactions, 'same emoji is a no-op')
  await react('😂')
  t.alike((await read()).reactions.find((r) => r.emoji === '❤️'), { emoji: '❤️', count: 1, mine: false })
  t.alike((await read()).reactions.find((r) => r.mine), { emoji: '😂', count: 1, mine: true })
  const who = await answer(t, request, 'group.reactors', { group, target })
  t.alike(who.reactions.find((r) => r.emoji === '😂').by, [f.own])
  t.ok((await read()).reactions.every((r) => !Object.hasOwn(r, 'by')))
  await react('')
  t.absent((await read()).reactions.some((r) => r.mine || r.emoji === '😂'))
  await react('👍')
  t.alike((await read()).reactions.find((r) => r.mine), { emoji: '👍', count: 2, mine: true })
  await request('group.hide', { group, target, on: true })
  t.absent(Object.hasOwn(await read(), 'reactions'))
  await refused(t, request, 'group.react', { group, target, emoji: '👍' }, 'USAGE')
  await refused(t, request, 'group.reactors', { group, target }, 'USAGE')
  await request('group.hide', { group, target, on: false })
  t.ok((await read()).reactions.some((r) => r.mine))
  t.alike((await createVitrineRequest(f)('group.read', { group })).items.find((p) => p.writer === target.writer).reactions, item.reactions, 'instances are isolated')
  await request('group.leave', { group })
  await refused(t, request, 'group.react', { group, target, emoji: '👍' }, 'USAGE')
})

test('DM reactions replace and remove only mine without changing inbox previews or unread', async (t) => {
  const { fixtures: f, request } = await load()
  const { pageReadKind } = await import('../src/pageNotice.js')
  const peer = f.conversations[0].peer
  const first = f.conversations[0].messages[0]
  const target = { from: first.from, id: first.id }
  const inbox = await answer(t, request, 'dm.list')
  const read = () => answer(t, request, 'dm.thread', { peer })
  t.alike((await read()).messages[0].reactions, [{ emoji: '❤️', mine: true }, { emoji: '❤️', mine: false }])
  const react = (emoji) => answer(t, request, 'dm.react', { to: peer, target, emoji })
  t.alike(await react('👍'), { ok: true })
  t.alike((await read()).messages[0].reactions, [{ emoji: '❤️', mine: false }, { emoji: '👍', mine: true }])
  const replaced = await read()
  await react('👍')
  t.alike(await read(), replaced, 'same choice is a no-op')
  await react('')
  t.alike((await read()).messages[0].reactions, [{ emoji: '❤️', mine: false }])
  await react('❤️')
  t.alike((await read()).messages[0].reactions, [{ emoji: '❤️', mine: false }, { emoji: '❤️', mine: true }])
  t.alike(await answer(t, request, 'dm.list'), inbox, 'preview, ordering and unread are unchanged')
  const { dmReactionGate } = await import('../src/dm-screen.js')
  const readPeer = await answer(t, request, 'page.read', { key: peer })
  t.is(readPeer.complete, false)
  t.alike(dmReactionGate({ read: readPeer, peer, peerKind: pageReadKind(readPeer, peer), hosted: true, unlocked: true, online: true, isTop: true, folder: 'inbox' }), { hidden: false, disabled: false })
  const completePeer = f.members[2].author
  t.is(pageReadKind(await answer(t, request, 'page.read', { key: completePeer }), completePeer), 'person')
  const page = f.pages[0].author
  t.is(pageReadKind(await answer(t, request, 'page.read', { key: page }), page), 'page')
  const clean = f.conversations[0].messages[1]
  const ownTarget = { from: clean.from, id: clean.id }
  await answer(t, request, 'dm.react', { to: peer, target: ownTarget, emoji: '👍' })
  await answer(t, request, 'dm.react', { to: peer, target: ownTarget, emoji: '' })
  t.absent((await read()).messages[1].reactions, 'empty reactions are omitted')
})

test('DM reaction refusals preserve the thread and identify both sender and id', async (t) => {
  const { fixtures: f, request } = await load()
  const peer = f.conversations[0].peer
  const target = { from: f.conversations[0].messages[0].from, id: f.conversations[0].messages[0].id }
  const before = await answer(t, request, 'dm.thread', { peer })
  await refused(t, request, 'dm.react', { to: peer, target: { ...target, from: f.own }, emoji: '👍' }, 'USAGE', 'mensagem não encontrada')
  const oldPeer = f.conversations[1].peer
  const old = f.conversations[1].messages[0]
  const oldThread = await answer(t, request, 'dm.thread', { peer: oldPeer })
  t.is(oldThread.messages.find((m) => m.id === old.id).reactable, false, 'an older message takes no reaction')
  t.ok(oldThread.messages.filter((m) => m.id !== old.id).every((m) => !('reactable' in m)), 'the key is absent elsewhere')
  await refused(t, request, 'dm.react', { to: oldPeer, target: { from: old.from, id: old.id }, emoji: '👍' }, 'USAGE', 'esta mensagem não aceita reações')
  t.alike(await answer(t, request, 'dm.thread', { peer: oldPeer }), oldThread)
  await refused(t, request, 'dm.react', { to: unknown, target, emoji: '👍' }, 'USAGE', 'mensagem não encontrada')
  await refused(t, request, 'dm.react', { to: peer, target, emoji: 'not an emoji' }, 'USAGE')
  t.alike(await answer(t, request, 'dm.thread', { peer }), before)
  await answer(t, request, 'dm.set', { peer, state: 'blocked' })
  await refused(t, request, 'dm.react', { to: peer, target, emoji: '👍' }, 'USAGE', 'você bloqueou esta pessoa')
  t.alike((await answer(t, request, 'dm.thread', { peer })).messages, before.messages)
})

test('a conversation without a profile has an unknown diary with no roster evidence', async (t) => {
  const { fixtures: f, request } = await load()
  const { pageReadKind } = await import('../src/pageNotice.js')
  const { dmReactionGate } = await import('../src/dm-screen.js')
  const peers = f.conversations.filter((c) => !f.members.some((p) => p.author === c.peer) && !f.pages.some((p) => p.author === c.peer))
  t.ok(peers.length > 0)
  for (const { peer } of peers) {
    const read = await answer(t, request, 'page.read', { key: peer })
    t.alike({ complete: read.complete, gen: read.gen, owner: read.owner }, { complete: false, gen: null, owner: null })
    t.is(pageReadKind(read, peer), 'unknown')
    t.alike(dmReactionGate({ read, peer, peerKind: pageReadKind(read, peer), hosted: true, unlocked: true, online: true, isTop: true, folder: 'inbox' }), { hidden: false, disabled: false })
  }
})

test('group reactions outside the 12 shown stay counted and come back, as in the core fold', async (t) => {
  const { fixtures, createVitrineRequest } = await load()
  const f = clone(fixtures)
  const item = f.groups[0].items[0]
  const twelve = Array.from({ length: 12 }, (_, i) => String.fromCodePoint(0x1f601 + i))
  item.reactions = twelve.map((emoji) => ({ emoji, count: 1, mine: false }))
  const request = createVitrineRequest(f)
  const group = f.groups[0].group
  const target = { writer: item.writer, seq: item.seq }
  const read = async () => (await request('group.read', { group })).items.find((p) => p.writer === target.writer && p.seq === target.seq)
  // A tie goes to the emoji first used: a 13th emoji is the one cut, even
  // one whose text sorts before the twelve.
  await answer(t, request, 'group.react', { group, target, emoji: '\u{1f600}' })
  const shown = (await read()).reactions.map((r) => r.emoji)
  t.alike(shown, twelve)
  t.absent((await read()).reactions.some((r) => r.mine), 'the own emoji is counted but not shown')
  const who = await answer(t, request, 'group.reactors', { group, target })
  t.alike(who.reactions.map((r) => r.emoji), shown, 'group.reactors lists the same 12')
  // Moving the reaction onto a shown emoji counts it there.
  await answer(t, request, 'group.react', { group, target, emoji: twelve[11] })
  t.alike((await read()).reactions[0], { emoji: twelve[11], count: 2, mine: true })
  await answer(t, request, 'group.react', { group, target, emoji: '' })
  t.alike((await read()).reactions, twelve.map((emoji) => ({ emoji, count: 1, mine: false })))
})

test('post.share, post.shared and post.unshare follow the newest live share', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  const to = samples(f)['post.shared'].to
  t.alike(await call('post.shared', { to }), { shareSeq: null })
  t.alike(await call('post.unshare', { to }), { ok: true, changed: false }, 'nothing to withdraw')
  const first = await call('post.share', { to })
  t.is(first.created, true)
  t.ok(Number.isSafeInteger(first.shareSeq) && first.shareSeq > Number(to.split(':')[1]))
  t.alike(await call('post.shared', { to }), { shareSeq: first.shareSeq })
  t.alike(await call('post.share', { to }), { shareSeq: first.shareSeq, created: false }, 'a live share is not written twice')
  t.alike(await call('post.unshare', { to }), { ok: true, changed: true })
  t.alike(await call('post.shared', { to }), { shareSeq: null })
  t.alike(await call('post.unshare', { to }), { ok: true, changed: false })
  const again = await call('post.share', { to })
  t.is(again.created, true)
  t.ok(again.shareSeq > first.shareSeq, 'a new share after a withdrawal is a new block')
  t.alike(await call('post.shared', { to }), { shareSeq: again.shareSeq })
  for (const method of ['post.shared', 'post.share', 'post.unshare']) {
    await refused(t, request, method, { to: `${f.members[1].author}:3` }, 'USAGE', 'referência inválida')
    await refused(t, request, method, { to: `${f.own}:1` }, 'USAGE', 'o registro não é uma publicação')
    await refused(t, request, method, { to: `${f.own}:0` }, 'USAGE')
  }
  const post = await call('post.create', { text: 'Some daqui a pouco.' })
  await call('post.delete', { to: post.ref })
  for (const method of ['post.shared', 'post.share', 'post.unshare']) await refused(t, request, method, { to: post.ref }, 'USAGE', 'referência inválida')
})

test('the demo feed shows the hashtag posts, so a tag can be tapped there', async (t) => {
  const { fixtures: f, request } = await load()
  const { textSegments } = await import('../src/links.js')
  const feed = await answer(t, request, 'feed.read', { limit: FEED_LIMIT_MAX })
  const tagged = feed.items.filter((p) => typeof p.text === 'string' && textSegments(p.text, { hashtags: true }).some((s) => s.tag === 'festajunina'))
  t.ok(tagged.length >= 2, 'feed.read lists posts with a #festajunina tag segment')
  t.ok(feed.items.some((p) => p.text === 'Que saudade da festajunina do bairro, com a turma toda reunida.'), 'the bare-word post is in the feed too')
  t.absent(f.noticePosts.some((p) => typeof p.text === 'string' && p.text.includes('#festajunina')), 'not hidden among the notice posts')
})

test('the diary poll: post.create poll, choice.set, choice.mine and the index route agree', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  const request = createVitrineRequest(f)
  const call = (method, params) => answer(t, request, method, params)
  const ref = `${f.own}:60`
  const post = (await call('feed.read', {})).items.find((p) => p.author === f.own && p.seq === 60)
  t.alike(post.poll, ['Sábado de manhã', 'Sábado à tarde', 'Domingo'])
  t.alike(await call('choice.mine', { to: ref }), { pick: 0, seq: 61 }, 'the seeded own vote')
  const seq = (await call('choice.set', { to: ref, pick: 2 })).seq
  t.alike(await call('choice.mine', { to: ref }), { pick: 2, seq })
  const withdrawn = (await call('choice.set', { to: ref, pick: null })).seq
  t.alike(await call('choice.mine', { to: ref }), { pick: null, seq: null }, 'null withdraws')
  t.ok(withdrawn > seq)
  await refused(t, request, 'choice.set', { to: ref, pick: 3 }, 'USAGE', 'opção inválida')
  await refused(t, request, 'choice.set', { to: `${f.own}:3`, pick: 0 }, 'USAGE', 'a publicação não é uma enquete')
  t.alike(await call('choice.mine', { to: `${f.own}:3` }), { pick: null, seq: null }, 'choice.mine reads the own diary alone, as the web node')
  await call('choice.set', { to: `${f.own}:3`, pick: null })
  const made = await call('post.create', { text: 'Café ou chá?', poll: ['Café', 'Chá'] })
  const created = (await call('feed.read', {})).items.find((p) => p.seq === made.seq)
  t.alike(created.poll, ['Café', 'Chá'])
  await call('choice.set', { to: made.ref, pick: 1 })
  t.alike(await call('choice.mine', { to: made.ref }), { pick: 1, seq: made.seq + 1 })
  const peek = await call('diary.peek', { author: f.own, seqs: [made.seq] })
  t.alike(peek.entries[0].record.poll, ['Café', 'Chá'])
  keys(t, peek.entries[0].record, ['type', 'text', 'at', 'replyTo', 'poll'])
})

test('forum topics: group.topics, marks, topic reads, group.choose and group.voters', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  const request = createVitrineRequest(f)
  const call = (method, params) => answer(t, request, method, params)
  const g = f.groups[2]
  const [one, two] = g.topics
  const target = { writer: one.writer, seq: one.seq }
  const plain = await call('group.read', { group: g.group })
  for (const row of plain.items) t.absent(Object.hasOwn(row, 'topic'), 'the default read is unmarked')
  const marked = await call('group.read', { group: g.group, marks: true })
  const rowOf = (writer) => marked.items.find((i) => i.writer === writer)
  t.alike(rowOf(one.writer).topic, { writer: one.writer, seq: 2, poll: true })
  t.alike(rowOf(two.writer).topic, { writer: two.writer, seq: 2, poll: false })
  t.alike(rowOf(g.items[0].writer).topic, null, 'an ordinary chat message is no topic')
  t.alike(rowOf(g.items[g.items.length - 2].writer).topic, { writer: two.writer, seq: 2, poll: false }, 'the reply belongs to its root')
  const thread = await call('group.read', { group: g.group, topic: target })
  t.is(thread.items.length, 3)
  t.alike(thread.poll, { options: ['Contos', 'Romance', 'Poesia'], totals: [1, 1, 1], mine: null }, 'the last vote of each voter counts')
  await refused(t, request, 'group.read', { group: g.group, topic: { writer: g.items[0].writer, seq: 2 } }, 'USAGE')
  const topics = await call('group.topics', { group: g.group })
  t.alike(topics.items.map((x) => [x.writer, x.replies]), [[two.writer, 1], [one.writer, 2]], 'newest root first')
  for (const row of topics.items) keys(t, row, ['writer', 'diary', 'seq', 'at', 'text', 'name', 'username', 'hidden', 'replies', 'last', 'poll'])
  t.is(topics.items[0].poll, null)
  t.alike(topics.items[1].poll.totals, [1, 1, 1])
  await call('group.choose', { group: g.group, target, pick: 1 })
  t.alike((await call('group.topics', { group: g.group })).items[1].poll, { options: ['Contos', 'Romance', 'Poesia'], totals: [1, 2, 1], mine: 1 })
  const voters = await call('group.voters', { group: g.group, target })
  t.alike(voters.voters.map((v) => [v.pick, v.count]), [[0, 1], [1, 2], [2, 1]])
  t.ok(voters.voters[1].by.includes(f.own))
  await call('group.choose', { group: g.group, target, pick: null })
  t.is((await call('group.topics', { group: g.group })).items[1].poll.mine, null)
  await refused(t, request, 'group.choose', { group: g.group, target, pick: 3 }, 'USAGE')
  await refused(t, request, 'group.choose', { group: g.group, target: { writer: two.writer, seq: 2 }, pick: 0 }, 'USAGE')
  await refused(t, request, 'group.voters', { group: g.group, target: { writer: two.writer, seq: 2 } }, 'USAGE')
  await refused(t, request, 'group.topics', { group: f.groups[3].group }, 'USAGE')
  await refused(t, request, 'group.post', { group: f.groups[3].group, text: 'Pauta', topic: true }, 'USAGE', 'fóruns e enquetes só em grupo público')
  await refused(t, request, 'group.topics', { group: f.groups[3].group }, 'USAGE', 'fóruns e enquetes só em grupo público')
  const made = await call('group.post', { group: g.group, text: 'Pauta do próximo encontro', topic: true, poll: ['Domingo', 'Sábado'] })
  const fresh = (await call('group.topics', { group: g.group })).items[0]
  t.alike([fresh.seq, fresh.replies, fresh.poll.totals], [made.seq, 0, [0, 0]])
  const marks = await call('group.read', { group: g.group, marks: true, limit: 1 })
  t.alike(marks.items[0].topic, { writer: fresh.writer, seq: made.seq, poll: true })
  t.alike(Object.keys(thread), ['items', 'next', 'hidden', 'incomplete', 'sealed', 'epoch', 'poll', 'event', 'state'], 'the topic read keeps the real key order')
})

test('forum topics: a hidden root loses its poll, marker and votes, as the real handler', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  const request = createVitrineRequest(f)
  const call = (method, params) => answer(t, request, method, params)
  const g = f.groups[2]
  const [one] = g.topics
  const target = { writer: one.writer, seq: one.seq }
  await call('group.hide', { group: g.group, target, on: true })
  const topics = await call('group.topics', { group: g.group })
  const row = topics.items.find((x) => x.writer === one.writer)
  t.alike([row.hidden, row.text, row.poll], [true, '', null])
  const thread = await call('group.read', { group: g.group, topic: target })
  t.is(thread.poll, null, 'the topic read of a hidden root has no poll')
  t.alike(Object.keys(thread), ['items', 'next', 'hidden', 'incomplete', 'sealed', 'epoch', 'poll', 'event', 'state'])
  const marked = await call('group.read', { group: g.group, marks: true })
  t.is(marked.items.find((i) => i.writer === one.writer && i.seq === one.seq).topic, null, 'the hidden root has no marker')
  await refused(t, request, 'group.voters', { group: g.group, target }, 'USAGE', 'mensagem não encontrada')
  await refused(t, request, 'group.choose', { group: g.group, target, pick: 0 }, 'USAGE', 'mensagem não encontrada')
  await refused(t, request, 'group.voters', { group: g.group, target: { writer: g.topics[1].writer, seq: g.topics[1].seq } }, 'USAGE', 'enquete não encontrada')
})

test('group events: the fake lists the root event, RSVP counts and posting adds one', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  const request = createVitrineRequest(f)
  const call = (method, params) => answer(t, request, method, params)
  const g = f.groups[2]
  const first = await call('group.events', { group: g.group })
  t.is(first.items.length, 1)
  keys(t, first.items[0], ['writer', 'diary', 'seq', 'at', 'text', 'name', 'username', 'hidden', 'event', 'totals', 'mine'])
  t.alike(first.items[0].totals, [0, 0])
  await call('group.choose', { group: g.group, target: { writer: first.items[0].writer, seq: first.items[0].seq }, pick: 1 })
  const voted = await call('group.events', { group: g.group })
  t.alike([voted.items[0].totals, voted.items[0].mine], [[0, 1], 1])
  const event = { title: 'Roda de conversa', start: '2026-12-01T18:00:00.000Z', end: null, place: '' }
  const made = await call('group.post', { group: g.group, text: 'Venham!', event })
  const after = await call('group.events', { group: g.group })
  t.is(after.items.length, 2)
  t.is(after.items[0].seq, made.seq)
  t.alike(after.items[0].event, event)
})

test('event RSVP on the diary fixture event and the topic read of a group event', async (t) => {
  const { fixtures: f, createVitrineRequest } = await load()
  const request = createVitrineRequest(f)
  const call = (method, params) => answer(t, request, method, params)
  const to = `${f.own}:61`
  t.alike(await call('choice.mine', { to }), { pick: null, seq: null })
  const set = await call('choice.set', { to, pick: 1 })
  t.alike((await call('choice.mine', { to })).pick, 1, 'maybe on a diary event')
  t.ok(set.seq > 0)
  await refused(t, request, 'choice.set', { to, pick: 2 }, 'USAGE', 'opção inválida')
  const g = f.groups[2]
  const root = g.events[0]
  const topic = { writer: root.writer, seq: root.seq }
  await call('group.choose', { group: g.group, target: topic, pick: 0 })
  const voters = await call('group.voters', { group: g.group, target: topic })
  t.alike(voters.voters.map((v) => v.count), [1, 0])
  const made = await call('group.post', { group: g.group, text: 'Tópico com evento', topic: true, event: { title: 'Mutirão', start: '2026-12-02T18:00:00.000Z', end: null, place: '' } })
  const read = await call('group.read', { group: g.group, topic: { writer: g.writer, seq: made.seq } })
  t.alike(Object.keys(read), ['items', 'next', 'hidden', 'incomplete', 'sealed', 'epoch', 'poll', 'event', 'state'])
  t.alike(Object.keys(read.event), ['writer', 'seq', 'title', 'start', 'end', 'place', 'totals', 'mine'])
  t.alike(read.event.totals, [0, 0])
})

test('vitrine visits.list rows are a key and a whole UTC day in ms, from visitors whose switch is on', async (t) => {
  const { fixtures: f, request } = await load()
  const { visits } = await request('visits.list', {})
  t.ok(visits.length > 0, 'the demo list is not empty')
  for (const v of visits) {
    t.alike(Object.keys(v).sort(), ['at', 'key'])
    t.ok(Number.isSafeInteger(v.at) && v.at % 86400000 === 0, 'day precision')
    t.ok(f.diaryRecords.some((e) => e.author === v.key && e.record.type === 'visits' && e.record.on === true), 'the visitor opted in')
  }
  const { groupByDay } = await import('../src/visits.js')
  t.is(groupByDay(visits, Date.parse(f.now)).reduce((n, g) => n + g.rows.length, 0), visits.length, 'every row renders')
})

test('garden.state answers the seeded balcony of Lia, with the helps she gave today', async (t) => {
  const { fixtures: f, request } = await load()
  const { validateRecord } = require('@varanda/core/lib/records')
  const { garden } = require('@varanda/rpc')
  const records = f.diaryRecords.filter((e) => ['garden', 'garden-state', 'garden-help'].includes(e.record.type))
  t.is(records.length, 10)
  for (const e of records) t.is(validateRecord(e.record, e.seq), null, e.record.type + ' ' + e.author.slice(0, 4) + ':' + e.seq + ' validates')
  t.is(new Set(f.diaryRecords.map((e) => e.author + ':' + e.seq)).size, f.diaryRecords.length, 'no author reuses a seq')
  const state = await answer(t, request, 'garden.state', {})
  t.is(state.on, true)
  t.is(state.state.seq, 52)
  t.is(state.state.n, 1)
  t.is(state.savesToday, 1)
  t.is(state.helpsToday, 1)
  t.alike(state.given, [{ seq: 53, to: f.members[2].author, pot: 3, at: '2026-11-05T12:00:00.000Z' }])
  t.ok(garden.isPots(state.state.pots, Date.parse(state.state.at)), 'the pots are a valid balcony')
  const views = state.state.pots.map((p) => p === null ? null : garden.potView(p, Date.parse(f.now)))
  t.is(views[0].ripe, true, 'one ripe')
  t.ok(!views[1].ripe && views[1].dry, 'one growing and dry')
  t.ok(!views[2].ripe && !views[2].dry, 'one growing and wet')
  t.is(views[3].stage, 0, 'one just planted')
  t.alike([views[4], views[5]], [null, null])
  const records3 = f.diaryRecords.filter((e) => e.record.type === 'garden-help' && e.record.to === f.own)
  t.alike(records3.map((e) => e.author).sort(), [f.members[2].author, f.members[3].author].sort())
  for (const e of records3) t.ok(f.diaryRecords.some((x) => x.author === e.author && x.record.type === 'follow' && x.record.key === f.own && x.record.on === true), 'the helper follows Lia')
})

test('garden.state answers on the demo clock whatever options.clock says, as diary.peek does', async (t) => {
  const { fixtures: f, request, createVitrineRequest } = await load()
  const plain = await answer(t, request, 'garden.state', {})
  const moved = await answer(t, createVitrineRequest(f, { clock: () => Date.parse(f.now) + 12 * 86400000 }), 'garden.state', {})
  t.alike(moved, plain, 'the device clock moves no garden date')
  const peek = await answer(t, request, 'diary.peek', { author: f.own, seqs: [plain.state.seq], profileSeq: 1, usernameSeq: 2 })
  t.alike(peek.entries[0].record.pots, plain.state.pots, 'the pots match the peeked block')
  t.is(peek.entries[0].record.at, plain.state.at)
})

test('garden.play saves a valid plant act as a new state and refuses an invalid one without change', async (t) => {
  const { request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  const before = await call('garden.state', {})
  const played = await call('garden.play', { acts: [{ op: 'plant', pot: 4, plant: 'tomate' }] })
  t.ok(played.seq > before.state.seq)
  t.is(played.ref.split(':')[1], String(played.seq))
  t.is(played.state.seq, played.seq)
  t.is(played.state.n, 2)
  t.is(played.state.pots[4].plant, 'tomate')
  const after = await call('garden.state', {})
  t.alike(after.state, played.state, 'a following state shows the save')
  t.is(after.savesToday, 2)
  const peek = await call('diary.peek', { author: played.ref.split(':')[0], seqs: [played.seq], profileSeq: 1, usernameSeq: 2 })
  t.is(peek.entries[0].record.type, 'garden-state')
  const prior = await call('diary.peek', { author: played.ref.split(':')[0], seqs: [before.state.seq], profileSeq: 1, usernameSeq: 2 })
  t.alike(prior.missing, [before.state.seq], 'a save tombstones the previous state, as the node does')
  await refused(t, request, 'garden.play', { acts: [{ op: 'plant', pot: 0, plant: 'tomate' }] }, 'USAGE', 'jogada inválida')
  await refused(t, request, 'garden.play', { acts: [{ op: 'water', pot: 5 }] }, 'USAGE', 'jogada inválida')
  t.alike(await call('garden.state', {}), after, 'a refused session changes nothing')
  for (let i = after.savesToday; i < 6; i++) await call('garden.play', { acts: [{ op: 'clear', pot: 4 }, { op: 'plant', pot: 4, plant: 'tomate' }] })
  await refused(t, request, 'garden.play', { acts: [{ op: 'clear', pot: 4 }] }, 'USAGE', 'você já cuidou da varanda o máximo de vezes por hoje')
})

test('garden.set leaves and joins the game, and a left game refuses plays and helps', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  t.alike(await call('garden.set', { on: false }), { on: false })
  const left = await call('garden.state', {})
  t.is(left.on, false)
  t.is(left.state, null, 'a leave tombstones the saved state')
  t.alike(left.given, [])
  await refused(t, request, 'garden.play', { acts: [{ op: 'plant', pot: 0, plant: 'tomate' }] }, 'USAGE', 'ligue a Varandinha para jogar')
  await refused(t, request, 'garden.help', { to: f.members[3].author, pot: 0 }, 'USAGE', 'ligue a Varandinha para regar')
  const flags = (seqs) => call('diary.peek', { author: f.own, seqs, profileSeq: 1, usernameSeq: 2 })
  const offSeq = (await flags([51])).length - 1
  t.is((await flags([offSeq])).entries[0].record.on, false, 'the off flag is the last block of the leave')
  t.alike(await call('garden.set', { on: true }), { on: true })
  t.alike((await flags([offSeq])).missing, [offSeq], 'joining tombstones the off flag, as the node does')
  t.is((await call('garden.state', {})).on, true)
  t.alike(await call('garden.set', { on: true }), { on: true }, 'joining twice is harmless')
})

test('garden.play counts the caller own helps (foldGiven) when it judges a harvest, as the node does', async (t) => {
  const { fixtures, createVitrineRequest } = await load()
  // Lia's alecrim (pot 2) ripens at 16:30 with the 30 min her help seq 53
  // gives it, and at 17:00 without it.
  const late = createVitrineRequest({ ...fixtures, now: '2026-11-05T16:45:00.000Z' })
  const played = await answer(t, late, 'garden.play', { acts: [{ op: 'harvest', pot: 2 }] })
  t.is(played.state.pots[2], null, 'the harvest empties the pot')
  const early = createVitrineRequest({ ...fixtures, now: '2026-11-05T16:15:00.000Z' })
  await refused(t, early, 'garden.play', { acts: [{ op: 'harvest', pot: 2 }] }, 'USAGE', 'jogada inválida')
})

test('garden.help waters a neighbour pot once a day and refuses the other cases with the documented message', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  const [joao, cecilia, andre, bia] = [f.members[1].author, f.members[2].author, f.members[3].author, f.members[4].author]
  await refused(t, request, 'garden.help', { to: f.own, pot: 0 }, 'USAGE', 'não dá para regar a própria varanda')
  await refused(t, request, 'garden.help', { to: bia, pot: 0 }, 'USAGE', 'você só rega a varanda de quem você segue')
  await refused(t, request, 'garden.help', { to: joao, pot: 0 }, 'USAGE', 'esta pessoa não está na Varandinha')
  await refused(t, request, 'garden.help', { to: cecilia, pot: 3 }, 'USAGE', 'você já regou esta varanda hoje')
  await refused(t, request, 'garden.help', { to: f.pages[0].author, pot: 0 }, 'USAGE', 'páginas não têm Varandinha')
  await refused(t, request, 'garden.help', { to: andre, pot: 2 }, 'USAGE', 'este vaso não tem planta para regar')
  const helped = await call('garden.help', { to: andre, pot: 0 })
  t.is(helped.ref, f.own + ':' + helped.seq)
  await refused(t, request, 'garden.help', { to: andre, pot: 1 }, 'USAGE', 'você já regou esta varanda hoje')
  const state = await call('garden.state', {})
  t.is(state.helpsToday, 2)
  t.alike(state.given.map((g) => g.seq), [helped.seq, 53])
  await call('block.set', { key: bia, on: true })
  await refused(t, request, 'garden.help', { to: bia, pot: 0 }, 'USAGE', 'você bloqueou esta pessoa')
})

test('the Barraquinha fixtures validate: decor, a pending mimo and an accepted pair, above the flags', async (t) => {
  const { fixtures: f } = await load()
  const { validateRecord } = require('@varanda/core/lib/records')
  const { garden } = require('@varanda/rpc')
  const [cecilia, andre] = [f.members[2].author, f.members[3].author]
  const records = f.diaryRecords.filter((e) => ['garden-decor', 'garden-gift', 'garden-take'].includes(e.record.type))
  t.is(records.length, 6)
  for (const e of records) t.is(validateRecord(e.record, e.seq), null, e.record.type + ' ' + e.author.slice(0, 4) + ':' + e.seq + ' validates')
  t.alike(records.filter((e) => e.record.type === 'garden-decor').map((e) => e.author).sort(), [f.own, cecilia, andre].sort())
  for (const e of records) {
    const flag = f.diaryRecords.filter((x) => x.author === e.author && x.record.type === 'garden').sort((a, b) => b.seq - a.seq)[0]
    t.ok(flag.record.on === true && e.seq > flag.seq, 'above the live on flag')
  }
  const now = Date.parse(f.now)
  t.is(garden.stallDay(now), false, 'the demo clock is not a Saturday')
  const gifts = records.filter((e) => e.record.type === 'garden-gift')
  t.alike(gifts.map((e) => e.author).sort(), [cecilia, andre].sort())
  for (const e of gifts) {
    t.is(e.record.to, f.own)
    t.ok(garden.offerListable(Date.parse(e.record.at), now), 'the mimo is still inside its week')
    t.ok(f.diaryRecords.some((x) => x.author === e.author && x.record.type === 'follow' && x.record.key === f.own && x.record.on === true), 'the giver follows Lia')
  }
  const take = records.find((e) => e.record.type === 'garden-take')
  t.alike([take.author, take.record.from, take.record.seq], [f.own, cecilia, 135], 'Lia took the gift of Cecília')
})

test('garden.stall answers the seeded Barraquinha on the demo clock, and garden.decor replaces the enfeites', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  const stall = await call('garden.stall', {})
  t.alike(stall, { open: false, decor: { seq: 54, items: ['rede', 'pisca'] }, giftsToday: 0, takesToday: 0, gave: [], takes: [{ seq: 55, from: f.members[2].author, gseq: 135, at: '2026-11-04T21:00:00.000Z' }] })
  const decor = await call('garden.decor', { items: ['varal', 'gato'] })
  t.is(decor.ref, f.own + ':' + decor.seq)
  t.alike(decor.items, ['varal', 'gato'])
  t.alike((await call('garden.stall', {})).decor, { seq: decor.seq, items: ['varal', 'gato'] })
  const prior = await call('diary.peek', { author: f.own, seqs: [54], profileSeq: 1, usernameSeq: 2 })
  t.alike(prior.missing, [54], 'latest wins: the previous decor is tombstoned')
  await call('garden.set', { on: false })
  await refused(t, request, 'garden.decor', { items: [] }, 'USAGE', 'ligue a Varandinha para jogar')
})

test('garden.give refuses on the Thursday demo clock by the rule and writes nothing', async (t) => {
  const { fixtures: f, request } = await load()
  const before = await answer(t, request, 'diary.peek', { author: f.own, seqs: [51], profileSeq: 1, usernameSeq: 2 })
  await refused(t, request, 'garden.give', { to: f.members[3].author, pot: 0 }, 'USAGE', 'a barraquinha só abre aos sábados')
  const after = await answer(t, request, 'diary.peek', { author: f.own, seqs: [51], profileSeq: 1, usernameSeq: 2 })
  t.is(after.length, before.length, 'no block is written')
  await refused(t, request, 'garden.give', { to: f.own, pot: 0 }, 'USAGE', 'não dá para dar um mimo para si')
  await refused(t, request, 'garden.give', { to: f.members[4].author, pot: 0 }, 'USAGE', 'você só dá mimos para quem você segue')
})

test('garden.give on a Saturday empties the ripe pot and lists the gift, and garden.drop takes it back', async (t) => {
  const { fixtures, createVitrineRequest } = await load()
  const f = { ...fixtures, now: '2026-11-07T15:00:00.000Z' }
  const request = createVitrineRequest(f)
  const call = (method, params) => answer(t, request, method, params)
  const andre = f.members[3].author
  await refused(t, request, 'garden.give', { to: andre, pot: 4 }, 'USAGE', 'este vaso ainda não está pronto')
  const gave = await call('garden.give', { to: andre, pot: 0 })
  t.is(gave.ref, f.own + ':' + gave.seq)
  t.is(gave.state.pots[0], null, 'the given pot is emptied in the same append')
  t.is(gave.state.seq, gave.seq - 1)
  const stall = await call('garden.stall', {})
  t.is(stall.open, true)
  t.is(stall.giftsToday, 1)
  t.alike(stall.gave, [{ seq: gave.seq, to: andre, item: 'manjericao', at: stall.gave[0].at }])
  await refused(t, request, 'garden.give', { to: andre, pot: 2 }, 'USAGE', 'você já deu um mimo para esta pessoa hoje')
  const dropped = await call('garden.drop', { kind: 'gift', seq: gave.seq })
  t.alike(dropped.deleted, [gave.seq])
  t.alike((await call('garden.stall', {})).gave, [], 'a dropped gift leaves gave')
  await refused(t, request, 'garden.drop', { kind: 'gift', seq: gave.seq }, 'USAGE', 'este registro não é um mimo seu')
  await refused(t, request, 'garden.drop', { kind: 'take', seq: 52 }, 'USAGE', 'este registro não é um mimo seu')
})

test('garden.take accepts a pending mimo once, and refuses one that is gone', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  const [cecilia, andre] = [f.members[2].author, f.members[3].author]
  const took = await call('garden.take', { from: andre, seq: 135 })
  t.is(took.changed, true)
  t.is(took.ref, f.own + ':' + took.seq)
  t.alike(await call('garden.take', { from: andre, seq: 135 }), { ...took, changed: false }, 'a second take is idempotent')
  t.alike(await call('garden.take', { from: cecilia, seq: 135 }), { seq: 55, ref: f.own + ':55', changed: false }, 'the seeded take answers as held')
  const stall = await call('garden.stall', {})
  t.is(stall.takesToday, 1)
  t.alike(stall.takes.map((r) => r.seq), [took.seq, 55])
  await refused(t, request, 'garden.take', { from: andre, seq: 134 }, 'USAGE', 'este mimo não está mais disponível')
  await refused(t, request, 'garden.take', { from: f.own, seq: 54 }, 'USAGE', 'este mimo não está mais disponível')
})

test('garden.set off tombstones the decor, gift and take blocks too', async (t) => {
  const { fixtures: f, request } = await load()
  const call = (method, params) => answer(t, request, method, params)
  await call('garden.set', { on: false })
  const peek = await call('diary.peek', { author: f.own, seqs: [54, 55], profileSeq: 1, usernameSeq: 2 })
  t.alike(peek.missing, [54, 55], 'the decor and the take are tombstoned')
  t.alike(await call('garden.stall', {}), { open: false, decor: null, giftsToday: 0, takesToday: 0, gave: [], takes: [] })
})
