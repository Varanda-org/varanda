'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const source = () => readFileSync(join(__dirname, '../src/indexClient.js'), 'utf8')
const refOf = (p) => `${p.author}:${p.seq}`
const cursorOf = (p) => `${Date.parse(p.at)}.${p.author}.${p.seq}`
const load = async () => {
  const client = await import('../src/indexClient.js')
  const { fixtures } = await import('../src/vitrine/fixtures.js')
  const { vitrineIndex } = await import('../src/vitrine/indexResponder.js')
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  return { client, fixtures, vitrineIndex, request: createVitrineRequest(fixtures) }
}

test('every index route and cursor returns a deterministic validated fixture body', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const ref = refOf(f.feed[0])
  const reply = f.noticePosts.find((p) => p.replyTo && refOf(p.replyTo) === ref)
  const cursor = cursorOf(reply)
  const following = { atMs: Date.parse(f.now), key: f.follows[0] }
  const group = f.groups[0]
  const community = f.communities[0].community
  const cases = [
    [c.postUrl(ref), (b) => c.validPostIndex(b, ref)],
    [c.postUrl(ref, cursor), (b) => c.validPostIndex(b, ref)],
    [c.countsUrl(f.feed.slice(0, 31).map(refOf)), (b) => c.validCounts(b, f.feed.slice(0, 31).map(refOf))],
    [c.memberUrl(f.own), c.validMemberIndex],
    [c.memberUrl(f.own, 5), (b) => c.validMemberIndex(b, 5)],
    [c.memberUrl(f.pages[0].author), c.validMemberIndex],
    [c.topicUrl('praca'), c.validTopic],
    [c.topicUrl('praca', cursor), c.validTopic],
    [c.engagersUrl('likes', ref), (b) => c.validEngagers(b, ref, 'likes')],
    [c.engagersUrl('likes', ref, cursor), (b) => c.validEngagers(b, ref, 'likes')],
    [c.engagersUrl('reposts', refOf(f.feed[6])), (b) => c.validEngagers(b, refOf(f.feed[6]), 'reposts')],
    [c.engagersUrl('likes', ref).replace('/likes/', '/quotes/'), (b) => c.validEngagers(b, ref, 'quotes')],
    [c.followCountsUrl(f.own), c.validFollowCounts],
    [c.followsUrl(f.own, 'seguindo'), (b) => c.validFollows(b, f.own, 'seguindo')],
    [c.followsUrl(f.own, 'seguidores'), (b) => c.validFollows(b, f.own, 'seguidores')],
    [c.followsUrl(f.own, 'seguindo', following), (b) => c.validFollows(b, f.own, 'seguindo', following)],
    [c.searchUrl('joao'), c.validSearch],
    [c.searchUrl('biblioteca-praca'), c.validSearch],
    [c.groupUrl(group.group), c.validGroup],
    [c.groupUrl(group.group, group.items[0].writer), (b) => c.validGroup(b, group.items[0].writer)],
    [c.groupUrl(f.groups[3].group), c.validGroup],
    [c.groupsUrl(f.own), c.validGroups],
    [c.communityUrl(community), c.validCommunity],
    [c.communityGroupsUrl(community, group.group), (b) => c.validCommunityGroups(b, group.group)],
    [c.groupSearchUrl('bicicleta'), c.validGroupSearch],
    [c.testimonialsUrl(f.own), (b) => c.validTestimonials(b, f.own)],
    [c.testimonialsUrl(f.members[1].author), (b) => c.validTestimonials(b, f.members[1].author)]
  ]
  for (const [url, validate] of cases) {
    t.ok(url, 'builder accepts the fixture input')
    const body = respond(url)
    t.ok(validate(body), url + ' passes its validator')
    t.alike(respond(url), body, 'deterministic')
    t.alike(respond('https://example.invalid' + url + '?ignored=1#fragment'), body, 'origin and query ignored')
    t.alike(respond(url.slice(1)), body, 'relative path')
    body.complete = false
    t.is(respond(url).complete, true, 'fresh response')
  }
})

test('post, member, search, engagement and follow references resolve through diary.peek', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  async function peek (author, seqs) {
    const result = await request('diary.peek', { author, seqs: seqs.length ? [...seqs].sort((a, b) => a - b) : [1, 2], profileSeq: 1, usernameSeq: 2 })
    t.alike(result.missing, [], 'all referenced blocks exist')
    t.alike(result.invalid, [])
    t.ok(result.profile && result.username, 'profile hints resolve')
    return { ...result, entries: result.entries.filter((e) => seqs.includes(e.seq)) }
  }
  async function record (ref) {
    const [author, seq] = ref.split(':')
    return (await peek(author, [Number(seq)])).entries[0].record
  }
  const posts = [...f.feed, ...f.noticePosts]
  // The counts route takes at most 31 refs a call.
  const counts = {}
  for (let i = 0; i < posts.length; i += 31) Object.assign(counts, respond(c.countsUrl(posts.slice(i, i + 31).map(refOf))).counts)
  for (const post of posts) {
    const ref = refOf(post)
    const body = respond(c.postUrl(ref))
    t.is((await record(body.ref)).type, 'post')
    t.is(body.parent, post.replyTo ? refOf(post.replyTo) : null)
    if (body.parent) t.is((await record(body.parent)).type, 'post')
    for (const [kind, field] of [['replies', 'replyTo'], ['quotes', 'quote']]) {
      const expected = posts.filter((p) => p[field] && refOf(p[field]) === ref).map(refOf)
      t.alike([...body[kind]].sort(), expected.sort(), kind + ' use fixture targets')
      for (const target of body[kind]) t.is(refOf((await record(target))[field]), ref)
      t.is(counts[ref][kind], expected.length)
    }
    for (const kind of ['likes', 'reposts']) {
      const engagement = respond(c.engagersUrl(kind, ref))
      t.is(engagement.total, counts[ref][kind])
      t.is(body[kind], counts[ref][kind])
      for (const target of engagement.items) {
        const r = await record(target)
        t.is(r.type, kind.slice(0, -1))
        t.is(refOf(r.to), ref)
        t.is(r.on, true)
      }
    }
  }
  for (const profile of [...f.members, ...f.pages, ...f.applicants]) {
    const author = profile.author
    const body = respond(c.memberUrl(author))
    const reposts = f.diaryRecords.filter((e) => e.author === author && e.record.type === 'repost' && e.record.on).map((e) => e.seq)
    const expected = [...new Set([...posts.filter((p) => p.author === author).map((p) => p.seq), ...reposts])].sort((a, b) => b - a)
    t.alike(body.posts, expected)
    t.is(body.postsTotal, expected.length)
    const result = await peek(author, body.posts)
    t.is(body.length, result.length)
    t.ok(result.entries.every((e) => e.record.type === 'post' || (e.record.type === 'repost' && reposts.includes(e.seq))))
    const before = body.posts[0] || 3
    t.alike(respond(c.memberUrl(author, before)).posts, body.posts.filter((seq) => seq < before), 'exclusive member cursor')
    const total = respond(c.followCountsUrl(author))
    for (const kind of ['seguindo', 'seguidores']) {
      const follows = respond(c.followsUrl(author, kind))
      t.is(follows.total, total[kind])
      t.ok(c.validFollows(follows, author, kind))
      for (const item of follows.items) {
        const r = await record(`${kind === 'seguindo' ? author : item.key}:${item.seq}`)
        t.is(r.type, 'follow')
        t.is(r.key, kind === 'seguindo' ? item.key : author)
        t.is(r.on, true)
      }
    }
  }
  t.alike(respond(c.followsUrl(f.own, 'seguindo')).items.map((r) => r.key).sort(), [...f.follows].sort())
  for (const segment of ['lia', 'joao', 'cecilia', 'biblioteca-praca', 'horta-do-bairro']) {
    const result = respond(c.searchUrl(segment))
    t.ok(result.members.length > 0, segment + ' is populated')
    for (const member of result.members) await peek(member.author, [member.profileSeq, member.usernameSeq])
  }
  t.is(respond(c.searchUrl('biblioteca')).members[0].page, true)
  t.alike(respond(c.searchUrl('inexistente')).members, [])
  const topic = respond(c.topicUrl('praca'))
  t.ok(topic.items.length > 0)
  for (const ref of topic.items) t.ok((await record(ref)).text.includes('praça'))
  const first = posts.find((p) => refOf(p) === topic.items[0])
  t.alike(respond(c.topicUrl('praca', cursorOf(first))).items, topic.items.slice(1), 'topic cursor advances')
  const reply = f.noticePosts.find((p) => p.replyTo)
  t.alike(respond(c.postUrl(refOf(reply.replyTo), cursorOf(reply))).replies, [], 'reply cursor advances')
})

test('group and community indexes match the Vitrine RPC and preserve private names', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  t.alike(respond(c.groupsUrl(f.own)).groups.map((g) => g.group), f.groups.map((g) => g.group))
  for (const group of f.groups) {
    const body = respond(c.groupUrl(group.group))
    const info = await request('group.info', { group: group.group })
    t.is(body.community, info.community)
    t.is(body.join, info.join)
    t.is(body.visibility, info.visibility)
    t.is(body.name, group.visibility === 'private' ? null : info.name)
    t.ok(body.writers.some((w) => w.key === group.writer && w.diary === f.own))
    const after = body.writers[0].key
    t.alike(respond(c.groupUrl(group.group, after)).writers, body.writers.slice(1))
  }
  for (const community of f.communities) {
    const body = respond(c.communityUrl(community.community))
    const info = await request('community.info', { community: community.community })
    t.is(body.name, info.name)
    t.is(body.members, info.members)
    t.alike(body.groups.map((g) => g.group), f.groups.filter((g) => g.community === community.community).map((g) => g.group))
    const after = body.groups[0].group
    t.alike(respond(c.communityGroupsUrl(community.community, after)).groups, body.groups.slice(1))
    t.ok(c.validCommunity(body))
  }
  const reposter = f.diaryRecords.find((e) => e.record.type === 'repost' && e.record.on)
  t.ok(respond(c.memberUrl(reposter.author)).posts.includes(reposter.seq), 'active repost listed on the profile')
  const names = (segment) => respond(c.searchUrl(segment)).members.map((m) => m.author)
  const byName = (name) => f.members.find((m) => m.name === name).author
  t.ok(names('lia').includes(byName('Lia Oliveira')), 'prefix finds Lia')
  t.absent(names('lia').includes(byName('Cecília Ramos')), 'lia is not inside Cecília')
  t.alike(respond(c.groupSearchUrl('icleta')).groups, [], 'substring is not a match')
  t.alike(respond(c.groupSearchUrl('bici')).groups.map((g) => g.name), ['Passeios de bicicleta'])
  const clube = f.groups[2]
  const distinct = new Set([f.own, ...clube.items.map((i) => i.diary)]).size
  t.ok(clube.items.length + 1 > distinct, 'fixture has a writer core and a message row for one diary')
  t.is(respond(c.communityUrl(clube.community)).groups.find((g) => g.group === clube.group).writerCount, distinct, 'distinct diaries')
  t.is(respond(c.groupSearchUrl('geral')).groups.find((g) => g.group === clube.group).writerCount, distinct)
  t.alike(respond(c.groupSearchUrl('bicicleta')).groups.map((g) => g.group), [f.groups[1].group])
  t.alike(respond(c.groupSearchUrl('organizacao')).groups, [])
})

test('last write wins per author, writer seqs follow records and each route keeps its tie order', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const posts = [...f.feed, ...f.noticePosts]
  const target = refOf(f.feed[0])
  const [tAuthor, tSeq] = [f.feed[0].author, f.feed[0].seq]
  const to = { author: tAuthor, seq: tSeq }
  const [a, b] = ['a'.repeat(64), 'b'.repeat(64)]
  const base = respond(c.countsUrl([target])).counts[target]
  const saved = [...f.diaryRecords]
  const stamp = '2026-11-20T10:00:00.000Z'
  const add = (author, seq, record) => f.diaryRecords.push({ author, seq, record })
  try {
    add(a, 900, { type: 'like', to, on: true, at: stamp })
    add(a, 901, { type: 'like', to, on: false, at: stamp })
    add(b, 902, { type: 'like', to, on: true, at: stamp })
    add(b, 903, { type: 'like', to, on: true, at: stamp })
    const likes = respond(c.engagersUrl('likes', target))
    t.ok(c.validEngagers(likes, target, 'likes'), 'no duplicate engagers')
    t.absent(likes.items.includes(`${a}:900`) || likes.items.includes(`${a}:901`), 'unliked author is not listed')
    t.is(likes.items.filter((r) => r.startsWith(b + ':')).length, 1, 'two likes list the author once')
    t.is(likes.total, base.likes + 1, 'only the second author is counted')
    t.is(respond(c.countsUrl([target])).counts[target].likes, base.likes + 1)
    // a tie on at: likers go author ascending, then seq descending
    const tied = likes.items.filter((r) => r.startsWith(b + ':'))
    t.alike(tied, [`${b}:903`])
    add(a, 904, { type: 'like', to, on: true, at: stamp })
    const order = respond(c.engagersUrl('likes', target)).items.filter((r) => /:90[34]$/.test(r))
    t.alike(order, [`${a}:904`, `${b}:903`], 'tie on at: author ascending')

    // follows: a later unfollow cancels the follow, a repeat counts once
    const page = f.pages[0].author
    const before = respond(c.followCountsUrl(page)).seguidores
    add(a, 910, { type: 'follow', key: page, on: true, at: stamp })
    add(a, 911, { type: 'follow', key: page, on: false, at: stamp })
    add(b, 912, { type: 'follow', key: page, on: true, at: stamp })
    add(b, 913, { type: 'follow', key: page, on: true, at: stamp })
    const followers = respond(c.followsUrl(page, 'seguidores'))
    t.ok(c.validFollows(followers, page, 'seguidores'))
    t.is(respond(c.followCountsUrl(page)).seguidores, before + 1)
    t.absent(followers.items.some((r) => r.key === a && r.seq === 910), 'unfollowed author is not listed')
    t.is(followers.items.filter((r) => r.key === b).length, 1)
    const member = f.members[1].author
    const kept = respond(c.followCountsUrl(member)).seguindo
    add(member, 920, { type: 'follow', key: page, on: true, at: stamp })
    add(member, 921, { type: 'follow', key: page, on: false, at: stamp })
    t.is(respond(c.followCountsUrl(member)).seguindo, kept, 'seguindo drops the cancelled follow')
  } finally {
    f.diaryRecords.length = 0
    f.diaryRecords.push(...saved)
  }

  // quote pages are the exact reverse of (at, author, seq); likers are not
  const quoted = posts.filter((p) => p.quote)
  for (const q of quoted) {
    const ref = refOf(q.quote)
    const rows = posts.filter((p) => p.quote && refOf(p.quote) === ref)
    const expected = [...rows].sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || (x.author < y.author ? 1 : x.author > y.author ? -1 : 0) || y.seq - x.seq).map(refOf)
    t.alike(respond(c.engagersUrl('likes', ref).replace('/likes/', '/quotes/')).items, expected, 'quotes: author descending on ties')
  }

  // writer rows: seq is the newest record on that writer, length and signed agree
  for (const group of f.groups) {
    const body = respond(c.groupUrl(group.group))
    t.ok(c.validGroup(body))
    for (const item of group.items) {
      const w = body.writers.find((x) => x.key === item.writer)
      t.is(w.seq, item.seq, 'writer seq is the newest record seq')
      t.is(w.length, w.seq + 1)
      t.is(w.signed, w.length)
    }
    const own = respond(c.groupsUrl(f.own)).groups.find((g) => g.group === group.group)
    t.is(own.seq, body.writers.find((x) => x.key === own.writer).seq, 'groups index agrees')
  }
})

test('the index client statically imports only the enable check and guards the responder require', (t) => {
  const code = source()
  const imports = [...code.matchAll(/\bimport\s+[^\n]+from\s+['"]([^'"]*vitrine\/[^'"]+)['"]/g)].map((m) => m[1])
  t.alike(imports, ['./vitrine/enabled.js'])
  t.ok(/const VITRINE = vitrineEnabled\(\{ EXPO_PUBLIC_VARANDA_VITRINE: process\.env\.EXPO_PUBLIC_VARANDA_VITRINE \}, typeof __DEV__ !== 'undefined' && __DEV__\)/.test(code))
  t.ok(/if \(VITRINE\) \{\s*const \{ vitrineIndex: respond \} = require\('\.\/vitrine\/indexResponder'\)/.test(code))
  t.is((code.match(/require\('\.\/vitrine\/indexResponder'\)/g) || []).length, 1)
  t.ok(/async function getJson \(url, deps = \{\}\) \{\s*if \(VITRINE\) return vitrineIndex\(url\)/.test(code))
})

let serial = 0
async function guardedClient (dev, flag, respond, onRequire) {
  const savedDev = Object.getOwnPropertyDescriptor(globalThis, '__DEV__')
  const savedRequire = Object.getOwnPropertyDescriptor(globalThis, 'require')
  const savedFlag = process.env.EXPO_PUBLIC_VARANDA_VITRINE
  globalThis.__DEV__ = dev
  globalThis.require = (name) => {
    onRequire(name)
    return { vitrineIndex: respond }
  }
  process.env.EXPO_PUBLIC_VARANDA_VITRINE = flag
  try {
    // Metro supplies require in the app's ESM modules; Node needs this bridge.
    return await import('../src/indexClient.js?guard=' + ++serial)
  } finally {
    if (savedDev) Object.defineProperty(globalThis, '__DEV__', savedDev)
    else delete globalThis.__DEV__
    if (savedRequire) Object.defineProperty(globalThis, 'require', savedRequire)
    else delete globalThis.require
    if (savedFlag === undefined) delete process.env.EXPO_PUBLIC_VARANDA_VITRINE
    else process.env.EXPO_PUBLIC_VARANDA_VITRINE = savedFlag
  }
}

test('Vitrine fetchers bypass HTTP and the scheduler, and map unknown fixtures to not-found', async (t) => {
  const { fixtures: f, vitrineIndex: respond } = await load()
  const c = await guardedClient(true, '1', respond, (name) => t.is(name, './vitrine/indexResponder'))
  let fetched = 0
  const deps = { fetch: async () => { fetched++; throw new Error('unexpected network') }, setTimeout: () => { throw new Error('unexpected timer') } }
  const ref = refOf(f.feed[0])
  const calls = [
    () => c.fetchPost(ref, null, deps),
    () => c.fetchCounts([ref], deps),
    () => c.fetchMember(f.own, null, deps),
    () => c.fetchTopic('praca', null, deps),
    () => c.fetchEngagers('likes', ref, null, deps),
    () => c.fetchFollowCounts(f.own, deps),
    () => c.fetchFollows(f.own, 'seguindo', null, deps),
    () => c.fetchSearch('lia', deps),
    () => c.fetchGroup(f.groups[0].group, null, deps),
    () => c.fetchGroups(f.own, deps),
    () => c.fetchCommunity(f.communities[0].community, deps),
    () => c.fetchCommunityGroups(f.communities[0].community, f.groups[0].group, deps),
    () => c.fetchGroupSearch('geral', deps),
    () => c.fetchTestimonials(f.own, deps)
  ]
  for (let pass = 0; pass < 2; pass++) {
    for (const call of calls) t.is((await call()).ok, true, 'validated result without HTTP or timers')
  }
  const unknown = 'f'.repeat(64)
  for (const result of [await c.fetchPost(unknown + ':3', null, deps), await c.fetchMember(unknown, null, deps), await c.fetchGroup(unknown, null, deps), await c.fetchCommunity(unknown, deps)]) {
    t.alike(result, { ok: false, reason: 'not-found' })
  }
  t.alike(await c.fetchPost('invalid', null, deps), { ok: false, reason: 'invalid-input' })
  t.exception(() => respond('/index/unknown/value'), /not-found/)
  t.exception(() => respond('/other/post/' + f.own + '/3'), /not-found/)
  t.is(fetched, 0)
})

test('the testimonials route answers pointers from the live Vitrine state', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const [joao, cecilia, bia] = [f.members[1].author, f.members[2].author, f.members[4].author]
  const body = () => respond(c.testimonialsUrl(f.own))
  t.alike(body(), { shown: [{ seq: 37, from: cecilia, wseq: 60 }, { seq: 36, from: joao, wseq: 60 }], pending: [{ from: bia, seq: 60 }], indexing: false, complete: true })
  t.ok(c.validTestimonials(body(), f.own))
  t.alike(respond(c.testimonialsUrl(joao)).shown, [{ seq: 61, from: f.own, wseq: 38 }])
  t.alike(respond(c.testimonialsUrl(f.members[3].author)), { shown: [], pending: [], indexing: false, complete: true })
  t.exception(() => respond(c.testimonialsUrl('f'.repeat(64))), /not-found/)
  t.exception(() => respond('/index/testimonials/' + f.own + '/extra'), /not-found/)

  const shown = await request('testimonial.show', { from: bia, seq: 60 })
  t.alike(body().shown[0], { seq: shown.seq, from: bia, wseq: 60 })
  t.alike(body().pending, [])
  t.ok(c.validTestimonials(body(), f.own), 'never one block both shown and pending')
  await request('testimonial.delete', { to: shown.ref })
  t.absent(body().shown.some((row) => row.from === bia), 'a removed show leaves the profile')
  t.alike(body().pending, [], 'and never returns to pending')
  await request('testimonial.delete', { to: f.own + ':38' })
  t.alike(respond(c.testimonialsUrl(joao)).shown, [], 'a revoked writer block hides the show')
  const written = await request('testimonial.write', { to: cecilia, text: 'Obrigada pelas mudas!' })
  t.alike(respond(c.testimonialsUrl(cecilia)).pending, [{ from: f.own, seq: written.seq }])
})

test('release bundles and development without the opt-in retain HTTP behavior', async (t) => {
  let fetched = 0
  for (const [dev, flag] of [[false, '1'], [true, '0'], [undefined, '1']]) {
    const c = await guardedClient(dev, flag, () => t.fail('unexpected fixture response'), () => t.fail('unexpected fixture require'))
    const result = await c.fetchPost('a'.repeat(64) + ':3', null, { fetch: async () => { fetched++; return { status: 404 } } })
    t.alike(result, { ok: false, reason: 'not-found' })
  }
  t.is(fetched, 3)
})

test('the testimonials route reads the Vitrine instance used last', async (t) => {
  const { fixtures } = await import('../src/vitrine/fixtures.js')
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  const { vitrineIndex } = await import('../src/vitrine/indexResponder.js')
  const a = createVitrineRequest(fixtures)
  createVitrineRequest(fixtures)
  const before = vitrineIndex('/index/testimonials/' + fixtures.own)
  t.ok(before.pending.length > 0, 'a pending depoimento in the fixtures')
  const { from, seq } = before.pending[0]
  await a('testimonial.show', { from, seq })
  const after = vitrineIndex('/index/testimonials/' + fixtures.own)
  t.absent(after.pending.some((p) => p.from === from && p.seq === seq), 'the instance that showed it is the one the route reads')
})

test('Feira city, author and rating routes validate and hydrate their fixture refs', async (t) => {
  const { client: c, fixtures: f, vitrineIndex, request } = await load()
  const respond = (url) => vitrineIndex(url, request)
  const { hydrate, ratingRefs, ratings } = await import('../src/feiraClient.js')
  const cityUrl = c.feiraUrl({ uf: 'SP', cityKey: 'sao-paulo' })
  const body = respond(cityUrl)
  t.ok(c.validFeira(body))
  const city = await hydrate(request, body)
  t.is(city.dropped, 0)
  t.is(city.unavailable, 0)
  t.ok(city.items.length > 0)
  t.absent(city.items.some((i) => i.status === 'vendido' || i.kind === 'procura'))
  t.ok(city.items.some((i) => i.status === 'reservado'))
  t.ok(city.items.some((i) => i.page))
  t.ok(city.items.some((i) => i.kind === 'servico' && i.unit === 'hora'))
  const author = respond(c.feiraAuthorUrl(f.own))
  t.ok(c.validFeira(author, { author: f.own }))
  const own = await hydrate(request, author)
  t.ok(own.items.some((i) => i.status === 'vendido'))
  t.ok(own.items.some((i) => i.kind === 'procura'))
  const wanted = respond(c.feiraUrl({ uf: 'SP', cityKey: 'sao-paulo', kind: 'procura' }))
  t.is(wanted.items.length, 1)
  const filtered = respond(c.feiraUrl({ uf: 'SP', cityKey: 'sao-paulo', kind: 'produto', cat: 'esporte', tokens: 'azul+revisada' }))
  t.alike(filtered.items.map((i) => i.ref), [`${f.own}:40`])
  t.alike(respond(c.feiraUrl({ uf: 'RJ', cityKey: 'rio-de-janeiro' })).items, [])
  const rateBody = respond(c.feiraRatingsUrl(f.own))
  t.ok(c.validFeira(rateBody, { ratings: true }))
  t.alike(rateBody.items.map((i) => i.ref).sort(), f.rates.map(refOf).sort())
  for (const item of rateBody.items) t.alike(Object.keys(item), ['ref'])
  const refs = await ratingRefs(f.own, null, { fetchFeiraRatings: async () => ({ ok: true, value: rateBody }) })
  const verified = await ratings(request, { author: f.own, seq: 40, refs: refs.refs })
  t.is(verified.items.length, 1)
  body.items[0].status = 'vendido'
  t.absent(respond(cityUrl).items.some((i) => i.status === 'vendido'), 'responses cannot mutate the instance')
})

test('Feira cursors are exclusive across authors and live edits and statuses refresh index hints', async (t) => {
  const { client: c, fixtures: f, vitrineIndex, request } = await load()
  const sample = f.listings.find((e) => e.author === f.own && e.seq === 40).record
  const { type, at, ...fields } = sample
  for (let i = 0; i < 27; i++) await request('listing.create', fields)
  const query = { uf: 'SP', cityKey: 'sao-paulo' }
  const first = vitrineIndex(c.feiraUrl(query), request)
  t.is(first.items.length, 30)
  t.ok(first.next)
  t.ok(c.validFeira(first))
  const second = vitrineIndex(c.feiraUrl({ ...query, cursor: first.next }), request)
  t.is(second.items.length, 1)
  t.is(second.next, null)
  t.ok(c.validFeira(second))
  t.is(new Set([...first.items, ...second.items].map((i) => i.ref)).size, 31)
  const searched = vitrineIndex(c.feiraUrl({ ...query, tokens: 'bicicleta' }), request)
  t.ok(c.validFeira(searched))
  const cursor = `${Date.parse(sample.at)}.${f.own}.40`
  t.ok(c.validFeira(vitrineIndex(c.feiraUrl({ ...query, tokens: 'bicicleta', cursor }), request)))
  t.ok(c.validFeira(vitrineIndex(c.feiraAuthorUrl(f.own, cursor), request), { author: f.own }))
  const rating = f.rates[1]
  const rateCursor = `${Date.parse(rating.record.at)}.${rating.author}.${rating.seq}`
  const ratings = vitrineIndex(c.feiraRatingsUrl(f.own, rateCursor), request)
  t.is(ratings.items.length, 1)
  t.ok(c.validFeira(ratings, { ratings: true }))
  const to = `${f.own}:40`
  const { kind, ...snapshot } = fields
  const edited = await request('listing.edit', { to, expectedRevision: 44, ...snapshot, title: 'Bicicleta amarela' })
  const status = await request('listing.status', { to, status: 'reservado' })
  const refreshed = vitrineIndex(c.feiraUrl({ ...query, tokens: 'amarela' }), request)
  t.alike(refreshed.items, [{ ref: to, editSeq: edited.seq, status: 'reservado', statusSeq: status.seq }])
})

test('Feira probe sees the offline demo index as enabled and malformed routes refuse', async (t) => {
  const { fixtures: f, vitrineIndex, request } = await load()
  const { search, byAuthor } = await import('../src/feiraClient.js')
  const { createFeiraProbe } = await import('../src/feiraScreen.js')
  const probe = createFeiraProbe((request, author) => byAuthor(request, author, null, {
    fetchFeiraAuthor: async () => ({ ok: true, value: vitrineIndex('/index/feira/autor/' + author, request) })
  }))
  t.alike(await probe(request, f.own), { enabled: true })
  const result = await search(request, { uf: 'SP', cityKey: 'sao-paulo' }, {
    fetchFeira: async () => ({ ok: true, value: vitrineIndex('/index/feira/sp/sao-paulo/todos/todas', request) })
  })
  t.is(result.ok, true)
  t.absent(result.off)
  for (const path of [
    '/index/feira',
    '/index/feira/sp',
    '/index/feira/xx/sao-paulo/todos/todas',
    '/index/feira/sp/sao-paulo/todos/inexistente',
    '/index/feira/sp/sao-paulo/todos/todas/a',
    '/index/feira/sp/sao-paulo/todos/todas/a/b/c',
    '/index/feira/autor/nope',
    '/index/feira/avaliacoes/' + f.own + '/invalid'
  ]) t.exception(() => vitrineIndex(path, request), /not-found/)
})

test('live likes and reposts move the counts and the member repost index', async (t) => {
  const { fixtures: f, vitrineIndex: respond, request } = await load()
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  const other = createVitrineRequest(f)
  const mine = (type) => new Set(f.diaryRecords.filter((e) => e.author === f.own && e.record.type === type).map((e) => refOf(e.record.to)))
  const post = f.feed.find((p) => p.author !== f.own && !mine('like').has(refOf(p)) && !mine('repost').has(refOf(p)))
  const ref = refOf(post)
  const countsOf = (req, url = `/index/counts/${ref}`) => respond(url, req).counts[ref]
  const base = countsOf(request)
  const memberSeqs = (req) => respond(`/index/member/${f.own}`, req).posts

  await request('like.set', { to: ref, on: true })
  t.is(countsOf(request).likes, base.likes + 1, 'like adds one')
  await request('like.set', { to: ref, on: true })
  t.is(countsOf(request).likes, base.likes + 1, 'repeated like does not inflate')
  t.is(countsOf(other).likes, base.likes, 'a second instance keeps its baseline')
  await request('like.set', { to: ref, on: false })
  t.is(countsOf(request).likes, base.likes, 'unlike returns to the baseline')

  const before = memberSeqs(request)
  const { seq } = await request('repost.set', { to: ref, on: true })
  t.is(countsOf(request).reposts, base.reposts + 1, 'repost adds one')
  t.ok(memberSeqs(request).includes(seq), 'member index lists the repost')
  t.is(countsOf(other).reposts, base.reposts, 'other instance repost count unchanged')
  t.absent(memberSeqs(other).includes(seq), 'other instance member index unchanged')
  await request('repost.set', { to: ref, on: false })
  t.is(countsOf(request).reposts, base.reposts, 'unrepost returns to the baseline')
  t.alike(memberSeqs(request), before, 'member index returns to the baseline')
})
