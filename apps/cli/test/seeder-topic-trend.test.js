'use strict'

const test = require('brittle')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { keyPair } = require('hypercore-crypto')
const { tmpDir, until } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, generateAssociationKeyPair, createModeratorCert, createIssuerCert } = require('@varanda/core/lib/cert')
const { createBlocklistState, createSnapshot } = require('@varanda/core/lib/blocklist')
const { memberCertRecord, postRecord, deleteRecord } = require('@varanda/core/lib/records')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { groupPost, groupSealed, sealedInner } = require('@varanda/core/lib/group')
const { newEpochKey, sealRecord } = require('@varanda/core/lib/group-crypto')

const hex = (buf) => b4a.toString(buf, 'hex')
const post = (text = '#feira') => postRecord({ text })
const feira = [{ tag: 'feira', authors: 3 }]

// Start at the local replica gate with signed diaries already on disk.
// The real growth, scan, drop and close paths run without a swarm.
function fixture (t, options = {}) {
  const association = generateAssociationKeyPair()
  const dataDir = tmpDir(t, 'varanda-seed-')
  const seeder = new Seeder({ dataDir, ...options })
  seeder.store = new Corestore(path.join(dataDir, 'store'))
  seeder.association = hex(association.publicKey)
  seeder._blocklist = createBlocklistState({ association: seeder.association, save: async () => {} })
  seeder._indexStartup = new Set()
  seeder._topicStartup = new Set()
  seeder._feiraStartup = new Set()
  seeder._startPasses()
  t.teardown(() => seeder.close(), { force: true })

  async function settle (diary) {
    const entry = seeder._served.get(hex(diary.key))
    await until(() => entry.scanned === diary.length && entry.indexed === diary.length &&
      (entry.topicIndexed === diary.length || entry.topicPaused), { name: 'passagens do diário' })
  }

  async function serve (records) {
    const diary = seeder.store.get({ name: 'diary-' + seeder._served.size, valueEncoding: 'json' })
    await diary.ready()
    const key = hex(diary.key)
    const cert = createCert({ member: key }, association)
    await diary.append([memberCertRecord(cert), ...records])
    seeder._admitted.set(key, cert)
    seeder._serve(key, diary, { regate: true })
    await settle(diary)
    return diary
  }

  return { seeder, association, serve, settle }
}

test('topic trends count distinct authors and remove a blocked diary immediately', async (t) => {
  const { seeder, association, serve } = fixture(t)
  await serve([post('#feira #horta'), post(), post(), post(), post()])
  await serve([post('#feira #horta')])
  const third = await serve([post()])
  const answer = seeder.indexTopicTrend()
  t.alike(answer, { topics: feira, indexing: false, complete: true }, 'five posts count once and two authors with #horta do not qualify')
  t.alike(seeder.indexTopicTrend(), answer)
  t.alike(seeder.trendStats(), { trendPosts: 7, trendSaturated: false })

  const moderator = keyPair()
  const cert = createModeratorCert({ moderator: hex(moderator.publicKey), date: new Date().toISOString() }, association)
  const snapshot = createSnapshot({ seq: 1, blocked: [hex(third.key)], revokedIssuers: [] }, moderator, cert)
  t.ok((await seeder._offerBlocklist(snapshot, null)).adopted)
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: true })
  t.is(seeder.trendStats().trendPosts, 6, 'the blocked diary leaves the trend store')
})

test('a trend author counts only after the name index reads the whole diary', async (t) => {
  const { seeder, serve } = fixture(t)
  await serve([post()])
  await serve([post()])
  const third = await serve([post()])
  const untagged = await serve([post('sem hashtag')])
  seeder._served.get(hex(untagged.key)).indexPaused = true
  const entry = seeder._served.get(hex(third.key))
  entry.indexed = entry.present - 1
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: false })
  entry.indexed = entry.present
  entry.indexPaused = true
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: false })
  entry.indexPaused = false
  t.alike(seeder.indexTopicTrend(), { topics: feira, indexing: false, complete: true })
})

test('a delete removes the post from the trend store', async (t) => {
  const { seeder, serve, settle } = fixture(t)
  await serve([post()])
  await serve([post()])
  const third = await serve([post()])
  t.alike(seeder.indexTopicTrend().topics, feira)
  await third.append(deleteRecord({ seq: 1 }))
  await settle(third)
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: true })
  t.is(seeder.trendStats().trendPosts, 2)
})

test('URL fragments, group posts and a future post cannot supply the third author', async (t) => {
  const { seeder, serve } = fixture(t)
  await serve([post()])
  await serve([post()])
  t.alike(seeder.indexTopicTrend().topics, [])
  const group = 'ab'.repeat(32)
  const kid = { writer: group, seq: 1 }
  const inner = groupPost({ text: '#feira' })
  const encrypted = sealRecord(sealedInner(inner, { writer: group, group, kid }), newEpochKey())
  const future = new Date(Date.now() + 2 * 86400000).toISOString()
  await serve([
    post('https://example.org/#feira'),
    inner,
    groupSealed({ kid, ...encrypted, at: inner.at }),
    { type: 'post', text: '#feira', at: inner.at },
    postRecord({ text: '#feira', at: future })
  ])
  t.is(seeder.trendStats().trendPosts, 3, 'only the two public posts and the future public post were stored')
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: true })
})

test('a held diary and a verified page are excluded from the trend', async (t) => {
  const { seeder, association, serve, settle } = fixture(t)
  await serve([post()])
  await serve([post()])
  const third = await serve([post()])
  const page = hex(third.key)
  const entry = seeder._served.get(page)
  t.alike(seeder.indexTopicTrend().topics, feira)
  entry.searchHold = 1
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: false })
  entry.searchHold = 0
  t.alike(seeder.indexTopicTrend().topics, feira)

  const issuer = keyPair()
  const owner = keyPair()
  const at = new Date().toISOString()
  const issuerCert = createIssuerCert({ issuer: hex(issuer.publicKey), date: at }, association)
  const fields = { type: 'page-roster', page, gen: 1, owner: hex(owner.publicKey), admins: [], prev: null, at, nonce: 'n'.repeat(43), association: seeder.association }
  entry.indexPaused = true
  await third.append(issuerCountersign({ ...fields, signature: signRoster(fields, owner) }, issuer, issuerCert))
  await until(() => entry.topicIndexed === third.length && entry.scanned === third.length, { name: 'leitura do diário da Página' })
  t.ok(entry.indexed < entry.present)
  t.absent(seeder._names.hint(page).page)
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: false })
  seeder._resumeIndex()
  await settle(third)
  t.is(seeder._names.hint(page).page, true)
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: true })
})

test('trend caps leave the topic search cursor free to advance', async (t) => {
  const { seeder, serve } = fixture(t, { trendMaxPosts: 2, trendPerAuthorMax: 1 })
  await serve([post(), post()])
  t.alike(seeder.trendStats(), { trendPosts: 1, trendSaturated: false })
  await serve([post()])
  await serve([post()])
  t.alike(seeder.trendStats(), { trendPosts: 2, trendSaturated: true })
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: false })
  const search = seeder.indexTopic('feira')
  t.is(search.items.length, 4)
  t.is(search.complete, true)
})

test('the post that pauses topic search counts once across a resume', async (t) => {
  const { seeder, serve, settle } = fixture(t, { topicMaxPosts: 3 })
  const other = await serve([post('outra palavra')])
  await serve([post()])
  await serve([post()])
  const last = await serve([post()])
  t.ok(seeder._served.get(hex(last.key)).topicPaused)
  t.alike(seeder.indexTopicTrend(), { topics: feira, indexing: false, complete: false })
  await other.append(deleteRecord({ seq: 1 }))
  await settle(other)
  await until(() => seeder.indexTopic('feira').complete, { name: 'retomada da busca' })
  t.alike(seeder.indexTopicTrend(), { topics: feira, indexing: false, complete: true })
  t.is(seeder.trendStats().trendPosts, 3)
})

test('topic trends are readable while the seeder closes', async (t) => {
  const { seeder, serve } = fixture(t)
  await serve([post()])
  await serve([post()])
  await serve([post()])
  t.alike(seeder.indexTopicTrend().topics, feira)
  const closing = seeder.close()
  t.alike(seeder.indexTopicTrend(), { topics: [], indexing: false, complete: false })
  await closing
  t.is(seeder.trendStats().trendPosts, 0)
})
