'use strict'

const test = require('brittle')
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

test('community commands end to end', async (t) => {
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
  t.is(varanda(dir, ['community']).code, 2, 'no subcommand')
  t.is(varanda(dir, ['community', 'bogus']).code, 2, 'unknown subcommand')
  t.is(varanda(dir, ['community', 'create']).code, 2, 'create needs --name')
  t.is(varanda(dir, ['community', 'info']).code, 2, 'info needs a key')
  const bad = varanda(dir, ['community', 'info', 'abc'])
  t.is(bad.code, 2, 'info rejects a malformed key')
  t.ok(bad.stderr.includes('chave da comunidade inválida'), 'clear message')
  t.is(varanda(dir, ['community', 'link', 'a'.repeat(64)]).code, 2, 'link needs a group key')
  const badGroup = varanda(dir, ['community', 'link', 'a'.repeat(64), 'xyz'])
  t.is(badGroup.code, 2, 'link rejects a malformed group key')
  t.ok(badGroup.stderr.includes('chave do grupo inválida'))
  t.is(varanda(dir, ['community', 'admin', 'a'.repeat(64)]).code, 2, 'admin needs --member')

  t.is(varanda(dir, ['cert', 'add', '--cert-file', cert]).code, 0)
  t.is(varanda(dir, ['profile', 'set', '--name', 'Ana']).code, 0)

  const created = varanda(dir, ['community', 'create', '--name', 'Bairro'])
  t.is(created.code, 0, created.stderr)
  t.ok(created.stdout.startsWith('comunidade criada: '), 'create line')
  const C = created.stdout.trim().slice('comunidade criada: '.length)
  t.ok(HEX64.test(C), 'community root key')
  const json = lastJson(varanda(dir, ['community', 'create', '--name', 'Outra', '--json']))
  t.ok(HEX64.test(json.community) && json.community !== C, '--json last line is the result')

  const G = lastJson(varanda(dir, ['group', 'create', '--name', 'Horta', '--join', 'open', '--json'])).group

  const empty = lastJson(varanda(dir, ['community', 'info', C, '--json']))
  t.alike([empty.community, empty.name, empty.creator, empty.groups, empty.admins, empty.state], [C, 'Bairro', A, [], 1, 'ready'], 'info before any link')

  const linked = varanda(dir, ['community', 'link', C, G])
  t.is(linked.code, 0, linked.stderr)
  t.is(linked.stdout.trim(), 'vínculo gravado (lado: comunidade e grupo)', 'both sides written')
  const info = varanda(dir, ['community', 'info', C.toUpperCase()])
  t.is(info.code, 0, info.stderr)
  const lines = info.stdout.trim().split('\n')
  t.is(lines[0], C + ' Bairro (1 grupos, 1 administradores)')
  t.is(lines[1], 'criador: ' + A)
  t.is(lines[2], 'grupo: ' + G + ' Horta')
  t.alike(lastJson(varanda(dir, ['group', 'info', G, '--json'])).communities, [C], 'group info names the community')

  // one community per group
  const other = varanda(dir, ['community', 'link', json.community, G])
  t.is(other.code, 2, 'second community refused')
  t.ok(other.stderr.includes('o grupo já está em outra comunidade'), other.stderr)

  // a group key is never a community
  const notCommunity = varanda(dir, ['community', 'info', G])
  t.is(notCommunity.code, 1)
  t.ok(notCommunity.stderr.includes('comunidade não encontrada'), notCommunity.stderr)

  const self = varanda(dir, ['community', 'admin', C, '--member', A])
  t.is(self.code, 2, 'creator as member refused')
  t.ok(self.stderr.includes('o criador da comunidade já administra'), self.stderr)
  const B = 'b'.repeat(64)
  const granted = varanda(dir, ['community', 'admin', C, '--member', B, '--json'])
  t.is(granted.code, 0, granted.stderr)
  t.alike(lastJson(granted), { community: C, member: B, on: true })
  t.is(lastJson(varanda(dir, ['community', 'info', C, '--json'])).admins, 2, 'admin counted')
  t.is(varanda(dir, ['community', 'admin', C, '--member', B, '--undo']).stdout.trim(), 'administração da comunidade retirada')
  t.is(lastJson(varanda(dir, ['community', 'info', C, '--json'])).admins, 1, 'admin removed')

  const unlinked = varanda(dir, ['community', 'link', C, G, '--undo', '--json'])
  t.is(unlinked.code, 0, unlinked.stderr)
  t.alike(lastJson(unlinked), { community: C, group: G, on: false, sides: ['community', 'group'] })
  t.alike(lastJson(varanda(dir, ['community', 'info', C, '--json'])).groups, [], 'unlinked')

  // a community whose root has not arrived yet
  const pending = varanda(dir, ['community', 'info', 'c'.repeat(64)])
  t.is(pending.code, 0, pending.stderr)
  t.is(pending.stdout.trim(), 'c'.repeat(64) + ' (aguardando a sincronização)')
})
