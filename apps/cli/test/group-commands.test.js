'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parseArgs } = require('../lib/cli')
const { spawnSync } = require('node:child_process')
const { tmpDir } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const HEX64 = /^[0-9a-f]{64}$/

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

function varanda (dataDir, args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dataDir], { env, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function lastJson (r) {
  const lines = r.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

test('group commands end to end', async (t) => {
  t.timeout(120000)
  const assocDir = tmpDir(t)
  const dir = tmpDir(t)
  const files = tmpDir(t)

  const pub = lastJson(varanda(assocDir, ['assoc', 'init', '--json'])).publicKey
  const A = lastJson(varanda(dir, ['id', 'create', '--association', pub, '--json'])).publicKey
  const cert = path.join(files, 'a.json')
  t.is(varanda(assocDir, ['assoc', 'certify', '--member', A, '--out', cert]).code, 0)

  const C = 'c'.repeat(64)

  const missingCommunity = varanda(dir, ['group', 'create', '--name', 'x', '--join', 'open'])
  t.is(missingCommunity.code, 2)
  t.ok(missingCommunity.stderr.includes('informe --community <chave>'))

  // refusals that need no identity
  t.is(varanda(dir, ['group']).code, 2, 'no subcommand')
  t.is(varanda(dir, ['group', 'bogus']).code, 2, 'unknown subcommand')
  t.is(varanda(dir, ['group', 'create', '--community', C, '--join', 'open']).code, 2, 'create needs --name')
  t.is(varanda(dir, ['group', 'create', '--community', C, '--name', 'x']).code, 2, 'create needs --join')
  const priv = varanda(dir, ['group', 'create', '--community', C, '--name', 'x', '--join', 'private'])
  t.is(priv.code, 2, '--join private refused')
  t.ok(priv.stderr.includes('para um grupo privado use --private'), 'points to --private')
  const openPriv = varanda(dir, ['group', 'create', '--community', C, '--name', 'x', '--join', 'open', '--private'])
  t.is(openPriv.code, 2, 'a private group is never open')
  t.ok(openPriv.stderr.includes('sempre por aprovação'), 'says why')
  t.is(varanda(dir, ['group', 'rekey']).code, 2, 'rekey needs a key')
  t.is(varanda(dir, ['group', 'join']).code, 2, 'join needs a key')
  t.is(varanda(dir, ['group', 'join', 'abc']).code, 2, 'join rejects a malformed key')

  t.is(varanda(dir, ['cert', 'add', '--cert-file', cert]).code, 0)
  t.is(varanda(dir, ['profile', 'set', '--name', 'Ana']).code, 0)

  const community = lastJson(varanda(dir, ['community', 'create', '--name', 'Bairro', '--join', 'open', '--json'])).community
  const created = varanda(dir, ['group', 'create', '--community', community, '--name', 'Cozinha', '--join', 'open', '--json'])
  t.is(created.code, 0, created.stderr)
  const G = lastJson(created).group
  t.ok(HEX64.test(G), 'root key')

  t.ok(varanda(dir, ['group', 'list']).stdout.includes(G + ' Cozinha (aberto'), 'list shows the group')
  t.ok(varanda(dir, ['group', 'list']).stdout.includes(' [comunidade ' + community.slice(0, 8) + ']'), 'list names the parent')
  t.is(lastJson(varanda(dir, ['group', 'info', G, '--json'])).community, community)
  t.is(lastJson(varanda(dir, ['group', 'info', G, '--json'])).creator, A, 'creator is the caller')
  t.ok(varanda(dir, ['group', 'members', G]).stdout.includes(A + ' Ana (admin)'), 'members line')

  t.ok(varanda(dir, ['group', 'post', G, '--text', 'primeira']).stdout.startsWith('publicado #'), 'post prints seq')
  t.is(varanda(dir, ['group', 'post', G]).code, 2, 'post needs --text')
  t.is(varanda(dir, ['group', 'post', G, '--text', 'x\u001b[31m']).code, 1, 'control characters refused')
  const second = lastJson(varanda(dir, ['group', 'post', G, '--text', 'segunda', '--json']))
  t.ok(second.seq >= 1)

  const read = varanda(dir, ['group', 'read', G])
  t.is(read.code, 0, read.stderr)
  const lines = read.stdout.trim().split('\n')
  t.is(lines.length, 2, 'two posts, no pagination line')
  t.ok(/^\d{4}-\d\d-\d\dT\S+ Ana: segunda/.test(lines[0]), 'newest first with author name')
  t.ok(lines[1].endsWith('Ana: primeira'))

  const page = varanda(dir, ['group', 'read', G, '--limit', '1'])
  const pageLines = page.stdout.trim().split('\n')
  t.is(pageLines.length, 2)
  t.ok(pageLines[1].startsWith('mais antigas: --before '), 'pagination hint')
  const cursor = pageLines[1].slice('mais antigas: --before '.length)
  const older = varanda(dir, ['group', 'read', G, '--before', cursor])
  t.ok(older.stdout.trim().endsWith('Ana: primeira') && older.stdout.trim().split('\n').length === 1, 'older page')
  t.is(varanda(dir, ['group', 'read', G, '--before', 'nope']).code, 2, 'malformed cursor')
  t.is(varanda(dir, ['group', 'read', G, '--limit', '99']).code, 2, 'limit above the maximum')
  t.is(lastJson(varanda(dir, ['group', 'read', G, '--json'])).items.length, 2, '--json last line is the result')

  const target = G + ':' + second.seq
  t.is(varanda(dir, ['group', 'hide', G, '--to', target]).code, 0)
  t.ok(varanda(dir, ['group', 'read', G]).stdout.includes('(mensagem oculta)'), 'hidden item')
  t.is(varanda(dir, ['group', 'hide', G, '--to', target, '--undo']).code, 0)
  t.absent(varanda(dir, ['group', 'read', G]).stdout.includes('(mensagem oculta)'), 'shown again')
  t.is(varanda(dir, ['group', 'hide', G]).code, 2, 'hide needs --to')

  t.is(varanda(dir, ['group', 'meta', G]).code, 2, 'meta needs something to change')
  t.is(varanda(dir, ['group', 'meta', G, '--name', 'Cozinha 2', '--join', 'approval']).code, 0)
  t.ok(varanda(dir, ['group', 'list']).stdout.includes('Cozinha 2 (por aprovação'), 'meta applied')
  t.is(varanda(dir, ['group', 'admit', G]).code, 2, 'admit needs --member')

  // a group whose root has not arrived yet: the join is recorded as pending
  const noHint = varanda(dir, ['group', 'join', 'a'.repeat(64)])
  t.is(noHint.code, 2, 'unknown group needs a community hint')
  t.ok(noHint.stderr.includes('informe a comunidade do grupo'), noHint.stderr)
  const pending = varanda(dir, ['group', 'join', 'a'.repeat(64), '--community', community.toUpperCase()])
  t.is(pending.code, 0, pending.stderr)
  t.is(pending.stdout.trim(), 'entrada registrada: o grupo chega na próxima sincronização')
  const listed = varanda(dir, ['group', 'list'])
  t.ok(listed.stdout.includes('a'.repeat(64) + ' (aguardando a sincronização)'), 'listed as pending')

  const info = varanda(dir, ['group', 'info', G])
  t.ok(info.stdout.includes('\ncomunidade: ' + community + '\n'), 'info names the parent')
  t.ok(varanda(dir, ['group', 'info', 'a'.repeat(64)]).stdout.includes('comunidade: desconhecida até a sincronização'))
  t.ok(info.stdout.includes('\nvisibilidade: público\n'), 'info shows a public group')
  t.is(lastJson(varanda(dir, ['group', 'info', G, '--json'])).visibility, 'public')
  const publicRekey = varanda(dir, ['group', 'rekey', G])
  t.is(publicRekey.code, 2, 'a public group has no key')
  t.ok(publicRekey.stderr.includes('grupo público não usa chave'))

  // private group: created by approval, readable by its creator, rekeyed
  const outputs = []
  const run = (args) => {
    const r = varanda(dir, args)
    outputs.push(r.stdout, r.stderr)
    return r
  }
  const privCreated = run(['group', 'create', '--community', community, '--private', '--name', 'Segredo'])
  t.is(privCreated.code, 0, privCreated.stderr)
  t.ok(privCreated.stdout.startsWith('grupo privado criado: '), 'pt-BR create line')
  const P = privCreated.stdout.trim().slice('grupo privado criado: '.length)
  t.ok(HEX64.test(P), 'private root key')
  const privInfo = run(['group', 'info', P])
  t.ok(privInfo.stdout.includes(P + ' Segredo (por aprovação'), 'name opened from the sealed meta, approval forced')
  t.ok(privInfo.stdout.includes('\nvisibilidade: privado (cifrado)\n'), 'info shows the visibility')
  const privJson = lastJson(run(['group', 'info', P, '--json']))
  t.is(privJson.visibility, 'private')
  t.is(privJson.join, 'approval')
  t.ok(run(['group', 'post', P, '--text', 'só para membros']).stdout.startsWith('publicado #'), 'sealed post')
  const privRead = run(['group', 'read', P])
  t.is(privRead.code, 0, privRead.stderr)
  t.ok(privRead.stdout.trim().endsWith('Ana: só para membros'), 'the creator reads its own sealed post')
  t.is(privRead.stderr, '', 'nothing sealed for the creator')
  const readJson = lastJson(run(['group', 'read', P, '--json']))
  t.is(readJson.sealed, 0)
  t.is(readJson.state, 'ok')
  t.ok(readJson.epoch !== null && HEX64.test(readJson.epoch.writer), 'epoch is a ref, not a key')
  const rekeyed = run(['group', 'rekey', P])
  t.is(rekeyed.code, 0, rekeyed.stderr)
  t.is(rekeyed.stdout.trim(), 'nova chave do grupo gerada e entregue aos membros')
  const rekeyJson = lastJson(run(['group', 'rekey', P, '--json']))
  t.is(rekeyJson.group, P)
  t.alike(Object.keys(rekeyJson.epoch).sort(), ['seq', 'writer'], 'only the epoch ref')
  t.ok(run(['group', 'post', P, '--text', 'depois da troca']).stdout.startsWith('publicado #'), 'posts under the new epoch')
  const afterRead = run(['group', 'read', P]).stdout.trim().split('\n')
  t.is(afterRead.length, 2, 'both epochs readable')
  t.ok(afterRead[0].endsWith('Ana: depois da troca'), 'reads the new epoch')
  t.ok(run(['group', 'list']).stdout.includes(P + ' Segredo'), 'listed with its sealed name')

  // No output ever carries the box secret.
  const box = JSON.parse(fs.readFileSync(path.join(dir, 'group-box.json'), 'utf8'))
  t.ok(HEX64.test(box.secretKey), 'box key file exists')
  t.absent(outputs.some((o) => o.includes(box.secretKey)), 'box secret never printed')
  t.absent(outputs.some((o) => o.includes(Buffer.from(box.secretKey, 'hex').toString('base64'))), 'nor in base64')

  const left = varanda(dir, ['group', 'leave', G])
  t.is(left.code, 0, left.stderr)
  t.is(left.stdout.trim(), 'você saiu do grupo')
})

test('members and requests read every page, not only the first', async (t) => {
  const { allPages } = require('../lib/commands/group')
  const all = Array.from({ length: 230 }, (_, i) => ({ member: String(i) }))
  const calls = []
  const fetch = async ({ offset, limit }) => {
    calls.push(offset)
    return { members: all.slice(offset, offset + limit), total: all.length }
  }
  const r = await allPages(fetch, 'members')
  t.is(r.members.length, 230)
  t.is(r.total, 230)
  t.alike(calls, [0, 100, 200])
  t.alike(await allPages(async () => ({ members: [], total: 0 }), 'members'), { members: [], total: 0 })
  const groups = Array.from({ length: 64 }, (_, i) => ({ group: String(i) }))
  const listed = await allPages(async ({ offset, limit }) => ({ groups: groups.slice(offset, offset + limit), total: 64 }), 'groups', 31)
  t.is(listed.groups.length, 64, 'group list reads past the first 31')
})

test('group info distinguishes unknown parents and orphans', async (t) => {
  const filename = path.join(__dirname, '../lib/commands/group.js')
  const module = { exports: {} }
  const G = 'a'.repeat(64)
  const C = 'c'.repeat(64)
  let output = ''
  let result
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    require: name => name === '@varanda/core/lib/member' ? { groupInfo: async () => result } : require(name),
    process: { stdout: { write: text => { output += text } } }
  }, { filename })
  for (const [community, orphan, expected] of [
    [C, false, 'comunidade: ' + C],
    [null, false, 'comunidade: desconhecida até a sincronização'],
    [C, true, 'grupo sem comunidade']
  ]) {
    result = { group: G, name: 'Horta', join: 'open', role: 'member', members: 1, visibility: 'public', creator: G, state: 'ready', community, orphan }
    output = ''
    await module.exports.commands.group.run(parseArgs(['group', 'info', G], {}))
    t.ok(output.endsWith(expected + '\n'))
    output = ''
    await module.exports.commands.group.run(parseArgs(['group', 'info', G, '--json'], {}))
    t.alike(JSON.parse(output), result)
  }
})

test('group read renders safe media markers and preserves descriptors in JSON', async (t) => {
  const filename = path.join(__dirname, '../lib/commands/group.js')
  const module = { exports: {} }
  const G = 'a'.repeat(64)
  const at = '2026-01-01T00:00:00.000Z'
  const base = { writer: G, diary: G, at, replyTo: null, hidden: false, name: 'Ana', username: null }
  const photo = { core: G, mime: 'image/png', start: 1, blocks: 1, bytes: 1, sha256: G, width: 1, height: 1 }
  const privatePhoto = { core: G, start: 1, ...require('@varanda/core/lib/group-media').sealMedia(Buffer.from('fixture'), { plainMime: 'image/gif', w: 1, h: 1 }).item }
  const result = {
    items: [
      { ...base, seq: 5, text: 'álbum\u001b[31m\n\u202e', media: [photo, { ...photo, start: 2, mime: 'image/gif' }] },
      { ...base, seq: 4, text: '', media: [privatePhoto, { ...privatePhoto, start: 2, plainMime: 'image/webp' }] },
      { ...base, seq: 3, text: 'oculto', hidden: true, media: [photo] },
      { ...base, seq: 2, text: 'texto v1' },
      { ...base, seq: 1, text: 'texto', media: null }
    ],
    next: null,
    hidden: 1,
    incomplete: false,
    sealed: 0,
    epoch: null,
    state: 'ok'
  }
  let output = ''
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    require: name => {
      if (name === '@varanda/core/lib/member') return { groupRead: async () => result }
      const mod = require(name)
      if (name !== '@varanda/rpc') return mod
      return { ...mod, validateParams: (method, params) => mod.validateParams(method, JSON.parse(JSON.stringify(params))) }
    },
    process: { stdout: { write: text => { output += text } }, stderr: { write: () => t.fail('unexpected warning') } }
  }, { filename })
  await module.exports.commands.group.run(parseArgs(['group', 'read', G], {}))
  t.is(output, [
    at + ' Ana: álbum\\u{1b}[31m\\u{a}\\u{202e} [foto] [gif]',
    at + ' Ana:  [gif] [foto]',
    at + ' Ana: (mensagem oculta)',
    at + ' Ana: texto v1',
    at + ' Ana: texto',
    ''
  ].join('\n'))
  output = ''
  await module.exports.commands.group.run(parseArgs(['group', 'read', G, '--json'], {}))
  t.alike(JSON.parse(output), {
    ...result,
    items: result.items.map(item => ({ ...item, media: !item.hidden && item.media ? item.media.map(({ key, nonce, ...d }) => d) : null }))
  }, 'JSON retains media rather than the display markers')
  t.absent(output.includes(privatePhoto.key) || output.includes(privatePhoto.nonce), 'no command prints a private item key or nonce')
  t.is(output.trim().split('\n').length, 1, 'JSON stays on one terminal line')
})
