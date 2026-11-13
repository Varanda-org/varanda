// Dev-only bench (EXPO_PUBLIC_VARANDA_HASH_BENCH=1): native digest
// (./hash.native, expo-crypto) against @noble/hashes on the same 30 buffers.
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { nativeSubtle } from './hash.native'

const N = 30
const MIN = 100 * 1024
const MAX = 400 * 1024

function buffers () {
  let x = 0x9e3779b9
  const out = []
  for (let i = 0; i < N; i++) {
    const size = Math.round(MIN + (MAX - MIN) * i / (N - 1))
    const b = new Uint8Array(size)
    for (let j = 0; j < size; j++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5
      b[j] = x & 0xff
    }
    out.push(b)
  }
  return out
}

const hex = (u8) => Array.from(u8, (v) => v.toString(16).padStart(2, '0')).join('')
const median = (a) => { const s = a.slice().sort((p, q) => p - q); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 }

export async function runHashBench () {
  if (!nativeSubtle) { console.log('hash-bench native unavailable'); return }
  const bufs = buffers()
  await nativeSubtle.digest('SHA-256', bufs[0])
  nobleSha256(bufs[0])
  const nat = []
  const js = []
  let mismatch = 0
  for (const b of bufs) {
    const t0 = performance.now()
    const a = hex(new Uint8Array(await nativeSubtle.digest('SHA-256', b)))
    const t1 = performance.now()
    const c = hex(nobleSha256(b))
    const t2 = performance.now()
    nat.push(t1 - t0)
    js.push(t2 - t1)
    if (a !== c) mismatch++
  }
  const f = (v) => v.toFixed(1)
  console.log('hash-bench native ' + f(median(nat)) + ' ms, js ' + f(median(js)) + ' ms, n=' + N + ', mismatches=' + mismatch)
  console.log('hash-bench per-buffer native ' + nat.map(f).join(','))
  console.log('hash-bench per-buffer js ' + js.map(f).join(','))
}
