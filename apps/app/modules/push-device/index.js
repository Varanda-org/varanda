let native = null
let platform = null
try {
  // Loading inside the guard also lets Node import without React Native.
  const { requireNativeModule } = require('expo-modules-core')
  // APNs and FCM use different platform APIs and token formats.
  platform = require('react-native').Platform.OS
  native = requireNativeModule('PushDevice') ?? null
} catch {}

const KINDS = new Set(['dm', 'dm-page', 'group', 'group-private', 'social', 'invite-drop'])

export function isAvailable () {
  return native !== null
}

export function transport () {
  if (!isAvailable()) return null
  if (platform === 'ios') return 'apns'
  try {
    if (platform === 'android' && native.configured() === true) return 'fcm'
  } catch {}
  return null
}

function validToken (value) {
  if (typeof value !== 'string') return null
  const type = transport()
  if (type === 'apns' && value.length >= 64 && value.length <= 200 && !/[^0-9a-f]/.test(value)) return value
  if (type === 'fcm' && value.length >= 1 && value.length <= 4096 && !/[^A-Za-z0-9_:-]/.test(value)) return value
  return null
}

function validKind (value) {
  return KINDS.has(value) ? value : null
}

async function readPermission (method) {
  try {
    if (native !== null) {
      const value = await native[method]()
      if (value === 'granted' || value === 'denied') return value
    }
  } catch {}
  return 'undetermined'
}

export function permission () {
  return readPermission('permission')
}

export function request () {
  return readPermission('request')
}

export async function token () {
  if (transport() === null) return null
  try {
    return validToken(await native.token())
  } catch {
    return null
  }
}

export async function launchIntent () {
  try {
    return native === null ? null : validKind(await native.launchIntent())
  } catch {
    return null
  }
}

function listen (event, key, validate, listener) {
  let sub = null
  if (native !== null && typeof listener === 'function') {
    try {
      sub = native.addListener(event, (payload) => {
        const value = validate(payload?.[key])
        if (value !== null) listener(value)
      })
    } catch {}
  }
  return function () {
    const current = sub
    sub = null
    try {
      current?.remove()
    } catch {}
  }
}

export function onToken (listener) {
  return listen('onToken', 'token', validToken, listener)
}

export function onIntent (listener) {
  return listen('onIntent', 'kind', validKind, listener)
}

export async function clearDelivered (tags) {
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 64 ||
    ![...tags].every(tag => typeof tag === 'string' && tag.length === 16 && !/[^A-Za-z0-9_-]/.test(tag))) return
  try {
    await native?.clearDelivered(tags)
  } catch {}
}

export function onSync (listener) {
  return listen('onSync', null, () => true, typeof listener === 'function' ? () => listener() : null)
}
