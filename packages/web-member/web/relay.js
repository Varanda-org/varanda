/* global WebSocket, document, window */
// Spike (G3) page entry, bundled separately from web/app.js: the member the
// page already opened joins the association rendezvous on the Hyperswarm DHT
// through a @hyperswarm/dht-relay node over a browser WebSocket
// (lib/relay-link.js), NONCUSTODIAL: the secret key never goes to the relay
// (custodial is never passed). The relay session uses an EPHEMERAL key pair
// (one per 'entrar pela DHT'), never the diary's signing key pair: that key
// would otherwise do Noise DH with arbitrary peers and sign DHT announces the
// relay asks for. The diary key only signs blocks. Each connection replicates the diary and runs
// the admission protocol as role 'member', as spike/relay-eval.test.js does.
// The member comes from the hook web/app.js exposes:
//   window.__varandaSpike = { getMember(), association(), log(text) }
// getMember() returns { core, key } only (no key material).
// Untrusted text is rendered with textContent only (through the hook's log).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { topicFor, attachAdmission } = require('@varanda/core/lib/admission')
const { createRelayedSwarm } = require('../lib/relay-link')

let swarm = null

function $ (id) {
  return document.getElementById(id)
}

function short (key) {
  if (typeof key === 'string') return key.slice(0, 8)
  if (key && key.byteLength) return b4a.toString(key, 'hex').slice(0, 8)
  return '?'
}

function hook () {
  const h = window.__varandaSpike
  if (!h || typeof h.getMember !== 'function') throw new Error('página do membro não carregada (app.js)')
  return h
}

function log (text) {
  try {
    hook().log('[relay] ' + text)
  } catch {}
}

function fail (err) {
  log('erro: ' + (err && err.message ? err.message : String(err)))
}

// The hello carries the role and the advertised logs; the peer's key is the
// Noise public key of the connection.
function onMessage (conn, msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'hello') {
    const first = Array.isArray(msg.have) && msg.have.length > 0 ? ', primeiro log ' + short(msg.have[0].key) : ''
    log('hello do par ' + short(conn.remotePublicKey) + ': papel ' + String(msg.role) + ', ' + String(msg.count) + ' logs' + first)
  } else {
    log('mensagem de admissão: ' + String(msg.type))
  }
}

function onConnection (member, conn) {
  log('conexão direta com ' + short(conn.remotePublicKey))
  conn.on('error', (err) => fail(err))
  conn.once('close', () => log('conexão encerrada com ' + short(conn.remotePublicKey)))
  try {
    member.core.replicate(conn)
    attachAdmission(conn, {
      role: 'member',
      have: [{ key: member.key, length: member.core.length }],
      onmessage: (msg) => onMessage(conn, msg)
    })
  } catch (err) {
    fail(err)
  }
}

async function join () {
  const h = hook()
  const member = h.getMember()
  if (member === null) throw new Error('abra o diário primeiro')
  if (member.core.length < 1) throw new Error('grave o certificado antes de entrar na DHT')
  const association = h.association()
  const url = $('relay-url').value.trim()
  if (!/^wss?:\/\//.test(url)) throw new Error('URL do relay deve começar com ws:// ou wss://')
  if (swarm !== null) {
    log('já na DHT; use "sair da DHT" primeiro')
    return
  }
  const socket = new WebSocket(url)
  socket.addEventListener('error', () => log('erro no WebSocket do relay'))
  socket.addEventListener('close', () => log('WebSocket do relay fechado'))
  // Noncustodial (the default of createRelayedSwarm): custodial is never
  // passed. A fresh ephemeral key pair per session (see the header).
  const s = createRelayedSwarm({ socket, keyPair: crypto.keyPair() })
  swarm = s
  s.onConnection((conn) => onConnection(member, conn))
  log('conectando ao relay (' + s.custody + ')…')
  await s.dht.ready()
  if (swarm !== s) return
  await s.join(topicFor(association))
  log('anunciado no tópico da associação; procurando pares…')
}

async function leave () {
  if (swarm === null) {
    log('fora da DHT')
    return
  }
  const s = swarm
  swarm = null
  await s.destroy()
  log('saiu da DHT')
}

function bind (id, action) {
  $(id).addEventListener('click', () => {
    Promise.resolve().then(action).catch(fail)
  })
}

function start () {
  const panel = $('relay-panel')
  if (!panel) return
  bind('relay-join', join)
  bind('relay-leave', leave)
  panel.hidden = false
}

start()
