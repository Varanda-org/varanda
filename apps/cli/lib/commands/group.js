'use strict'

const { jsonLine, safe } = require('@varanda/core/lib/safe')
const member = require('@varanda/core/lib/member')
const { validateParams, GROUP_MEMBERS_LIMIT_MAX, GROUP_LIMIT_MAX } = require('@varanda/rpc')

const USAGE_TEXT = 'node bin/varanda.js group create|join|leave|post|read|list|info|members|requests|admit|ban|admin|hide|meta|rekey'
const HEX64 = /^[0-9a-fA-F]{64}$/

function usage (message) {
  const err = new Error(message)
  err.code = 'USAGE'
  return err
}

function print (flags, result, line) {
  process.stdout.write((flags.json ? jsonLine(result) : line) + '\n')
}

function ctxOf (flags) {
  return { dataDir: flags.dataDir, association: flags.association || null }
}

// The group root key, second positional after the subcommand.
function groupKey (flags) {
  const value = flags.positionals[1]
  if (value === undefined) throw usage('informe a chave do grupo')
  if (!HEX64.test(value)) throw usage('chave do grupo inválida')
  return value.toLowerCase()
}

function joinOf (flags) {
  if (flags.join === null) return null
  if (flags.join === 'private') throw usage('para um grupo privado use --private')
  if (flags.join !== 'open' && flags.join !== 'approval') throw usage('join inválido: use open ou approval')
  return flags.join
}

// A mutating call is never resent; when its outcome is unknown the error says so.
async function mutate (fn) {
  try {
    return await fn()
  } catch (err) {
    if (err && err.uncertain === true) err.message = err.message + ' (resultado incerto: confira antes de repetir)'
    throw err
  }
}

// Peer-derived author label: profile name, else @username, else the first 8 hex.
function authorLabel (item) {
  if (item.name) return safe(item.name)
  if (item.username) return '@' + safe(item.username)
  return safe(item.diary.slice(0, 8))
}

// `--before <at>,<writer>,<seq>`, validated by group.read's own schema.
function readParams (group, flags) {
  const params = { group }
  if (flags.limit) params.limit = flags.limit
  if (flags.before !== null) {
    const parts = flags.before.split(',')
    if (parts.length !== 3 || !/^[1-9][0-9]*$/.test(parts[2])) throw usage('before inválido')
    params.before = { at: parts[0], writer: parts[1], seq: Number(parts[2]) }
  }
  const checked = validateParams('group.read', params)
  if (!checked.ok) throw usage(flags.before !== null ? 'before ou limit inválido' : 'limit inválido')
  return checked.value
}

function groupLine (g) {
  // A pending group: joined here, its root has not arrived by sync yet.
  if (g.role === 'pending') return g.group + ' (aguardando a sincronização)'
  return g.group + ' ' + safe(g.name) + ' (' + (g.join === 'open' ? 'aberto' : 'por aprovação') + ', ' + safe(String(g.role)) + ', ' + g.members + ' membros)'
}

async function createRun (flags) {
  if (flags.name === null) throw usage('informe --name <nome>')
  const join = joinOf(flags)
  if (flags.private) {
    // A private group always admits by approval (docs/rpc.md 5.36).
    if (join === 'open') throw usage('grupo privado é sempre por aprovação: tire --join open')
    const result = await mutate(() => member.groupCreate(ctxOf(flags), { name: flags.name, join: 'approval', visibility: 'private' }))
    print(flags, result, 'grupo privado criado: ' + result.group)
    return
  }
  if (join === null) throw usage('informe --join open|approval')
  const result = await mutate(() => member.groupCreate(ctxOf(flags), { name: flags.name, join }))
  print(flags, result, 'grupo criado: ' + result.group)
}

async function joinRun (flags) {
  const result = await mutate(() => member.groupJoin(ctxOf(flags), { group: groupKey(flags) }))
  const lines = {
    member: 'você entrou no grupo',
    requested: 'pedido enviado: aguarde um administrador',
    pending: 'entrada registrada: o grupo chega na próxima sincronização',
    left: 'você não está no grupo'
  }
  print(flags, result, lines[result.state] || 'ok')
}

async function leaveRun (flags) {
  const result = await mutate(() => member.groupLeave(ctxOf(flags), { group: groupKey(flags) }))
  print(flags, result, 'você saiu do grupo')
}

async function postRun (flags) {
  const group = groupKey(flags)
  if (flags.text === null) throw usage('informe --text <texto>')
  const result = await mutate(() => member.groupPost(ctxOf(flags), { group, text: flags.text }))
  print(flags, result, 'publicado #' + result.seq)
}

async function readRun (flags) {
  const result = await member.groupRead(ctxOf(flags), readParams(groupKey(flags), flags))
  if (flags.json) {
    process.stdout.write(jsonLine(result) + '\n')
    return
  }
  for (const item of result.items) {
    process.stdout.write(item.at + ' ' + authorLabel(item) + ': ' + (item.hidden ? '(mensagem oculta)' : safe(item.text)) + '\n')
  }
  if (result.next !== null) {
    process.stdout.write('mais antigas: --before ' + result.next.at + ',' + result.next.writer + ',' + result.next.seq + '\n')
  }
  if (result.incomplete) process.stderr.write('aviso: alguns escritores do grupo ainda não chegaram\n')
  const sealed = sealedLine(result)
  if (sealed !== null) process.stderr.write('aviso: ' + sealed + '\n')
}

// Private groups: what this device cannot open yet. Never names a key.
function sealedLine (result) {
  const parts = []
  if (result.sealed > 0) parts.push(result.sealed + (result.sealed === 1 ? ' mensagem cifrada' : ' mensagens cifradas') + ' sem chave neste aparelho')
  if (result.state === 'rekey-pending') parts.push('aguardando nova chave')
  if (result.state === 'locked') parts.push('chaves trancadas: desbloqueie para ler')
  return parts.length === 0 ? null : parts.join('; ')
}

async function listRun (flags) {
  const ctx = ctxOf(flags)
  const result = await allPages((page) => member.groupList(ctx, page), 'groups', GROUP_LIMIT_MAX)
  print(flags, result, result.groups.map(groupLine).join('\n'))
}

async function infoRun (flags) {
  const result = await member.groupInfo(ctxOf(flags), { group: groupKey(flags) })
  const creator = result.creator === null ? 'desconhecido até a sincronização' : result.creator
  const visibility = result.visibility === 'private' ? 'privado (cifrado)' : 'público'
  print(flags, result, groupLine(result) + '\nvisibilidade: ' + visibility + '\ncriador: ' + creator + '\nsua situação: ' + safe(String(result.state)))
}

function personLabel (p) {
  const label = p.name ? safe(p.name) : (p.username ? '@' + safe(p.username) : '')
  return p.member + (label ? ' ' + label : '')
}

// Every page, not only the first: a group holds up to 512 writers and a
// diary up to 64 groups, more than one page carries.
async function allPages (fetch, field, size = GROUP_MEMBERS_LIMIT_MAX) {
  const list = []
  let total = 0
  for (let offset = 0; ; offset += size) {
    const page = await fetch({ offset, limit: size })
    total = page.total
    list.push(...page[field])
    if (page[field].length < size || list.length >= total) break
  }
  return { [field]: list, total }
}

async function membersRun (flags) {
  const ctx = ctxOf(flags)
  const group = groupKey(flags)
  const result = await allPages((page) => member.groupMembers(ctx, { group, ...page }), 'members')
  print(flags, result, result.members.map((m) => personLabel(m) + (m.admin ? ' (admin)' : '') + (m.banned ? ' (banido)' : '')).join('\n'))
}

async function requestsRun (flags) {
  const ctx = ctxOf(flags)
  const group = groupKey(flags)
  const result = await allPages((page) => member.groupRequests(ctx, { group, ...page }), 'requests')
  print(flags, result, result.requests.map(personLabel).join('\n'))
}

function moderateRun (fn, done, undone) {
  return async (flags) => {
    const group = groupKey(flags)
    if (flags.member === null) throw usage('informe --member <chave>')
    const on = !flags.undo
    const result = await mutate(() => fn(ctxOf(flags), { group, member: flags.member, on }))
    print(flags, result, on ? done : undone)
  }
}

async function hideRun (flags) {
  const group = groupKey(flags)
  if (!flags.to) throw usage('informe --to <escritor>:<seq>')
  const on = !flags.undo
  const target = { writer: flags.to.author, seq: flags.to.seq }
  const result = await mutate(() => member.groupHide(ctxOf(flags), { group, target, on }))
  print(flags, result, on ? 'mensagem oculta' : 'mensagem exibida de novo')
}

async function metaRun (flags) {
  const group = groupKey(flags)
  const join = joinOf(flags)
  if (flags.name === null && join === null) throw usage('nada a alterar: informe --name ou --join')
  const params = { group }
  if (flags.name !== null) params.name = flags.name
  if (join !== null) params.join = join
  const result = await mutate(() => member.groupMeta(ctxOf(flags), params))
  print(flags, result, 'grupo atualizado')
}

async function rekeyRun (flags) {
  const result = await mutate(() => member.groupRekey(ctxOf(flags), { group: groupKey(flags) }))
  print(flags, result, 'nova chave do grupo gerada e entregue aos membros')
}

const subs = {
  create: createRun,
  join: joinRun,
  leave: leaveRun,
  post: postRun,
  read: readRun,
  list: listRun,
  info: infoRun,
  members: membersRun,
  requests: requestsRun,
  admit: moderateRun(member.groupAdmit, 'membro admitido', 'admissão retirada'),
  ban: moderateRun(member.groupBan, 'membro banido', 'banimento retirado'),
  admin: moderateRun(member.groupAdmin, 'administrador nomeado', 'administração retirada'),
  hide: hideRun,
  meta: metaRun,
  rekey: rekeyRun
}

async function groupRun (flags) {
  const sub = flags.positionals[0]
  if (!Object.hasOwn(subs, sub)) throw usage(USAGE_TEXT)
  await subs[sub](flags)
}

module.exports = {
  allPages,
  commands: {
    group: { summary: 'grupos públicos e privados', run: groupRun }
  }
}
