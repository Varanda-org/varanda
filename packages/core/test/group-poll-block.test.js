'use strict'

// Seeder#groupPostBlock on a forum poll (group-poll): the options come back
// as the reported text so a moderator can review them; a private group never
// answers. No network, no swarm: the method runs against a stubbed seeder
// whose group core is an in-memory list of encoded blocks.
const test = require('brittle')
const b4a = require('b4a')
const { Seeder } = require('../lib/seeder')
const { groupPost, groupPoll, groupTopic, groupChoice, groupEvent } = require('../lib/group')
const { writerHeader, encode } = require('./helpers/seeder-groups')

const R = 'a1'.repeat(32)
const W = 'b2'.repeat(32)
const D = 'c3'.repeat(32)
const TOPIC = { writer: R, seq: 1 }

function fake ({ visibility = 'public', blocks, blocked = false, writer = W }) {
  // A null block stands for one this seeder does not hold locally.
  const raws = blocks.map((b) => (b === null || b4a.isBuffer(b) ? b : encode(b)))
  const core = {
    fork: 0,
    length: raws.length,
    has: async (i) => i < raws.length && raws[i] !== null,
    get: async (i) => raws[i]
  }
  const stub = {
    _closing: false,
    _moderationGen: 0,
    _groupServed: new Map([[writer, { core, group: R, diary: D, headerOk: true, dropped: false }]]),
    _isBlocked: () => blocked,
    _groupVisibility: () => visibility
  }
  return (seq, key = writer) => Seeder.prototype.groupPostBlock.call(stub, key, seq)
}

const header = (box = null) => writerHeader({ group: R, diary: D, box })

test('groupPostBlock: a group-poll of a public group answers its options as texto', async (t) => {
  const read = fake({
    blocks: [
      header(),
      groupPost({ text: 'Vamos?' }),
      groupTopic({ target: TOPIC }),
      groupPoll({ target: TOPIC, options: ['Sim', 'Não', 'Talvez à noite'] })
    ]
  })
  const got = await read(3)
  t.alike(got, { group: R, diary: D, seq: 3, texto: 'Sim\nNão\nTalvez à noite', resposta: { writer: R, seq: 1 } })
  t.alike(await read(1), { group: R, diary: D, seq: 1, texto: 'Vamos?', resposta: null }, 'a plain group-post still answers as before')
  t.is(await read(2), null, 'a topic mark is no reported text')
})

test('groupPostBlock: the same poll bytes in a private or unknown-visibility group answer null', async (t) => {
  const blocks = [header(), groupPost({ text: 'Vamos?' }), groupPoll({ target: TOPIC, options: ['Sim', 'Não'] })]
  t.is(await fake({ visibility: 'private', blocks })(2), null, 'private')
  t.is(await fake({ visibility: null, blocks })(2), null, 'unknown')
  t.alike((await fake({ visibility: 'public', blocks })(2)).texto, 'Sim\nNão', 'public control')
})

test('groupPostBlock: a malformed poll, a choice, a blocked author and a bad seq answer null', async (t) => {
  const bad = { ...groupPoll({ target: TOPIC, options: ['Sim', 'Não'] }), options: ['só uma'] }
  const blocks = [header(), groupPost({ text: 'Vamos?' }), bad, groupChoice({ target: TOPIC, pick: 0 }), groupPoll({ target: TOPIC, options: ['Sim', 'Não'] })]
  const read = fake({ blocks })
  t.is(await read(2), null, 'options below the minimum')
  t.is(await read(3), null, 'a vote is no reported text')
  t.ok(await read(4), 'a valid poll')
  t.is(await read(0), null, 'block 0 is the header')
  t.is(await read(5), null, 'past the length')
  t.is(await read(4, 'f'.repeat(64)), null, 'not served')
  t.is(await fake({ blocks, blocked: true })(4), null, 'blocked group or diary')
})

test('groupPostBlock: a reported topic root answers its text followed by its poll options', async (t) => {
  const OWN = { writer: W, seq: 1 }
  const read = fake({
    blocks: [
      header(),
      groupPost({ text: 'Vamos?' }),
      groupTopic({ target: OWN }),
      groupPoll({ target: OWN, options: ['Sim', 'ofensa nas opções'] }),
      groupPoll({ target: OWN, options: ['Depois', 'Nunca'] }),
      groupPost({ text: 'resposta', replyTo: OWN })
    ]
  })
  t.alike(await read(1), { group: R, diary: D, seq: 1, texto: 'Vamos?\nSim\nofensa nas opções', resposta: null }, 'the lowest-seq poll on the own core')
  t.is((await read(5)).texto, 'resposta', 'a reply carries no poll')
})

test('groupPostBlock: a root post answers its text alone without its own poll, or in a private group', async (t) => {
  const OWN = { writer: W, seq: 1 }
  const elsewhere = fake({ blocks: [header(), groupPost({ text: 'Vamos?' }), groupPoll({ target: TOPIC, options: ['Sim', 'Não'] })] })
  t.is((await elsewhere(1)).texto, 'Vamos?', 'a poll naming another core is not this root\'s')
  const gap = fake({ blocks: [header(), groupPost({ text: 'Vamos?' }), null, b4a.from('lixo'), groupPoll({ target: OWN, options: ['Sim', 'Não'] })] })
  t.is((await gap(1)).texto, 'Vamos?\nSim\nNão', 'a block not held and an undecodable one in between are skipped')
  const far = [header(), groupPost({ text: 'Vamos?' })]
  for (let i = 0; i < 16; i++) far.push(groupChoice({ target: OWN, pick: 0 }))
  far.push(groupPoll({ target: OWN, options: ['Sim', 'Não'] }))
  t.is((await fake({ blocks: far })(1)).texto, 'Vamos?', 'the look-ahead is bounded')
  const priv = [writerHeader({ group: R, diary: D, box: null }), groupPost({ text: 'Vamos?' }), groupPoll({ target: OWN, options: ['Sim', 'Não'] })]
  const got = await fake({ visibility: 'private', blocks: priv })(1)
  t.is(got, null, 'a private group never hands out a plaintext root or its poll')
})

const EV = { title: 'Mutirão da horta', start: '2030-05-01T12:00:00.000Z', end: null, place: 'Praça Central' }
const ev = (over = {}) => groupEvent({ target: TOPIC, ...EV, ...over })

test('groupPostBlock: a group-event of a public group answers its title and place as texto', async (t) => {
  const read = fake({ blocks: [header(), groupPost({ text: 'Vamos?' }), ev(), ev({ place: '' })] })
  t.alike(await read(2), { group: R, diary: D, seq: 2, texto: 'Mutirão da horta\nPraça Central', resposta: { writer: R, seq: 1 } })
  t.is((await read(3)).texto, 'Mutirão da horta', 'no place: the title alone')
})

test('groupPostBlock: the same event bytes in a private or unknown-visibility group answer null', async (t) => {
  const blocks = [header(), groupPost({ text: 'Vamos?' }), ev()]
  t.is(await fake({ visibility: 'private', blocks })(2), null, 'private')
  t.is(await fake({ visibility: null, blocks })(2), null, 'unknown')
  t.is(await fake({ blocks, blocked: true })(2), null, 'blocked')
  t.is(await fake({ blocks })(2, 'f'.repeat(64)), null, 'not served')
  t.ok(await fake({ blocks })(2), 'public control')
  const bad = { ...ev(), title: '' }
  t.is(await fake({ blocks: [header(), groupPost({ text: 'Vamos?' }), bad] })(2), null, 'a malformed event')
  const past = { ...ev(), start: '1999-01-01T00:00:00.000Z' }
  t.is(await fake({ blocks: [header(), groupPost({ text: 'Vamos?' }), past] })(2), null, 'a start out of range')
})

test('groupPostBlock: a reported root answers its text followed by its event, the lowest seq of poll or event deciding', async (t) => {
  const OWN = { writer: W, seq: 1 }
  const own = (over = {}) => groupEvent({ target: OWN, ...EV, ...over })
  const read = fake({ blocks: [header(), groupPost({ text: 'Vamos?' }), own(), own({ title: 'outro', place: '' })] })
  t.is((await read(1)).texto, 'Vamos?\nMutirão da horta\nPraça Central', 'the lowest-seq event')
  const both = fake({ blocks: [header(), groupPost({ text: 'Vamos?' }), groupPoll({ target: OWN, options: ['Sim', 'Não'] }), own()] })
  t.is((await both(1)).texto, 'Vamos?\nSim\nNão', 'the poll came first')
  const other = fake({ blocks: [header(), groupPost({ text: 'Vamos?' }), own(), groupPoll({ target: OWN, options: ['Sim', 'Não'] })] })
  t.is((await other(1)).texto, 'Vamos?\nMutirão da horta\nPraça Central', 'the event came first')
  const elsewhere = fake({ blocks: [header(), groupPost({ text: 'Vamos?' }), ev()] })
  t.is((await elsewhere(1)).texto, 'Vamos?', 'an event naming another core is not this root\'s')
  const priv = fake({ visibility: 'private', blocks: [header(), groupPost({ text: 'Vamos?' }), own()] })
  t.is(await priv(1), null, 'a private group never hands out a plaintext root or its event')
})
