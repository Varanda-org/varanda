// Dev-only measurement spike: runs a pinned ONNX model on the platform's
// native ONNX Runtime, to measure load time, inference time and memory on
// real phones. Product code never calls it, and nothing here ships a model.
//
// Two models, picked by a key from a fixed native allowlist. JS never sends a
// path, and native builds none from JS input beyond that lookup:
// - 'embed': <app documents dir>/sentinel/model_quantized.onnx, the account
//   service's MiniLM embedder (Xenova/paraphrase-multilingual-MiniLM-L12-v2,
//   apps/cli/lib/account/ai/embedder.js);
// - 'nli': <app documents dir>/sentinel/nli_quantized.onnx, a zero-shot NLI
//   classifier (docs/sentinela.md, spike 2).
// A developer puts the file there, and native checks its sha256 before
// creating the session. One model is loaded at a time: a load replaces the
// previous session.
//
// isAvailable() never throws. load(model, expectedSha256Hex, threads)
// resolves { loadMs, fileBytes } (loadMs covers the streamed hash and the
// session creation). embed(inputIds, attentionMask) needs 'embed' loaded and
// resolves { vector, inferMs } (384 floats: mask-aware mean pooling over
// last_hidden_state, then L2 normalization, as
// apps/cli/lib/account/ai/embed-child.js does). classify(inputIds,
// attentionMask, tokenTypeIds?) needs 'nli' loaded and resolves
// { logits, inferMs }: the raw floats of the model's [1, k] logits output,
// 2 <= k <= 8, with no softmax. Without tokenTypeIds a model that takes
// token_type_ids gets zeros; a model that does not take them ignores them,
// as the transformers.js pipeline does. memory() resolves { bytes } (iOS
// phys_footprint, Android total PSS); unload() resolves null. Rejections
// carry `.code`: INVALID (an unknown model key too), UNSUPPORTED (a release
// build, or no app storage directory to hold the model), BUSY (one operation
// at a time), MISSING (no model file, or one that vanished before it was
// opened), PIN (sha256 mismatch), NOT_LOADED, WRONG_MODEL (embed on the NLI
// model, classify on the embedder) or FAILED. Native error text is never
// shown. A load that fails (PIN, MISSING or FAILED) has already dropped the
// previous session, so the next embed() or classify() rejects NOT_LOADED
// until a load succeeds.
//
// Debug builds only: a Release iOS build (#if DEBUG) and an Android host app
// that is not debuggable (its ApplicationInfo.FLAG_DEBUGGABLE) answer
// isAvailable() false and reject every call UNSUPPORTED.
//
// Native only reads the model files and never writes them. The developer who
// copies them to Documents/sentinel on iOS should exclude that directory from
// backup (isExcludedFromBackup), as AppDelegate.swift does for
// Documents/varanda, so the weights never reach iCloud.
//
// Autolinked from apps/app/modules (expo-modules-autolinking's default
// nativeModulesDir).

import { requireNativeModule } from 'expo-modules-core'

let native = null
try {
  native = requireNativeModule('SentinelSpike')
} catch {}

// The native allowlist's keys. Native maps each to its fixed file name.
export const MODELS = Object.freeze(['embed', 'nli'])

export const DIM = 384
// The account service's MAX_TOKENS: it refuses a longer text instead of
// embedding a prefix.
export const MAX_TOKENS = 128
// Entries in the pinned tokenizer.json (Unigram vocabulary, <mask> is
// 250001). config.json says vocab_size 250037, the embedding rows; no id the
// tokenizer emits reaches the last 35, so the tighter bound is used.
export const VOCAB_SIZE = 250002
// One pair-encoded (premise, hypothesis) input for classify.
export const MAX_NLI_TOKENS = 256
// The vocabulary of the only NLI model that runs on the device,
// MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli (xlm-roberta tokenizer,
// 250002 entries). mDeBERTa-v3-base (251000) runs only in Node, so its larger
// table is not a reason to accept ids this model does not have: an id at or
// past 250002 is INVALID before native.
export const NLI_VOCAB_SIZE = 250002
export const MIN_LABELS = 2
export const MAX_LABELS = 8
export const MAX_THREADS = 4

const NATIVE_CODES = new Set(['INVALID', 'UNSUPPORTED', 'BUSY', 'MISSING', 'PIN', 'NOT_LOADED', 'WRONG_MODEL'])
const MESSAGES = {
  INVALID: 'argumentos inválidos',
  UNSUPPORTED: 'este aparelho não roda o modelo aqui',
  BUSY: 'outra operação do modelo está em andamento',
  MISSING: 'o arquivo do modelo não está no aparelho',
  PIN: 'o arquivo do modelo não confere com o hash esperado',
  NOT_LOADED: 'o modelo não está carregado',
  WRONG_MODEL: 'o modelo carregado não faz esta operação',
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
const bit = (m) => m === 0 || m === 1

// One tokenized input as the tokenizer gives it (special tokens included, no
// padding needed): same non-empty length up to maxTokens, ids whole and
// inside the vocabulary, mask 0/1 with at least one 1 (embed's pooling
// divides by the count of 1s, and an all-padding pair means nothing either).
function validTokens (ids, mask, maxTokens, vocabSize) {
  if (!Array.isArray(ids) || !Array.isArray(mask)) return false
  if (ids.length === 0 || ids.length > maxTokens || ids.length !== mask.length) return false
  if (!ids.every((id) => Number.isSafeInteger(id) && id >= 0 && id < vocabSize)) return false
  if (!mask.every(bit)) return false
  return mask.includes(1)
}

export function validArgs (ids, mask) {
  return validTokens(ids, mask, MAX_TOKENS, VOCAB_SIZE)
}

// classify's input: one pair up to MAX_NLI_TOKENS, and token type ids that
// are absent (undefined or null) or one 0/1 per token.
export function validPairArgs (ids, mask, typeIds) {
  if (!validTokens(ids, mask, MAX_NLI_TOKENS, NLI_VOCAB_SIZE)) return false
  if (typeIds === undefined || typeIds === null) return true
  return Array.isArray(typeIds) && typeIds.length === ids.length && typeIds.every(bit)
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

// -> { logits, inferMs } with a fresh array of MIN_LABELS..MAX_LABELS finite
// numbers, or null when the native answer is malformed.
export function normalizeLogits (result) {
  if (result === null || typeof result !== 'object') return null
  const { logits, inferMs } = result
  if (!Array.isArray(logits) || logits.length < MIN_LABELS || logits.length > MAX_LABELS || !nonNegative(inferMs)) return null
  if (!logits.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  return { logits: logits.slice(), inferMs }
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

export async function load (model, expectedSha256Hex, threads = 1) {
  if (typeof model !== 'string' || !MODELS.includes(model)) throw fail('INVALID')
  if (typeof expectedSha256Hex !== 'string' || !SHA256_HEX.test(expectedSha256Hex)) throw fail('INVALID')
  if (!Number.isSafeInteger(threads)) throw fail('INVALID')
  const clamped = Math.min(MAX_THREADS, Math.max(1, threads))
  const answer = await call('load', [model, expectedSha256Hex, clamped])
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

// Native always gets three arguments: null stands for absent token types.
export async function classify (inputIds, attentionMask, tokenTypeIds) {
  if (!validPairArgs(inputIds, attentionMask, tokenTypeIds)) throw fail('INVALID')
  const types = tokenTypeIds === undefined || tokenTypeIds === null ? null : tokenTypeIds.slice()
  const result = normalizeLogits(await call('classify', [inputIds.slice(), attentionMask.slice(), types]))
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
