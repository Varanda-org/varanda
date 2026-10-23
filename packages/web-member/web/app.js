/* global WebSocket, indexedDB, document, location, window */
// Spike page: a member held by the browser. The same lib/member.js and
// lib/seeder-link.js the Node tests run, with the diary in IndexedDB
// ('varanda-diary') and the identity key pair in IndexedDB only
// ('varanda-spike', store 'identity'). The secret key never reaches the URL,
// localStorage, the console or the DOM. Untrusted text is rendered with
// textContent only.
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { createMember } = require('../lib/member')
const { connectSeeder } = require('../lib/seeder-link')
const { DIARY_OPTIONS } = require('../lib/diary-options')
const { idbStorage, deleteDatabase } = require('../lib/idb-storage')

const IDENTITY_DB = 'varanda-spike'
const IDENTITY_STORE = 'identity'
const DIARY_DB = 'varanda-diary'
const HEX64 = /^[0-9a-f]{64}$/

let member = null
let link = null

function $ (id) {
  return document.getElementById(id)
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function log (text) {
  const line = document.createElement('div')
  line.textContent = new Date().toLocaleTimeString('pt-BR') + ' ' + text
  const area = $('log')
  area.appendChild(line)
  area.scrollTop = area.scrollHeight
}

function fail (err) {
  log('erro: ' + (err && err.message ? err.message : String(err)))
}

// --- identity store (IndexedDB only) ---

function openIdentityDb () {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reject(new Error('armazenamento do navegador (IndexedDB) indisponível'))
      return
    }
    const req = indexedDB.open(IDENTITY_DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) db.createObjectStore(IDENTITY_STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => reject(new Error('armazenamento do navegador (IndexedDB) falhou ao abrir a identidade'))
    req.onblocked = () => reject(new Error('armazenamento do navegador (IndexedDB) bloqueado por outra aba'))
  })
}

async function identity (mode, fn) {
  const db = await openIdentityDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, mode)
      let result
      const req = fn(tx.objectStore(IDENTITY_STORE))
      req.onsuccess = () => { result = req.result }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(new Error('armazenamento do navegador (IndexedDB) falhou na identidade'))
      tx.onabort = () => reject(new Error('armazenamento do navegador (IndexedDB) abortou a transação'))
    })
  } finally {
    db.close()
  }
}

async function loadKeyPair () {
  const stored = await identity('readonly', (s) => s.get('keyPair'))
  if (!stored) return null
  return {
    publicKey: b4a.from(new Uint8Array(stored.publicKey)),
    secretKey: b4a.from(new Uint8Array(stored.secretKey))
  }
}

function saveKeyPair (keyPair) {
  const copy = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return identity('readwrite', (s) => s.put({ publicKey: copy(keyPair.publicKey), secretKey: copy(keyPair.secretKey) }, 'keyPair'))
}

// The association is public; it is remembered so the diary can reopen on load.
function loadAssociation () {
  return identity('readonly', (s) => s.get('association'))
}

function saveAssociation (association) {
  return identity('readwrite', (s) => s.put(association, 'association'))
}

// --- actions ---

function associationField () {
  const value = $('association').value.trim().toLowerCase()
  if (!HEX64.test(value)) throw new Error('chave da associação inválida (64 caracteres hexadecimais)')
  return value
}

function showMember () {
  $('public-key').textContent = member ? member.key : '—'
  $('length').textContent = member ? String(member.core.length) : '—'
}

async function createKey () {
  const existing = await loadKeyPair()
  if (existing !== null) {
    log('já existe uma chave neste navegador; use "apagar tudo" para começar de novo')
    return
  }
  const keyPair = crypto.keyPair()
  await saveKeyPair(keyPair)
  log('chave criada: ' + hex(keyPair.publicKey))
}

async function openDiary () {
  const association = associationField()
  const keyPair = await loadKeyPair()
  if (keyPair === null) throw new Error('nenhuma chave: use "criar chave" primeiro')
  if (member !== null) {
    log('diário já aberto')
    return
  }
  member = await createMember({ storage: idbStorage(DIARY_DB), keyPair, association, ...DIARY_OPTIONS })
  member.core.on('append', showMember)
  await saveAssociation(association)
  showMember()
  log('diário aberto: ' + member.key + ' (' + member.core.length + ' blocos)')
}

async function saveCert () {
  if (member === null) throw new Error('abra o diário primeiro')
  let cert
  try {
    cert = JSON.parse($('cert').value)
  } catch {
    throw new Error('certificado não é JSON válido')
  }
  await member.setCert(cert)
  showMember()
  log('certificado gravado no bloco 0')
}

function onLinkEvent (e) {
  if (e.event === 'connected') log('conectado; chave Noise do semeador ' + e.peerKey)
  else if (e.event === 'peer') log(e.verified ? 'semeador verificado' : 'semeador NÃO verificado (papel ' + e.role + ')')
  else if (e.event === 'admitted') log('admitido (comprimento ' + e.length + ')')
  else if (e.event === 'have') log('have: o semeador tem ' + e.length + ' blocos')
  else if (e.event === 'rejected') log('rejeitado: ' + e.reason)
  else if (e.event === 'closed') log('conexão com o semeador encerrada')
}

function connect () {
  if (member === null) throw new Error('abra o diário primeiro')
  if (member.core.length < 1) throw new Error('grave o certificado antes de conectar')
  const association = associationField()
  const url = $('seeder-url').value.trim()
  if (!/^wss?:\/\//.test(url)) throw new Error('URL do semeador deve começar com ws:// ou wss://')
  const pin = $('seeder-key').value.trim().toLowerCase()
  if (pin !== '' && !HEX64.test(pin)) throw new Error('chave Noise do semeador inválida (64 caracteres hexadecimais)')
  if (link !== null) link.close()
  const socket = new WebSocket(url)
  link = connectSeeder({ member, socket, association, seederPublicKey: pin === '' ? null : pin, onEvent: onLinkEvent })
  log('conectando ao semeador…')
  link.admitted.catch(fail)
}

async function publish () {
  if (member === null) throw new Error('abra o diário primeiro')
  const index = await member.post($('text').value)
  showMember()
  log('publicado no bloco ' + index)
}

async function eraseAll () {
  if (link !== null) {
    link.close()
    link = null
  }
  if (member !== null) {
    const m = member
    member = null
    await m.close()
  }
  await deleteDatabase(DIARY_DB)
  await deleteDatabase(IDENTITY_DB)
  showMember()
  log('tudo apagado (chave e diário)')
}

function bind (id, action) {
  $(id).addEventListener('click', () => {
    Promise.resolve().then(action).catch(fail)
  })
}

async function start () {
  bind('create-key', createKey)
  bind('open-diary', openDiary)
  bind('save-cert', saveCert)
  bind('connect', connect)
  bind('publish', publish)
  bind('erase', eraseAll)
  if (location.protocol !== 'http:' && location.protocol !== 'https:') log('abra esta página pelo servidor do spike')
  const keyPair = await loadKeyPair()
  if (keyPair === null) {
    log('nenhuma chave neste navegador: use "criar chave"')
    return
  }
  log('chave encontrada: ' + hex(keyPair.publicKey))
  const association = await loadAssociation()
  if (typeof association === 'string' && HEX64.test(association)) {
    $('association').value = association
    await openDiary()
  } else {
    log('informe a associação e use "abrir diário"')
  }
}

// Hook for the separate relay entry (web/relay.js, spike G3), which runs the
// SAME member through a dht-relay. Exposes exactly
//   window.__varandaSpike = { getMember(), association(), log(text) }
// getMember() returns null or a frozen view of the opened member holding
// exactly what web/relay.js uses: key (the diary public key) and core, a
// facade with only length and replicate(stream). The Hypercore object itself
// is not handed out, but this is NOT a security boundary: replicate() accepts
// a caller's stream or muxer, through which a page script can reach the core
// and its key pair, and any same-origin script can read the unencrypted key
// from IndexedDB anyway (a known risk of this spike; the key-at-rest PR
// encrypts it and folds the relay entry into the page bundle, removing this
// hook).
// association() returns the validated association hex (throws when the
// field is invalid); log() writes one line to the page log (textContent).
function memberView (m) {
  const core = Object.freeze({
    get length () { return m.core.length },
    replicate: (stream) => m.core.replicate(stream)
  })
  return Object.freeze({ core, key: m.key })
}

window.__varandaSpike = Object.freeze({
  getMember: () => (member === null ? null : memberView(member)),
  association: () => associationField(),
  log
})

start().catch(fail)
