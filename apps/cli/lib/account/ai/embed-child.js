'use strict'

// The embedder's child process: the ONLY process that loads
// @huggingface/transformers (and with it onnxruntime-node and sharp, native
// code). embedder.js forks this file with an EMPTY environment, no execArgv
// and stdout/stderr discarded, and talks to it over the IPC channel (JSON
// serialization). See embedder.js for the why (crash and secret isolation,
// not an OS sandbox) and for the deadlines the parent enforces.
//
// Protocol (every message a plain JSON object):
//   parent -> child  { type: 'init', modelDir, device, modelId, revision }
//   child  -> parent { type: 'ready' } | { type: 'error', code: 'sem-modelo' }
//   parent -> child  { id, text }
//   child  -> parent { id, embedding: number[DIM] | null, truncated } | { id, error: 'falha-ia' }
// Anything else is junk and ignored. The child never logs (its stdio is
// /dev/null anyway, belt and braces), never echoes the text, and exits as
// soon as the IPC channel disconnects (the parent closed, died or killed us).
//
// Required by embedder.js too (lazily, only for the in-process `_load` test
// seam): requiring this file loads nothing heavy and starts no listener; the
// protocol loop runs only when this file is the process's main module.
//
// The env configuration (local files only, no FS cache), the 128-wordpiece
// rule, the mask-aware mean pooling and the L2 normalisation are the model's
// recipe described in embedder.js's header; they live here because this is
// where the model runs.

const path = require('node:path')
const { MODEL_ID, MODEL_REVISION, DIM, MAX_TOKENS, DTYPE } = require('./embedder')

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

// The ONE place the process-global transformers.js env is set. Called right
// before every from_pretrained: the env object is shared by every importer.
function configureEnv (env, modelDir) {
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = modelDir
  env.cacheDir = modelDir
  env.useBrowserCache = false
  // No file-system cache either: transformers.js checks
  // path.join(cacheDir, <local path>) BEFORE the local model file, so a file
  // planted at that nested path would load instead of the bytes we hashed.
  env.useFSCache = false
}

// The real loader: tokenizer + feature-extraction model from modelDir.
// transformers.js is required here, lazily.
async function load ({ modelDir, device }) {
  const hf = require('@huggingface/transformers')
  const opts = { local_files_only: true }
  configureEnv(hf.env, modelDir)
  const tokenizer = await hf.AutoTokenizer.from_pretrained(MODEL_ID, opts)
  configureEnv(hf.env, modelDir)
  const model = await hf.AutoModel.from_pretrained(MODEL_ID, { ...opts, dtype: DTYPE, device })
  return { tokenizer, model }
}

// Attention-mask-aware mean pooling over [1, n, DIM] + L2 normalization.
// Returns null when the output is not usable (wrong shape, non-finite).
function poolAndNormalize (hidden, mask) {
  const dims = hidden && hidden.dims
  const data = hidden && hidden.data
  if (!Array.isArray(dims) || dims.length !== 3 || dims[0] !== 1 || dims[2] !== DIM) return null
  const n = dims[1]
  if (!data || data.length !== n * DIM || !mask || mask.length !== n) return null
  const sum = new Float64Array(DIM)
  let count = 0
  for (let t = 0; t < n; t++) {
    if (Number(mask[t]) === 0) continue
    count++
    const off = t * DIM
    for (let d = 0; d < DIM; d++) sum[d] += Number(data[off + d])
  }
  if (count === 0) return null
  let norm = 0
  for (let d = 0; d < DIM; d++) {
    sum[d] /= count
    norm += sum[d] * sum[d]
  }
  norm = Math.sqrt(norm)
  if (!Number.isFinite(norm) || norm === 0) return null
  const out = new Array(DIM)
  for (let d = 0; d < DIM; d++) {
    const v = sum[d] / norm
    if (!Number.isFinite(v)) return null
    out[d] = v
  }
  return out
}

// One text -> { embedding, truncated } with a loaded tokenizer/model. Throws
// { code: 'falha-ia' } (or the runtime's own error, which callers turn into
// that token) on anything unusable. Callers serialize the calls.
function createRunner ({ tokenizer, model }) {
  return async function run (text) {
    // Truncation off: encode() returns every id, special tokens included.
    const ids = tokenizer.encode(text)
    if (!ids || typeof ids.length !== 'number') throw fail('falha-ia')
    // A prefix vector would let a long text hide its abuse after the cut:
    // the caller hands an overflow to a human instead.
    if (ids.length > MAX_TOKENS) return { embedding: null, truncated: true }
    const inputs = await tokenizer(text, { truncation: false, padding: false })
    // When ONNX Runtime throws, transformers.js (sessionRun in its models.js)
    // calls console.error('Inputs given to model:', ...) with the input_ids
    // tensor, i.e. the token ids of the post text, before our catch can turn
    // the error into a token. Silence console.error for the forward pass
    // only; inferences are serialized, so nothing else of ours runs inside
    // this window, and finally always restores it. (In the child stderr is
    // /dev/null already; this keeps the in-process seam and any future stdio
    // change honest.)
    const consoleError = console.error
    let output
    console.error = () => {}
    try {
      output = await model(inputs)
    } finally {
      console.error = consoleError
    }
    const hidden = output && (output.last_hidden_state || output.token_embeddings)
    const mask = inputs && inputs.attention_mask && inputs.attention_mask.data
    const embedding = poolAndNormalize(hidden, mask ? Array.from(mask) : null)
    if (!embedding) throw fail('falha-ia')
    return { embedding, truncated: false }
  }
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function validInit (msg) {
  return isPlainObject(msg) &&
    msg.type === 'init' &&
    typeof msg.modelDir === 'string' && msg.modelDir !== '' && path.isAbsolute(msg.modelDir) &&
    typeof msg.device === 'string' && msg.device !== '' &&
    msg.modelId === MODEL_ID &&
    msg.revision === MODEL_REVISION
}

function validRequest (msg) {
  return isPlainObject(msg) && Number.isSafeInteger(msg.id) && msg.id > 0 && typeof msg.text === 'string'
}

// Best-effort send: a closed channel means the parent is gone and the
// 'disconnect' handler is about to exit us.
function send (msg) {
  try {
    if (process.connected) process.send(msg)
  } catch {}
}

function main () {
  process.on('disconnect', () => process.exit(0))
  let state = 'waiting' // 'waiting' -> 'loading' -> 'ready' | 'failed'
  let run = null
  let chain = Promise.resolve()

  process.on('message', (msg) => {
    if (state === 'waiting') {
      if (!validInit(msg)) return
      state = 'loading'
      load({ modelDir: msg.modelDir, device: msg.device }).then((loaded) => {
        if (!loaded || !loaded.tokenizer || !loaded.model) throw fail('sem-modelo')
        run = createRunner(loaded)
        state = 'ready'
        send({ type: 'ready' })
      }).catch(() => {
        state = 'failed'
        send({ type: 'error', code: 'sem-modelo' })
        try { process.disconnect() } catch {}
      })
      return
    }
    if (state !== 'ready' || !validRequest(msg)) return
    const { id, text } = msg
    chain = chain.then(() => run(text)).then(
      ({ embedding, truncated }) => send({ id, embedding, truncated }),
      // Only a token travels: never the text, never the runtime's message.
      () => send({ id, error: 'falha-ia' })
    )
  })
}

if (require.main === module) main()

module.exports = { configureEnv, load, poolAndNormalize, createRunner }
