import { fetch } from 'expo/fetch'

// React Native's global fetch (whatwg-fetch) cannot send a Uint8Array body as
// raw bytes; expo/fetch can (media/fetch.js).
export function uploadDeps () {
  return { fetch, native: true }
}
