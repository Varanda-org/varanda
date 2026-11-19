import * as PushDevice from '../modules/push-device'
import * as SecureStore from 'expo-secure-store'
import { getRandomBytes } from 'expo-crypto'
import { pushDeviceInfo, pushDeviceStart, pushDeviceFinish, pushDeviceCheck } from './account'
import { deviceIntent, deviceKey, deviceRecord, deviceState, validKey, validToken, validTransport } from './pushDevice.js'

const service = { pushDeviceInfo, pushDeviceStart, pushDeviceFinish, pushDeviceCheck }
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
const storageKey = (member) => {
  if (typeof member !== 'string' || !/^[0-9a-f]{64}$/.test(member)) throw new Error('Membro inválido.')
  return 'varanda.push-device.' + member
}

// A separate pending record survives an unknown finish. It allows an explicit
// removal or rotation with the same key, but never an automatic retry.
const storage = {
  async loadKey () {
    return await SecureStore.getItemAsync('varanda.push-device.key', options)
  },
  async saveKey (key) {
    await SecureStore.setItemAsync('varanda.push-device.key', key, options)
  },
  async load (member) {
    const name = storageKey(member)
    const pending = await SecureStore.getItemAsync(name + '.pending', options)
    const text = pending ?? await SecureStore.getItemAsync(name, options)
    const value = text === null ? null : JSON.parse(text)
    let pendingAction = null
    if (pending !== null) {
      if (value?.action !== 'on' && value?.action !== 'off') throw new Error('Registro de avisos inválido.')
      pendingAction = value.action
      delete value.action
    }
    const record = value === null ? null : deviceRecord(value)
    if (text !== null && record === null) throw new Error('Registro de avisos inválido.')
    return { record, suspended: pending !== null, pendingAction }
  },
  async stage (member, record, action) {
    await SecureStore.setItemAsync(storageKey(member) + '.pending', JSON.stringify({ ...record, action }), options)
  },
  async save (member, record) {
    const name = storageKey(member)
    await SecureStore.setItemAsync(name, JSON.stringify(record), options)
    await SecureStore.deleteItemAsync(name + '.pending', options)
  },
  async clear (member) {
    const name = storageKey(member)
    await SecureStore.deleteItemAsync(name, options)
    await SecureStore.deleteItemAsync(name + '.pending', options)
  }
}

export function createPushClient ({ device = PushDevice, account = service, store = storage, random = getRandomBytes } = {}) {
  async function installationKey () {
    let key = await store.loadKey()
    if (!validKey(key)) {
      key = deviceKey(random)
      await store.saveKey(key)
    }
    return key
  }

  function pushSupportNow () {
    try { return device.isAvailable() && validTransport(device.transport()) ? 'ok' : 'not-hosted' } catch { return 'not-hosted' }
  }

  async function supportedTransport () {
    if (pushSupportNow() !== 'ok') return null
    const transport = device.transport()
    const info = await account.pushDeviceInfo()
    return info?.[transport] === true ? transport : null
  }

  async function getPushState (member, changedToken) {
    const transport = await supportedTransport()
    if (!transport) return { support: 'not-hosted' }
    const permission = await device.permission()
    const { record, suspended, pendingAction } = await store.load(member)
    const token = changedToken === undefined ? (permission === 'granted' ? await device.token() : null) : changedToken
    const currentToken = validToken(transport, token) ? token : null
    const check = record && !suspended ? await account.pushDeviceCheck({ member, ...record }) : null
    const registered = suspended ? pendingAction === 'off' : !record ? false : check?.registered ?? null
    const state = deviceState({ record, token: currentToken, registered, suspended })
    return {
      support: 'ok',
      permission: permission === 'undetermined' ? 'default' : permission,
      // The shared row uses this field only as the service availability gate.
      key: true,
      transport,
      token: currentToken,
      record,
      suspended,
      pendingAction,
      deviceState: state,
      subscribed: suspended ? pendingAction === 'off' : !!record,
      registered: state === 'needs-renewal' ? false : registered
    }
  }

  async function finish (node, member, action, record, active) {
    if (!active()) return { ok: false, reason: 'failed' }
    const { nonce } = await account.pushDeviceStart({ member, action, transport: record.transport })
    if (!active()) return { ok: false, reason: 'failed' }
    const { signature } = await node.request('pushDevice.sign', { nonce, action, ...record })
    if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return { ok: false, reason: 'failed' }
    if (!active()) return { ok: false, reason: 'failed' }
    await store.stage(member, record, action)
    try {
      await account.pushDeviceFinish({ member, nonce, action, ...record, signature })
      if (action === 'on') await store.save(member, record)
      else await store.clear(member)
      return { ok: true, unsubscribed: action === 'off' }
    } catch (err) {
      // Keep the pending proof inputs for a person's next tap, never retry.
      if (err?.code === 'pedido-invalido') return { ok: false, reason: 'failed' }
      return { ok: false, reason: 'uncertain', uncertain: true, unsubscribed: false }
    }
  }

  async function enablePush ({ node, member, token: changedToken, automatic = false, active = () => true } = {}) {
    try {
      const transport = await supportedTransport()
      if (!transport) return { ok: false, reason: 'unavailable' }
      let permission = await device.permission()
      if (permission === 'undetermined' && !automatic) permission = await device.request()
      if (permission !== 'granted') return { ok: false, reason: permission === 'denied' ? 'denied' : 'failed' }
      const token = changedToken === undefined ? await device.token() : changedToken
      if (!validToken(transport, token)) return { ok: false, reason: 'failed' }
      const { record, suspended } = await store.load(member)
      if (automatic && (!record || suspended)) return { ok: false, reason: 'failed' }
      const next = { transport, token, key: record ? record.key : await installationKey() }
      return await finish(node, member, 'on', next, active)
    } catch { return { ok: false, reason: 'failed' } }
  }

  async function disablePush ({ node, member, active = () => true } = {}) {
    try {
      const { record } = await store.load(member)
      if (!record) return { ok: true, unsubscribed: true }
      return await finish(node, member, 'off', record, active)
    } catch { return { ok: false, reason: 'failed', unsubscribed: false } }
  }

  let launch = null
  let capturing = null
  let intentReceived = false
  const listeners = new Set()
  let stopIntent = null
  const deliver = (kind) => {
    const intent = deviceIntent(kind)
    if (!intent) return
    if (!listeners.size) launch = intent
    else for (const fn of [...listeners]) { try { fn(intent) } catch {} }
  }
  function captureLaunch () {
    if (!stopIntent) {
      try {
        stopIntent = device.onIntent((kind) => {
          if (!deviceIntent(kind)) return
          intentReceived = true
          deliver(kind)
        })
      } catch {}
    }
    if (!capturing) {
      capturing = Promise.resolve().then(() => device.launchIntent()).then((kind) => {
        // A live event already carries the pending tap or a newer one.
        if (!intentReceived) deliver(kind)
      }).catch(() => {})
    }
    return null
  }
  function listenLaunch (fn) {
    captureLaunch()
    listeners.add(fn)
    if (launch) { const intent = launch; launch = null; fn(intent) }
    return () => {
      listeners.delete(fn)
      if (!listeners.size && stopIntent) {
        stopIntent()
        stopIntent = null
      }
    }
  }
  function onToken (fn) {
    try { return device.onToken((token) => { if (validToken(device.transport(), token)) fn(token) }) } catch { return () => {} }
  }
  return { pushSupportNow, getPushState, enablePush, disablePush, captureLaunch, listenLaunch, onToken }
}

const client = createPushClient()
export const { pushSupportNow, getPushState, enablePush, disablePush, captureLaunch, listenLaunch, onToken } = client
