'use strict'

const { jsonLine, safe } = require('@varanda/core/lib/safe')
const member = require('@varanda/core/lib/member')

const USAGE_TEXT = 'node bin/varanda.js community create|link|admin|info'
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

function positionalKey (flags, index, missing, invalid) {
  const value = flags.positionals[index]
  if (value === undefined) throw usage(missing)
  if (!HEX64.test(value)) throw usage(invalid)
  return value.toLowerCase()
}

function communityKey (flags) {
  return positionalKey(flags, 1, 'informe a chave da comunidade', 'chave da comunidade inválida')
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
  const result = await mutate(() => member.communityCreate(ctxOf(flags), { name: flags.name }))
  print(flags, result, 'comunidade criada: ' + result.community)
}

async function linkRun (flags) {
  const community = communityKey(flags)
  const group = positionalKey(flags, 2, 'informe a chave do grupo', 'chave do grupo inválida')
  const on = !flags.undo
  const result = await mutate(() => member.communityLink(ctxOf(flags), { community, group, on }))
  const sides = result.sides.map((s) => s === 'community' ? 'comunidade' : 'grupo').join(' e ')
  // A link counts only when both sides are on; one side alone waits for the other owner.
  const line = on
    ? 'vínculo gravado (lado: ' + sides + ')' + (result.sides.length < 2 ? ': vale quando o dono do outro lado também vincular' : '')
    : 'vínculo desfeito (lado: ' + sides + ')'
  print(flags, result, line)
}

async function adminRun (flags) {
  const community = communityKey(flags)
  if (flags.member === null) throw usage('informe --member <chave>')
  const on = !flags.undo
  const result = await mutate(() => member.communityAdmin(ctxOf(flags), { community, member: flags.member, on }))
  print(flags, result, on ? 'administrador da comunidade nomeado' : 'administração da comunidade retirada')
}

async function infoRun (flags) {
  const result = await member.communityInfo(ctxOf(flags), { community: communityKey(flags) })
  if (result.state === 'pending') {
    print(flags, result, result.community + ' (aguardando a sincronização)')
    return
  }
  const lines = [
    result.community + ' ' + safe(result.name) + ' (' + result.groups.length + ' grupos, ' + result.admins + ' administradores)',
    'criador: ' + result.creator
  ]
  for (const g of result.groups) lines.push('grupo: ' + g.group + (g.name === null ? '' : ' ' + safe(g.name)))
  if (result.incomplete) lines.push('aviso: alguns grupos da comunidade ainda não chegaram')
  print(flags, result, lines.join('\n'))
}

const subs = {
  create: createRun,
  link: linkRun,
  admin: adminRun,
  info: infoRun
}

async function communityRun (flags) {
  const sub = flags.positionals[0]
  if (!Object.hasOwn(subs, sub)) throw usage(USAGE_TEXT)
  await subs[sub](flags)
}

module.exports = {
  commands: {
    community: { summary: 'comunidades de grupos públicos', run: communityRun }
  }
}
