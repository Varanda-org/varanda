'use strict'

const { jsonLine, safe } = require('@varanda/core/lib/safe')
const member = require('@varanda/core/lib/member')
const { allPages, personLabel } = require('./group')

const USAGE_TEXT = 'node bin/varanda.js community create|join|leave|info|list|members|requests|admit|ban|admin|meta|remove-group'
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

function communityKey (flags) {
  const value = flags.positionals[1]
  if (value === undefined) throw usage('informe a chave da comunidade')
  if (!HEX64.test(value)) throw usage('chave da comunidade inválida')
  return value.toLowerCase()
}

function joinOf (flags) {
  if (flags.join === null) return null
  if (flags.join !== 'open' && flags.join !== 'approval') throw usage('join inválido: use open ou approval')
  return flags.join
}

function joinLabel (join) {
  return join === 'open' ? 'aberta' : 'por aprovação'
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

async function createRun (flags) {
  if (flags.name === null) throw usage('informe --name <nome>')
  const join = joinOf(flags)
  if (join === null) throw usage('informe --join open|approval')
  const result = await mutate(() => member.communityCreate(ctxOf(flags), { name: flags.name, join }))
  print(flags, result, 'comunidade criada: ' + safe(result.community) + '\ngrupo Geral: ' + safe(result.group))
}

async function joinRun (flags) {
  const result = await mutate(() => member.communityJoin(ctxOf(flags), { community: communityKey(flags) }))
  const lines = {
    member: 'você entrou na comunidade',
    requested: 'pedido enviado: aguarde um administrador',
    pending: 'entrada registrada: a comunidade chega na próxima sincronização',
    left: 'você não está na comunidade'
  }
  let line = lines[result.state] || 'ok'
  if (result.group !== null) line += '\nvocê entrou no Geral: ' + safe(result.group)
  print(flags, result, line)
}

async function leaveRun (flags) {
  const result = await mutate(() => member.communityLeave(ctxOf(flags), { community: communityKey(flags), force: flags.force === true }))
  print(flags, result, 'você saiu da comunidade')
}

function moderateRun (fn, done, undone) {
  return async (flags) => {
    const community = communityKey(flags)
    if (flags.member === null) throw usage('informe --member <chave>')
    const on = !flags.undo
    const result = await mutate(() => fn(ctxOf(flags), { community, member: flags.member, on }))
    print(flags, result, on ? done : undone)
  }
}

async function infoRun (flags) {
  const result = await member.communityInfo(ctxOf(flags), { community: communityKey(flags) })
  if (result.state === 'pending') {
    print(flags, result, safe(result.community) + ' (aguardando a sincronização)')
    return
  }
  const lines = [
    safe(result.community) + ' ' + safe(result.name) + ' (' + result.groups.length + ' grupos, ' + result.members + ' membros, ' + result.admins + ' administradores, ' + joinLabel(result.join) + ')',
    'criador: ' + safe(result.creator),
    'sua situação: ' + safe(result.role)
  ]
  for (const g of result.groups) {
    const label = g.general ? 'Geral' : (g.visibility === null ? 'aguardando a sincronização' : (g.visibility === 'private' ? 'privado' : 'público'))
    lines.push('grupo: ' + safe(g.group) + (g.name === null ? '' : ' ' + safe(g.name)) + ' (' + label + ')')
  }
  if (result.incomplete) lines.push('aviso: alguns grupos da comunidade ainda não chegaram')
  print(flags, result, lines.join('\n'))
}

async function listRun (flags) {
  const result = await member.communityList(ctxOf(flags))
  print(flags, result, result.communities.map((c) => safe(c.community) + (c.state === 'pending'
    ? ' (aguardando a sincronização)'
    : ' ' + safe(c.name) + ' (' + joinLabel(c.join) + ', ' + safe(c.role) + ')')).join('\n'))
}

async function membersRun (flags) {
  const ctx = ctxOf(flags)
  const community = communityKey(flags)
  const result = await allPages((page) => member.communityMembers(ctx, { community, ...page }), 'members')
  print(flags, result, result.members.map((m) => personLabel(m) + (m.admin ? ' (admin)' : '') + (m.banned ? ' (banido)' : '')).join('\n'))
}

async function requestsRun (flags) {
  const ctx = ctxOf(flags)
  const community = communityKey(flags)
  const result = await allPages((page) => member.communityRequests(ctx, { community, ...page }), 'requests')
  print(flags, result, result.requests.map(personLabel).join('\n'))
}

async function metaRun (flags) {
  const community = communityKey(flags)
  const join = joinOf(flags)
  if (flags.name === null && join === null) throw usage('nada a alterar: informe --name ou --join')
  const params = { community }
  if (flags.name !== null) params.name = flags.name
  if (join !== null) params.join = join
  const result = await mutate(() => member.communityMeta(ctxOf(flags), params))
  print(flags, result, 'comunidade atualizada')
}

async function removeGroupRun (flags) {
  const community = communityKey(flags)
  const group = flags.positionals[2]
  if (group === undefined) throw usage('informe a chave do grupo')
  if (!HEX64.test(group)) throw usage('chave do grupo inválida')
  const undo = flags.undo === true
  const result = await mutate(() => member.communityRemoveGroup(ctxOf(flags), { community, group: group.toLowerCase(), undo }))
  print(flags, result, undo ? 'grupo devolvido à lista da comunidade' : 'grupo tirado da lista da comunidade')
}

const subs = {
  create: createRun,
  join: joinRun,
  leave: leaveRun,
  info: infoRun,
  list: listRun,
  members: membersRun,
  requests: requestsRun,
  admit: moderateRun(member.communityAdmit, 'membro admitido', 'admissão retirada'),
  ban: moderateRun(member.communityBan, 'membro banido', 'banimento retirado'),
  admin: moderateRun(member.communitySetAdmin, 'administrador da comunidade nomeado', 'administração da comunidade retirada'),
  meta: metaRun,
  'remove-group': removeGroupRun
}

async function communityRun (flags) {
  const sub = flags.positionals[0]
  if (!Object.hasOwn(subs, sub)) throw usage(USAGE_TEXT)
  await subs[sub](flags)
}

module.exports = {
  commands: {
    community: { summary: 'comunidades e seus grupos', run: communityRun }
  }
}
