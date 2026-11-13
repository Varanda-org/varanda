'use strict'

// The pure read of an unfollowed person's public profile (src/peerProfile.js).
const test = require('brittle')

const load = () => import('../src/peerProfile.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const avatar = { core: 'ee'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: 'ff'.repeat(32), width: 512, height: 512 }

test('wantsPeek only for a profile.read that answered missing', async (t) => {
  const { wantsPeek } = await load()
  t.is(wantsPeek(null), true)
  t.is(wantsPeek(undefined), false)
  t.is(wantsPeek({ name: 'Ana' }), false)
})

test('peerEntryOf reads name, @nome, bio and photo of the matching peek', async (t) => {
  const { peerEntryOf } = await load()
  const entry = peerEntryOf({ key: A, profile: { name: 'Ana', bio: 'oi', avatar }, username: 'ana' }, A)
  t.alike(entry, { name: 'Ana', username: 'ana', bio: 'oi', avatar })
  t.not(entry.avatar, avatar, 'a copy, never the peer object')
})

test('peerEntryOf rejects another key and matches an uppercase input key', async (t) => {
  const { peerEntryOf } = await load()
  t.is(peerEntryOf({ key: B, profile: { name: 'Ana' } }, A), null)
  t.alike(peerEntryOf({ key: A, profile: { name: 'Ana' } }, A.toUpperCase()), { name: 'Ana', username: null, bio: null, avatar: null })
})

test('peerEntryOf drops an invalid photo and empty strings', async (t) => {
  const { peerEntryOf } = await load()
  t.alike(peerEntryOf({ key: A, profile: { name: 'Ana', bio: '', avatar: { ...avatar, width: 100 } } }, A), { name: 'Ana', username: null, bio: null, avatar: null })
  t.is(peerEntryOf({ key: A, profile: { name: '', avatar: { ...avatar, mime: 'image/gif' } } }, A), null)
})

test('peerEntryOf with a null profile and a username only', async (t) => {
  const { peerEntryOf } = await load()
  t.alike(peerEntryOf({ key: A, profile: null, username: 'ana' }, A), { name: null, username: 'ana', bio: null, avatar: null })
})

test('peerEntryOf is null for an empty answer or a non-object peek', async (t) => {
  const { peerEntryOf } = await load()
  t.is(peerEntryOf({ key: A, profile: null }, A), null)
  t.is(peerEntryOf({ key: A, profile: {}, username: '' }, A), null)
  t.is(peerEntryOf(null, A), null)
  t.is(peerEntryOf(undefined, A), null)
  t.is(peerEntryOf('x', A), null)
  t.is(peerEntryOf({ key: A, profile: { name: 'Ana' } }, null), null)
})

test('readPeerEntry asks the node for the exact peek and returns the entry', async (t) => {
  const { readPeerEntry } = await load()
  const calls = { member: [], peek: [] }
  const entry = await readPeerEntry(A.toUpperCase(), {
    fetchMember: async (...args) => {
      calls.member.push(args)
      return { ok: true, value: { profileSeq: 4, usernameSeq: 2, name: 'Fake from the index' } }
    },
    peek: async (params) => {
      calls.peek.push(params)
      return { key: A, profile: { name: 'Ana' }, username: 'ana' }
    }
  })
  t.alike(entry, { name: 'Ana', username: 'ana', bio: null, avatar: null })
  t.alike(calls.member, [[A.toUpperCase()]])
  t.alike(calls.peek, [{ author: A, seqs: [2, 4], profileOnly: true, profileSeq: 4, usernameSeq: 2 }])
})

test('readPeerEntry is null when the member lookup fails', async (t) => {
  const { readPeerEntry } = await load()
  let peeked = 0
  const peek = async () => { peeked++; return null }
  t.is(await readPeerEntry(A, { fetchMember: async () => ({ ok: false }), peek }), null)
  t.is(await readPeerEntry(A, { fetchMember: async () => null, peek }), null)
  t.is(await readPeerEntry(A, { fetchMember: async () => { throw new Error('down') }, peek }), null)
  t.is(peeked, 0)
})

test('readPeerEntry does not peek without hints', async (t) => {
  const { readPeerEntry } = await load()
  let peeked = 0
  const entry = await readPeerEntry(A, {
    fetchMember: async () => ({ ok: true, value: { profileSeq: 0, usernameSeq: null } }),
    peek: async () => { peeked++; return { key: A, profile: { name: 'Ana' } } }
  })
  t.is(entry, null)
  t.is(peeked, 0)
})

test('readPeerEntry is null when the peek throws, and never retries', async (t) => {
  const { readPeerEntry } = await load()
  let members = 0
  let peeks = 0
  const entry = await readPeerEntry(A, {
    fetchMember: async () => { members++; return { ok: true, value: { profileSeq: 1 } } },
    peek: async () => { peeks++; throw new Error('refused') }
  })
  t.is(entry, null)
  t.is(members, 1)
  t.is(peeks, 1)
})

function nodeError (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

test('readPeerEntry is PEER_GONE when the index has no such author, without a peek', async (t) => {
  const { readPeerEntry, PEER_GONE } = await load()
  let peeked = 0
  const entry = await readPeerEntry(A, {
    fetchMember: async () => ({ ok: false, reason: 'not-found' }),
    peek: async () => { peeked++; return { key: A, profile: { name: 'Ana' } } }
  })
  t.is(entry, PEER_GONE)
  t.is(peeked, 0)
})

test('readPeerEntry is PEER_GONE when the node refuses the diary itself', async (t) => {
  const { readPeerEntry, PEER_GONE } = await load()
  let peeks = 0
  const entry = await readPeerEntry(A, {
    fetchMember: async () => ({ ok: true, value: { profileSeq: 1 } }),
    peek: async () => { peeks++; throw nodeError('NOT_FOUND', 'diário indisponível') }
  })
  t.is(entry, PEER_GONE)
  t.is(peeks, 1, 'no retry')
})

test('readPeerEntry keeps what is shown (null) on a passing failure', async (t) => {
  const { readPeerEntry, PEER_GONE } = await load()
  const hints = async () => ({ ok: true, value: { profileSeq: 1 } })
  for (const reason of ['network', 'rate-limited', 'malformed', 'status', 'invalid-input']) {
    const entry = await readPeerEntry(A, { fetchMember: async () => ({ ok: false, reason }), peek: async () => ({ key: A, profile: { name: 'Ana' } }) })
    t.is(entry, null, reason)
  }
  const refusals = [
    nodeError('NOT_FOUND', 'semeador indisponível'),
    nodeError('NOT_FOUND', 'não encontrado'),
    nodeError('TIMEOUT', 'diário indisponível'),
    nodeError('CLOSED', 'conexão fechada'),
    new Error('diário indisponível'),
    null
  ]
  for (const err of refusals) {
    const entry = await readPeerEntry(A, { fetchMember: hints, peek: async () => { throw err } })
    t.is(entry, null, err ? err.code + ' ' + err.message : 'null rejection')
    t.not(entry, PEER_GONE)
  }
  t.is(await readPeerEntry(A, { fetchMember: hints, peek: async () => ({ key: B, profile: { name: 'Ana' } }) }), null, 'a wrong key')
  t.is(await readPeerEntry(A, { fetchMember: hints, peek: async () => ({ key: A, profile: {} }) }), null, 'an empty profile')
  t.is(await readPeerEntry(A, { fetchMember: async () => ({ ok: true, value: { profileSeq: 0 } }), peek: hints }), null, 'no hints')
})
