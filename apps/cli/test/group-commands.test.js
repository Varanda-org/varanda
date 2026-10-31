'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { testnet, tmpDir } = require('./helpers/net')

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
  await testnet(t)
  const assocDir = tmpDir(t)
  const dir = tmpDir(t)
  const files = tmpDir(t)

  const pub = lastJson(varanda(assocDir, ['assoc', 'init', '--json'])).publicKey
  const A = lastJson(varanda(dir, ['id', 'create', '--association', pub, '--json'])).publicKey
  const cert = path.join(files, 'a.json')
  t.is(varanda(assocDir, ['assoc', 'certify', '--member', A, '--out', cert]).code, 0)

  // refusals that need no identity
  t.is(varanda(dir, ['group']).code, 2, 'no subcommand')
  t.is(varanda(dir, ['group', 'bogus']).code, 2, 'unknown subcommand')
  t.is(varanda(dir, ['group', 'create', '--join', 'open']).code, 2, 'create needs --name')
  t.is(varanda(dir, ['group', 'create', '--name', 'x']).code, 2, 'create needs --join')
  const priv = varanda(dir, ['group', 'create', '--name', 'x', '--join', 'private'])
  t.is(priv.code, 2, '--join private refused')
  t.ok(priv.stderr.includes('para um grupo privado use --private'), 'points to --private')
  const openPriv = varanda(dir, ['group', 'create', '--name', 'x', '--join', 'open', '--private'])
  t.is(openPriv.code, 2, 'a private group is never open')
  t.ok(openPriv.stderr.includes('sempre por aprovação'), 'says why')
  t.is(varanda(dir, ['group', 'rekey']).code, 2, 'rekey needs a key')
  t.is(varanda(dir, ['group', 'join']).code, 2, 'join needs a key')
  t.is(varanda(dir, ['group', 'join', 'abc']).code, 2, 'join rejects a malformed key')

  t.is(varanda(dir, ['cert', 'add', '--cert-file', cert]).code, 0)
  t.is(varanda(dir, ['profile', 'set', '--name', 'Ana']).code, 0)

  const created = varanda(dir, ['group', 'create', '--name', 'Cozinha', '--join', 'open', '--json'])
  t.is(created.code, 0, created.stderr)
  const G = lastJson(created).group
  t.ok(HEX64.test(G), 'root key')

  t.ok(varanda(dir, ['group', 'list']).stdout.includes(G + ' Cozinha (aberto'), 'list shows the group')
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
  const pending = varanda(dir, ['group', 'join', 'a'.repeat(64)])
  t.is(pending.code, 0, pending.stderr)
  t.is(pending.stdout.trim(), 'entrada registrada: o grupo chega na próxima sincronização')
  const listed = varanda(dir, ['group', 'list'])
  t.ok(listed.stdout.includes('a'.repeat(64) + ' (aguardando a sincronização)'), 'listed as pending')

  const info = varanda(dir, ['group', 'info', G])
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
  const privCreated = run(['group', 'create', '--private', '--name', 'Segredo'])
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
