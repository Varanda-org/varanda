// Dev-only measurement spike: runs the account service's pinned MiniLM model
// (Xenova/paraphrase-multilingual-MiniLM-L12-v2, onnx/model_quantized.onnx,
// apps/cli/lib/account/ai/embedder.js) on the platform's native ONNX Runtime,
// to measure load time, inference time and memory on real phones. Product
// code never calls it, and nothing here ships a model: native reads only
// <app documents dir>/sentinel/model_quantized.onnx, which a developer puts
// there, and checks its sha256 before creating the session.
//
// isAvailable() never throws. load(expectedSha256Hex, threads) resolves
// { loadMs, fileBytes } (loadMs covers the streamed hash and the session
// creation); embed(inputIds, attentionMask) resolves { vector, inferMs }
// (384 floats: mask-aware mean pooling over last_hidden_state, then L2
// normalization, as apps/cli/lib/account/ai/embed-child.js does); memory()
// resolves { bytes } (iOS phys_footprint, Android total PSS); unload()
// resolves null. Rejections carry `.code`: INVALID, UNSUPPORTED, BUSY (one
// operation at a time), MISSING (no model file), PIN (sha256 mismatch),
// NOT_LOADED or FAILED. Native error text is never shown. A load that fails
// (PIN, MISSING or FAILED) has already dropped the previous session, so the
// next embed() rejects NOT_LOADED until a load succeeds.
//
// Debug builds only: a Release iOS build (#if DEBUG) and an Android host app
// that is not debuggable (its ApplicationInfo.FLAG_DEBUGGABLE) answer
// isAvailable() false and reject every call UNSUPPORTED.
//
// Native only reads the model file and never writes it. The developer who
// copies it to Documents/sentinel on iOS should exclude that directory from
// backup (isExcludedFromBackup), as AppDelegate.swift does for
// Documents/varanda, so 118 MB of weights never reach iCloud.
//
// Autolinked from apps/app/modules (expo-modules-autolinking's default
// nativeModulesDir).

import { requireNativeModule } from 'expo-modules-core'

let native = null
try {
  native = requireNativeModule('SentinelSpike')
} catch {}

export const DIM = 384
// The account service's MAX_TOKENS: it refuses a longer text instead of
// embedding a prefix.
export const MAX_TOKENS = 128
// Entries in the pinned tokenizer.json (Unigram vocabulary, <mask> is
// 250001). config.json says vocab_size 250037, the embedding rows; no id the
// tokenizer emits reaches the last 35, so the tighter bound is used.
export const VOCAB_SIZE = 250002
export const MAX_THREADS = 4

const NATIVE_CODES = new Set(['INVALID', 'UNSUPPORTED', 'BUSY', 'MISSING', 'PIN', 'NOT_LOADED'])
const MESSAGES = {
  INVALID: 'argumentos inválidos',
  UNSUPPORTED: 'este aparelho não roda o modelo aqui',
  BUSY: 'outra operação do modelo está em andamento',
  MISSING: 'o arquivo do modelo não está no aparelho',
  PIN: 'o arquivo do modelo não confere com o hash esperado',
  NOT_LOADED: 'o modelo não está carregado',
  FAILED: 'não foi possível rodar o modelo'
}

function fail (code) {
  const err = new Error(MESSAGES[code])
  err.code = code
  return err
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const nonNegative = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0
const positiveInt = (n) => Number.isSafeInteger(n) && n > 0

// One tokenized text as the tokenizer gives it (special tokens included, no
// padding needed): same non-empty length up to MAX_TOKENS, ids whole and
// inside the vocabulary, mask 0/1 with at least one 1 (the pooling divides by
// the count of 1s).
export function validArgs (ids, mask) {
  if (!Array.isArray(ids) || !Array.isArray(mask)) return false
  if (ids.length === 0 || ids.length > MAX_TOKENS || ids.length !== mask.length) return false
  if (!ids.every((id) => Number.isSafeInteger(id) && id >= 0 && id < VOCAB_SIZE)) return false
  if (!mask.every((m) => m === 0 || m === 1)) return false
  return mask.includes(1)
}

// -> { vector, inferMs } with a fresh array of DIM finite numbers of unit
// length, or null when the native answer is malformed.
export function normalize (result) {
  if (result === null || typeof result !== 'object') return null
  const { vector, inferMs } = result
  if (!Array.isArray(vector) || vector.length !== DIM || !nonNegative(inferMs)) return null
  let norm = 0
  for (const v of vector) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    norm += v * v
  }
  if (Math.abs(Math.sqrt(norm) - 1) > 1e-3) return null
  return { vector: vector.slice(), inferMs }
}

export function isAvailable () {
  if (native === null) return false
  try {
    return native.isAvailable() === true
  } catch {
    return false
  }
}

async function call (name, args) {
  if (!isAvailable()) throw fail('UNSUPPORTED')
  try {
    return await native[name](...args)
  } catch (err) {
    throw fail(err && NATIVE_CODES.has(err.code) ? err.code : 'FAILED')
  }
}

export async function load (expectedSha256Hex, threads = 1) {
  if (typeof expectedSha256Hex !== 'string' || !SHA256_HEX.test(expectedSha256Hex)) throw fail('INVALID')
  if (!Number.isSafeInteger(threads)) throw fail('INVALID')
  const clamped = Math.min(MAX_THREADS, Math.max(1, threads))
  const answer = await call('load', [expectedSha256Hex, clamped])
  if (answer === null || typeof answer !== 'object' || !nonNegative(answer.loadMs) || !positiveInt(answer.fileBytes)) {
    throw fail('FAILED')
  }
  return { loadMs: answer.loadMs, fileBytes: answer.fileBytes }
}

export async function embed (inputIds, attentionMask) {
  if (!validArgs(inputIds, attentionMask)) throw fail('INVALID')
  const result = normalize(await call('embed', [inputIds.slice(), attentionMask.slice()]))
  if (result === null) throw fail('FAILED')
  return result
}

export async function memory () {
  const answer = await call('memory', [])
  if (answer === null || typeof answer !== 'object' || !positiveInt(answer.bytes)) throw fail('FAILED')
  return { bytes: answer.bytes }
}

export async function unload () {
  await call('unload', [])
  return null
}
