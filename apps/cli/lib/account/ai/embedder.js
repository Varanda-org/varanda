'use strict'

// The local sentence embedder of the AI report triage: one multilingual
// MiniLM (Xenova/paraphrase-multilingual-MiniLM-L12-v2, the ONNX export of
// sentence-transformers paraphrase-multilingual-MiniLM-L12-v2: ~118M params,
// 384 dimensions, Portuguese included, 128 wordpieces) run through @huggingface/transformers
// (transformers.js) in a child process (see Process isolation), fully
// offline. A text becomes
// one L2-normalized 384-d vector (attention-mask-aware mean pooling, the
// model's own sentence-transformers recipe), and triage.js compares vectors
// by cosine (a dot product, since they are normalized).
//
// Offline, always. The weights are NEVER fetched by this module: the operator
// runs scripts/fetch-ai-model.js once, which downloads the five files below
// from ONE recorded immutable Hugging Face commit (MODEL_REVISION) into a
// directory outside the repository and checks every sha256 in FILES. At
// create time this module re-checks every file against FILES (the ONNX file's
// hash is PIN) and refuses a missing directory, a missing file or any hash
// mismatch with { code: 'sem-modelo' } before any child is spawned
// (so before transformers.js is required anywhere), so a missing model can
// never turn into a network call. In the child the transformers.js env is
// then pinned to local files only (configureEnv:
// allowRemoteModels = false, allowLocalModels = true, localModelPath and
// cacheDir = modelDir). That env is PROCESS-GLOBAL (one object shared by every
// importer of the package), so configureEnv runs again right before each
// from_pretrained call instead of once at require time: another embedder (or
// any other code) may have changed it in between.
//
// Process isolation. transformers.js loads onnxruntime-node and sharp (native
// code; sharp is required at module load), and the account service holds the
// member-certificate issuer key and the Google client secret. So the model
// NEVER runs in this process: createEmbedder forks ./embed-child.js with
// child_process.fork and an EMPTY environment (no VARANDA_*, no Google
// secret, no HOME), no inherited execArgv, stdout and stderr discarded (so
// nothing the child or its native libraries print, e.g. transformers.js'
// "Inputs given to model" token dump, ever reaches the service log) and a
// JSON IPC channel. The init message carries { modelDir, device, modelId,
// revision }; the protocol is in embed-child.js. This is crash and secret
// isolation (the issuer key and the secrets never enter the process that
// loads native ML code, and a native crash kills only the child), NOT an OS
// sandbox: same uid, same file-system view, and the child still reads the
// model files. Every check that needs no model stays here: the model
// directory, the five files and their sha256 pins are verified BEFORE any
// child is spawned.
//
// Deadlines and recovery (all enforced by this parent): the child has
// INIT_MS to answer 'ready' (else it is killed and createEmbedder rejects
// 'sem-modelo'); each request has REQUEST_MS (else the child is killed and the
// request rejects 'falha-ia'). A killed or crashed child fails its in-flight
// request with 'falha-ia' and is respawned lazily by the next embed, which
// re-runs the init handshake; at most one spawn per BACKOFF_MS, and while
// backing off embed rejects 'falha-ia' at once. Child messages are trusted
// only in shape: anything that is not a plain object of the expected form,
// carries another id than the in-flight request, or (for an answer) is not
// exactly DIM finite numbers is ignored or fails that request.
//
// Lazy: requiring this file loads nothing heavy, and neither does a full
// create/embed/close cycle: @huggingface/transformers is required only in the
// child, so `npm test`, `npm run demo` and every process that never enables
// the AI pay nothing, and the service process never maps the native code.
//
// Device. The default is 'cpu': transformers.js in Node runs onnxruntime-node
// (1.21.0 here), whose native CPU binary ships INSIDE the npm tarball
// (bin/napi-v3/<platform>/<arch>). Its install script only downloads the
// optional CUDA artifacts on linux x64 (skipped in CI and in build-web.sh with
// ONNXRUNTIME_NODE_INSTALL_CUDA=skip), so the CPU backend loads without it.
// Checked while implementing: `require('onnxruntime-node')` loads on
// darwin-arm64 with no install script run, and deploy/seeder/Dockerfile
// installs with `npm ci --omit=dev --workspace apps/cli --ignore-scripts`
// (linux x64 image; that check is repeated in the orchestrator's final
// verification). `device` stays an operator override, handed to
// transformers.js as is (it accepts what onnxruntime-node offers on the host:
// 'cpu' everywhere, 'cuda' on linux x64, 'dml' on Windows; anything else
// fails the load, which is 'sem-modelo'). 'wasm' is NOT a fallback in Node:
// transformers.js 3.8.1 binds onnxruntime-node whenever it runs in Node, and
// its Symbol.for('onnxruntime') hook for a custom runtime (tried with
// onnxruntime-web) leaves its device list empty, so every load throws
// 'Unsupported device'. A host where the native binary does not load has no
// local AI triage; reports then go to humans as before.
//
// Overflow. The text is tokenized with truncation OFF; if it needs more than
// MAX_TOKENS wordpieces (special tokens included) embed returns
// { embedding: null, truncated: true }: a prefix vector would let a long text
// hide its abuse after the cut, so the caller hands it to a human instead.
// No case folding, accent stripping or NFC folding here: the tokenizer's own
// normalizer is the model's training recipe.
//
// One inference at a time (an internal promise chain, and one in-flight IPC
// request): onnxruntime sessions are not meant to be hammered concurrently
// and the account service is small.
// Text is never logged, never put in an error; errors carry only a token in
// `err.code`.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { fork } = require('node:child_process')

const MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
// The Hugging Face commit the five files are fetched from (immutable URL
// https://huggingface.co/<MODEL_ID>/resolve/<MODEL_REVISION>/<file>).
const MODEL_REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900'
const DIM = 384
const MAX_TOKENS = 128
// sha256 of every file of that commit the embedder uses (dtype 'q8' means
// onnx/model_quantized.onnx). Shared with scripts/fetch-ai-model.js.
const FILES = Object.freeze({
  'config.json': '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7',
  'tokenizer.json': 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441',
  'tokenizer_config.json': '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2',
  'special_tokens_map.json': '06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f',
  'onnx/model_quantized.onnx': '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc'
})
const PIN = FILES['onnx/model_quantized.onnx']
const DTYPE = 'q8'

// The child entry point and the parent's deadlines (see the header).
const CHILD_PATH = path.join(__dirname, 'embed-child.js')
const INIT_MS = 60 * 1000
const REQUEST_MS = 10 * 1000
const BACKOFF_MS = 5 * 1000
const KILL_MS = 2 * 1000
const CLOSE_MS = 3 * 1000

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

// sha256 of a file, streamed (the ONNX file is ~118 MB).
function hashFile (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

// Every file must be a regular file whose sha256 matches; anything else is
// 'sem-modelo'. Runs before transformers.js is required.
async function checkFiles (modelDir, files) {
  const base = path.join(modelDir, ...MODEL_ID.split('/'))
  for (const [rel, want] of Object.entries(files)) {
    const file = path.join(base, ...rel.split('/'))
    let st
    try {
      st = fs.statSync(file)
    } catch {
      throw fail('sem-modelo')
    }
    if (!st.isFile()) throw fail('sem-modelo')
    let got
    try {
      got = await hashFile(file)
    } catch {
      throw fail('sem-modelo')
    }
    if (got !== want) throw fail('sem-modelo')
  }
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// A child answer (already matched to the in-flight id) -> { embedding,
// truncated }, or null for an error answer or any other shape: exactly DIM
// finite numbers with truncated false, or a null embedding with truncated
// true. The array is copied so nothing of the IPC message is kept.
function answerOf (msg) {
  if (Object.prototype.hasOwnProperty.call(msg, 'error')) return null
  if (msg.truncated === true && msg.embedding === null) return { embedding: null, truncated: true }
  if (msg.truncated !== false || !Array.isArray(msg.embedding) || msg.embedding.length !== DIM) return null
  for (const v of msg.embedding) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
  }
  return { embedding: msg.embedding.slice(), truncated: false }
}

// The production embedder: the model runs in a forked child (see the header).
async function childEmbedder ({ dir, device, childPath, childInit, initMs, requestMs, backoffMs, killMs, closeMs, now }) {
  let child = null // the current ChildProcess, handshaking or ready
  let ready = false
  let lastSpawn = -Infinity
  let pending = null // the in-flight request: { id, resolve, reject, timer }
  let nextId = 0
  let closed = false
  let chain = Promise.resolve()

  function kill (proc) {
    try { proc.kill('SIGKILL') } catch {}
  }

  function settle (err, value) {
    const p = pending
    if (!p) return
    pending = null
    clearTimeout(p.timer)
    if (err) p.reject(err)
    else p.resolve(value)
  }

  // Forgets and kills a ready child that missed a deadline, exited or broke
  // its channel; its in-flight request fails. The next embed respawns.
  function drop (proc) {
    if (proc !== child) return
    child = null
    ready = false
    kill(proc)
    settle(fail('falha-ia'))
  }

  function onAnswer (proc, msg) {
    if (proc !== child || !pending) return
    if (!isPlainObject(msg) || msg.id !== pending.id) return
    const answer = answerOf(msg)
    if (answer) settle(null, answer)
    else settle(fail('falha-ia'))
  }

  // Forks the child and runs the init handshake. Resolves once it answered
  // 'ready'; rejects 'sem-modelo' on an error answer, an exit, a broken
  // channel or the init deadline, the child killed.
  function spawn () {
    lastSpawn = now()
    return new Promise((resolve, reject) => {
      let proc
      try {
        proc = fork(childPath, [], {
          env: {},
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'json'
        })
      } catch {
        reject(fail('sem-modelo'))
        return
      }
      child = proc
      ready = false
      let done = false
      const timer = setTimeout(() => finish(false), initMs)
      function finish (ok) {
        if (done) return
        done = true
        clearTimeout(timer)
        if (ok && child === proc && !closed) {
          ready = true
          resolve()
          return
        }
        if (child === proc) {
          child = null
          ready = false
        }
        kill(proc)
        reject(fail('sem-modelo'))
      }
      proc.on('message', (msg) => {
        if (done) return onAnswer(proc, msg)
        if (!isPlainObject(msg)) return
        if (msg.type === 'ready') finish(true)
        else if (msg.type === 'error') finish(false)
      })
      proc.on('exit', () => (done ? drop(proc) : finish(false)))
      proc.on('error', () => (done ? drop(proc) : finish(false)))
      // The test-only extras go first so they can never replace a real field.
      const init = { ...childInit, type: 'init', modelDir: dir, device, modelId: MODEL_ID, revision: MODEL_REVISION }
      try {
        proc.send(init)
      } catch {
        finish(false)
      }
    })
  }

  // A ready child, respawned lazily (at most one spawn per backoffMs).
  async function ensure () {
    if (child && ready) return
    if (now() - lastSpawn < backoffMs) throw fail('falha-ia')
    await spawn()
  }

  function request (text) {
    const proc = child
    return new Promise((resolve, reject) => {
      const id = ++nextId
      pending = { id, resolve, reject, timer: setTimeout(() => drop(proc), requestMs) }
      try {
        proc.send({ id, text })
      } catch {
        drop(proc)
      }
    })
  }

  try {
    await spawn()
  } catch {
    throw fail('sem-modelo')
  }

  function embed (text) {
    if (closed) return Promise.reject(fail('fechado'))
    if (typeof text !== 'string') return Promise.reject(fail('texto'))
    const job = chain.then(async () => {
      if (closed) throw fail('fechado')
      await ensure()
      return request(text)
    }).catch((err) => {
      // Only a token travels: never the text, never the runtime's message.
      throw fail(closed || (err && err.code === 'fechado') ? 'fechado' : 'falha-ia')
    })
    chain = job.catch(() => {})
    return job
  }

  // Disconnects the child (it exits on 'disconnect'), SIGKILLs it after
  // killMs if it has not exited, and resolves on its exit or after closeMs.
  async function close () {
    if (closed) return
    closed = true
    const proc = child
    child = null
    ready = false
    settle(fail('fechado'))
    if (!proc) return
    await new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      const killTimer = setTimeout(() => kill(proc), killMs)
      const capTimer = setTimeout(done, closeMs)
      function done () {
        clearTimeout(killTimer)
        clearTimeout(capTimer)
        resolve()
      }
      proc.once('exit', done)
      try { proc.disconnect() } catch {}
    })
  }

  return { modelId: MODEL_ID, device, embed, close }
}

// The in-process embedder behind the `_load` test seam: the same runner the
// child uses (embed-child.js createRunner), on injected tokenizer/model
// fakes. Production never takes this path.
async function inProcessEmbedder ({ dir, device, load }) {
  let loaded
  try {
    loaded = await load({ modelDir: dir, device })
  } catch {
    throw fail('sem-modelo')
  }
  const { tokenizer, model } = loaded || {}
  if (!tokenizer || !model) throw fail('sem-modelo')
  const run = require('./embed-child').createRunner({ tokenizer, model })

  let chain = Promise.resolve()
  let closed = false

  function embed (text) {
    if (closed) return Promise.reject(fail('fechado'))
    if (typeof text !== 'string') return Promise.reject(fail('texto'))
    const job = chain.then(() => run(text)).catch(() => {
      throw fail('falha-ia')
    })
    chain = job.catch(() => {})
    return job
  }

  async function close () {
    if (closed) return
    closed = true
    await chain
    try {
      if (model && typeof model.dispose === 'function') await model.dispose()
    } catch {}
  }

  return { modelId: MODEL_ID, device, embed, close }
}

// createEmbedder({ modelDir, device = 'cpu' }) -> { modelId, device, embed, close }.
// Every underscored option is a test seam only; production callers never
// pass them: `_files` (recorded hashes), `_load` (an in-process
// tokenizer/model factory instead of the child), `_childPath` (another child
// entry point), `_childInit` (extra init fields for a fake child), the
// deadlines `_initMs`, `_requestMs`, `_backoffMs`, `_killMs`, `_closeMs`, and
// the clock `_now` the respawn backoff reads.
async function createEmbedder ({
  modelDir,
  device = 'cpu',
  _files = FILES,
  _load = null,
  _childPath = CHILD_PATH,
  _childInit = null,
  _initMs = INIT_MS,
  _requestMs = REQUEST_MS,
  _backoffMs = BACKOFF_MS,
  _killMs = KILL_MS,
  _closeMs = CLOSE_MS,
  _now = Date.now
} = {}) {
  if (typeof device !== 'string' || device === '') throw fail('sem-modelo')
  if (typeof modelDir !== 'string' || modelDir === '') throw fail('sem-modelo')
  const dir = path.resolve(modelDir)
  let st
  try {
    st = fs.statSync(dir)
  } catch {
    throw fail('sem-modelo')
  }
  if (!st.isDirectory()) throw fail('sem-modelo')
  await checkFiles(dir, _files)

  if (_load) return inProcessEmbedder({ dir, device, load: _load })
  return childEmbedder({
    dir,
    device,
    childPath: _childPath,
    childInit: _childInit,
    initMs: _initMs,
    requestMs: _requestMs,
    backoffMs: _backoffMs,
    killMs: _killMs,
    closeMs: _closeMs,
    now: _now
  })
}

module.exports = { createEmbedder, MODEL_ID, MODEL_REVISION, DIM, MAX_TOKENS, PIN, FILES, DTYPE }
