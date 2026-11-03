'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const { openStore } = require('@varanda/core/lib/store')
const { tmpDir } = require('./helpers/net')
const { parseArgs } = require('../lib/cli')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const HEX64 = /^[0-9a-f]{64}$/
const USAGE = 'node bin/varanda.js community create|join|leave|info|list|members|requests|admit|ban|admin|meta|remove-group'

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

// Replicate fixture cores in memory; these commands never need a DHT.
async function exchange (from, to) {
  const a = await openStore(from)
  const b = await openStore(to)
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
      for (let seq = 0; seq < source.contiguousLength; seq++) await target.get(seq, { raw: true, timeout: 10000 })
    }
  } finally {
    if (left) left.destroy()
    if (right) right.destroy()
    await b.close()
    await a.close()
  }
}

test('community commands end to end', async (t) => {
  t.timeout(120000)
  const assocDir = tmpDir(t)
  const dir = tmpDir(t)
  const bob = tmpDir(t)
  const files = tmpDir(t)

  const pub = lastJson(varanda(assocDir, ['assoc', 'init', '--json'])).publicKey
  const keys = []
  for (const [data, name] of [[dir, 'Ana'], [bob, 'Bia']]) {
    const key = lastJson(varanda(data, ['id', 'create', '--association', pub, '--json'])).publicKey
    keys.push(key)
    const cert = path.join(files, name + '.json')
    t.is(varanda(assocDir, ['assoc', 'certify', '--member', key, '--out', cert]).code, 0)
    t.is(varanda(data, ['cert', 'add', '--cert-file', cert]).code, 0)
    t.is(varanda(data, ['profile', 'set', '--name', name]).code, 0)
  }
  const [A, B] = keys

  for (const args of [[], ['bogus'], ['link', 'a'.repeat(64), 'b'.repeat(64)], ['link', 'a'.repeat(64), 'xyz']]) {
    const r = varanda(dir, ['community', ...args])
    t.is(r.code, 2, 'unknown subcommand')
    t.is(r.stderr, 'uso: ' + USAGE + '\n')
  }
  for (const args of [
    ['create'], ['create', '--name', 'x'], ['create', '--name', 'x', '--join', 'private'],
    ['info'], ['admin', 'a'.repeat(64)], ['admit', 'a'.repeat(64)], ['ban', 'a'.repeat(64)]
  ]) t.is(varanda(dir, ['community', ...args]).code, 2, 'required arguments: ' + args.join(' '))
  const bad = varanda(dir, ['community', 'info', 'abc'])
  t.is(bad.code, 2)
  t.ok(bad.stderr.includes('chave da comunidade inválida'))

  const created = varanda(dir, ['community', 'create', '--name', 'Bairro', '--join', 'open'])
  t.is(created.code, 0, created.stderr)
  const createdLines = created.stdout.trim().split('\n')
  t.is(createdLines.length, 2)
  const C = createdLines[0].slice('comunidade criada: '.length)
  const G = createdLines[1].slice('grupo Geral: '.length)
  t.is(createdLines[0], 'comunidade criada: ' + C)
  t.is(createdLines[1], 'grupo Geral: ' + G)
  t.ok(HEX64.test(C) && HEX64.test(G) && C !== G, 'both root keys printed')
  const other = lastJson(varanda(dir, ['community', 'create', '--name', 'Outra', '--join', 'approval', '--json']))
  t.ok(HEX64.test(other.community) && other.community !== C)
  t.ok(HEX64.test(other.group) && other.group !== G)

  const initial = lastJson(varanda(dir, ['community', 'info', C, '--json']))
  t.alike([initial.community, initial.name, initial.creator, initial.members, initial.admins, initial.state, initial.general], [C, 'Bairro', A, 1, 1, 'ready', G])
  t.is(initial.groups.length, 1, 'Geral exists at creation')
  const H = lastJson(varanda(dir, ['group', 'create', '--community', C, '--name', 'Horta', '--join', 'open', '--json'])).group
  const info = varanda(dir, ['community', 'info', C.toUpperCase()])
  t.is(info.code, 0, info.stderr)
  const lines = info.stdout.trim().split('\n')
  t.is(lines[0], C + ' Bairro (2 grupos, 1 membros, 1 administradores, aberta)')
  t.is(lines[1], 'criador: ' + A)
  t.is(lines[2], 'sua situação: creator')
  t.ok(lines.includes('grupo: ' + G + ' Geral (Geral)'))
  t.ok(lines.includes('grupo: ' + H + ' Horta (público)'))
  t.is(lastJson(varanda(dir, ['group', 'info', H, '--json'])).community, C)
  const wrong = varanda(dir, ['group', 'join', H, '--community', other.community])
  t.is(wrong.code, 2, 'a group belongs to exactly one community')
  t.ok(wrong.stderr.includes('o grupo não é dessa comunidade'))
  const notCommunity = varanda(dir, ['community', 'info', H])
  t.is(notCommunity.code, 1)
  t.ok(notCommunity.stderr.includes('comunidade não encontrada'))
  const self = varanda(dir, ['community', 'admin', C, '--member', A])
  t.is(self.code, 2)
  t.ok(self.stderr.includes('o criador da comunidade já administra'))
  t.is(varanda(dir, ['community', 'admin', C, '--member', B]).code, 2, 'admin must already be a member')

  await exchange(dir, bob)
  const joined = varanda(bob, ['community', 'join', C])
  t.is(joined.code, 0, joined.stderr)
  t.is(joined.stdout, 'você entrou na comunidade\nvocê entrou no Geral: ' + G + '\n')
  await exchange(bob, dir)
  t.is(varanda(dir, ['community', 'admin', C, '--member', B]).stdout.trim(), 'administrador da comunidade nomeado')
  t.is(lastJson(varanda(dir, ['community', 'info', C, '--json'])).admins, 2)
  t.ok(varanda(dir, ['community', 'members', C]).stdout.includes(B + ' Bia (admin)'))
  const revoked = varanda(dir, ['community', 'admin', C, '--member', B, '--undo', '--json'])
  t.alike(lastJson(revoked), { community: C, member: B, on: false })
  t.is(lastJson(varanda(dir, ['community', 'info', C, '--json'])).admins, 1)
  t.is(varanda(dir, ['community', 'ban', C, '--member', B]).stdout.trim(), 'membro banido')
  t.ok(varanda(dir, ['community', 'members', C]).stdout.includes(B + ' Bia (banido)'))
  t.is(varanda(dir, ['community', 'ban', C, '--member', B, '--undo']).stdout.trim(), 'banimento retirado')

  const request = varanda(bob, ['community', 'join', other.community])
  t.is(request.code, 0, request.stderr)
  t.is(request.stdout, 'pedido enviado: aguarde um administrador\nvocê entrou no Geral: ' + other.group + '\n')
  await exchange(bob, dir)
  t.is(varanda(dir, ['community', 'requests', other.community]).stdout.trim(), B + ' Bia')
  t.is(varanda(dir, ['community', 'admit', other.community, '--member', B]).stdout.trim(), 'membro admitido')
  t.alike(lastJson(varanda(dir, ['community', 'requests', other.community, '--json'])), { requests: [], total: 0 })
  t.is(varanda(dir, ['community', 'admit', other.community, '--member', B, '--undo']).stdout.trim(), 'admissão retirada')
  t.is(varanda(dir, ['community', 'meta', C]).code, 2)
  t.is(varanda(dir, ['community', 'meta', C, '--name', 'Vila', '--join', 'approval']).stdout.trim(), 'comunidade atualizada')
  t.ok(varanda(dir, ['community', 'list']).stdout.includes(C + ' Vila (por aprovação, creator)'))
  const kept = varanda(dir, ['community', 'remove-group', C, H])
  t.is(kept.code, 2, 'the root still has authority')
  t.ok(kept.stderr.includes('sem permissão na comunidade'))
  t.is(lastJson(varanda(dir, ['community', 'info', C, '--json'])).repair, false)
  t.is(lastJson(varanda(dir, ['community', 'list', '--json'])).communities.length, 2)

  const pending = 'c'.repeat(64)
  t.is(varanda(dir, ['community', 'join', pending]).stdout.trim(), 'entrada registrada: a comunidade chega na próxima sincronização')
  t.is(varanda(dir, ['community', 'info', pending]).stdout.trim(), pending + ' (aguardando a sincronização)')
  t.ok(varanda(dir, ['community', 'list']).stdout.includes(pending + ' (aguardando a sincronização)'))
  t.is(varanda(dir, ['community', 'leave', pending]).stdout.trim(), 'você saiu da comunidade')
  t.is(varanda(bob, ['community', 'leave', C]).stdout.trim(), 'você saiu da comunidade')
})

function command (member) {
  const filename = path.join(__dirname, '../lib/commands/community.js')
  const state = { stdout: '' }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    require: name => name === '@varanda/core/lib/member' ? member : (name === './group' ? require('../lib/commands/group') : require(name)),
    process: { stdout: { write: text => { state.stdout += text } } }
  }, { filename })
  return async (args) => {
    state.stdout = ''
    await module.exports.commands.community.run(parseArgs(['community', ...args], {}))
    return state.stdout
  }
}

test('community output handles incomplete roots and sanitizes peer labels', async (t) => {
  const C = 'c'.repeat(64)
  const G = 'a'.repeat(64)
  const result = {
    community: C,
    name: 'Vila\u001b[31m',
    join: 'approval',
    creator: G,
    role: 'member',
    state: 'ready',
    members: 2,
    admins: 1,
    groups: [
      { group: G, name: 'Geral', visibility: 'public', general: true },
      { group: 'b'.repeat(64), name: 'Sala\nprivada', visibility: 'private', general: false },
      { group: 'd'.repeat(64), name: null, visibility: null, general: false }
    ],
    incomplete: true
  }
  const run = command({ communityInfo: async () => result })
  const output = await run(['info', C])
  t.absent(output.includes('\u001b'))
  t.absent(output.includes('Sala\nprivada'))
  t.ok(output.includes(' (privado)\n'))
  t.ok(output.includes('grupo: ' + 'd'.repeat(64) + ' (aguardando a sincronização)'))
  t.ok(output.endsWith('aviso: alguns grupos da comunidade ainda não chegaram\n'))
  const json = await run(['info', C, '--json'])
  t.is(json.trim().split('\n').length, 1)
  t.absent(json.includes('\u001b'))
  t.alike(JSON.parse(json), result)
})

test('community members and requests consume every page and format labels', async (t) => {
  const C = 'c'.repeat(64)
  const people = Array.from({ length: 201 }, (_, i) => ({ member: i.toString(16).padStart(64, '0'), name: null, username: null }))
  people[0] = { ...people[0], name: 'Ana\nSilva', admin: true, banned: true }
  people[1].username = 'bia\u001b[31m'
  for (const [sub, method, field] of [['members', 'communityMembers', 'members'], ['requests', 'communityRequests', 'requests']]) {
    const calls = []
    const run = command({
      [method]: async (ctx, params) => {
        calls.push(params)
        return { [field]: people.slice(params.offset, params.offset + params.limit), total: people.length }
      }
    })
    const output = await run([sub, C])
    t.alike(calls.map(p => [p.community, p.offset, p.limit]), [[C, 0, 100], [C, 100, 100], [C, 200, 100]])
    const lines = output.trim().split('\n')
    t.is(lines.length, 201)
    t.absent(output.includes('\u001b'))
    t.absent(output.includes('Ana\nSilva'))
    t.ok(lines[1].includes(' @bia'))
    t.is(lines[200], people[200].member)
    if (sub === 'members') t.ok(lines[0].endsWith(' (admin) (banido)'))
    t.alike(JSON.parse(await run([sub, C, '--json'])), { [field]: people, total: people.length })
  }
})

test('community mutations never retry an uncertain result', async (t) => {
  const C = 'c'.repeat(64)
  for (const [method, args] of [
    ['communityCreate', ['create', '--name', 'Vila', '--join', 'open']],
    ['communityJoin', ['join', C]], ['communityLeave', ['leave', C]],
    ['communityAdmit', ['admit', C, '--member', 'a'.repeat(64)]],
    ['communityBan', ['ban', C, '--member', 'a'.repeat(64)]],
    ['communitySetAdmin', ['admin', C, '--member', 'a'.repeat(64)]],
    ['communityMeta', ['meta', C, '--name', 'Vila']],
    ['communityRemoveGroup', ['remove-group', C, 'a'.repeat(64)]]
  ]) {
    let calls = 0
    const run = command({
      [method]: async () => {
        calls++
        throw Object.assign(new Error('resposta perdida'), { uncertain: true })
      }
    })
    await t.exception(run(args), /resultado incerto: confira antes de repetir/)
    t.is(calls, 1, method + ' called once')
  }
  const run = command({ communityJoin: async () => ({ state: 'left', group: null }) })
  t.is(await run(['join', C]), 'você não está na comunidade\n')
})

test('community leave passes --force to the node', async (t) => {
  const C = 'c'.repeat(64)
  const calls = []
  const run = command({ communityLeave: async (ctx, params) => { calls.push(params); return { state: 'left' } } })
  t.is(await run(['leave', C]), 'você saiu da comunidade\n')
  t.is(await run(['leave', C, '--force']), 'você saiu da comunidade\n')
  t.alike(calls.map((p) => [p.community, p.force]), [[C, false], [C, true]])
})

test('community remove-group passes both keys to the node', async (t) => {
  const C = 'c'.repeat(64)
  const G = 'a'.repeat(64)
  const calls = []
  const run = command({ communityRemoveGroup: async (ctx, params) => { calls.push(params); return { ok: true } } })
  t.is(await run(['remove-group', C.toUpperCase(), G.toUpperCase()]), 'grupo tirado da lista da comunidade\n')
  t.alike(JSON.parse(await run(['remove-group', C, G, '--json'])), { ok: true })
  t.is(await run(['remove-group', C, G, '--undo']), 'grupo devolvido à lista da comunidade\n')
  t.alike(calls.map((p) => [p.community, p.group, p.undo]), [[C, G, false], [C, G, false], [C, G, true]])
  await t.exception(run(['remove-group', C]), /informe a chave do grupo/)
  await t.exception(run(['remove-group', C, 'xyz']), /chave do grupo inválida/)
  t.is(calls.length, 3)
})
