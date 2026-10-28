'use strict'

// apps/cli/lib/account/ai/embedder.js: the offline multilingual MiniLM
// embedder. The pooling/overflow tests run the child's runner in-process on
// injected tokenizer/model fakes (the `_load` seam); the process tests fork
// helpers/fake-embed-child.js (the `_childPath` seam), a protocol-compatible
// child with no model. None of them loads transformers.js, onnxruntime or
// sharp, nor touches the network. The last one runs the real model through
// the real child only when VARANDA_AI_MODEL_DIR points at a directory
// produced by scripts/fetch-ai-model.js (never set in CI).

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('brittle')
const embedder = require('../lib/account/ai/embedder')
const { spawn } = require('node:child_process')
const { tmpDir, until } = require('./helpers/net')

const { createEmbedder, MODEL_ID, MODEL_REVISION, DIM, MAX_TOKENS, PIN, FILES } = embedder

const FAKE_CHILD = path.join(__dirname, 'helpers', 'fake-embed-child.js')

function heavyLoaded () {
  return Object.keys(require.cache).filter((id) => id.includes('@huggingface') || id.includes('onnxruntime') || id.includes('sharp'))
}

// One parsed line per fake-child start (see helpers/fake-embed-child.js).
function starts (report) {
  if (!fs.existsSync(report)) return []
  return fs.readFileSync(report, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function alive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function gone (pid) {
  return until(() => !alive(pid), { timeoutMs: 5000, name: 'filho encerrado' })
}

// A settable clock for the respawn backoff.
function clock () {
  let t = 1000000
  const now = () => t
  now.advance = (ms) => { t += ms }
  return now
}

// createEmbedder on the fake child, with short deadlines; `init` goes to the
// child's init message, every start is appended to the returned `report`.
async function fakeChild (t, init = {}, opts = {}) {
  const { dir, files } = fakeModelDir(t)
  const report = path.join(tmpDir(t, 'varanda-ai-rep-'), 'starts.jsonl')
  const now = opts._now || clock()
  const e = await createEmbedder({
    modelDir: dir,
    _files: files,
    _childPath: FAKE_CHILD,
    _childInit: { report, ...init },
    _initMs: 3000,
    _requestMs: 500,
    _backoffMs: 5000,
    _now: now,
    ...opts
  })
  t.teardown(() => e.close(), { force: true })
  return { e, report, now, dir, files }
}

// A model directory with junk bytes in every expected file; returns the dir
// and the matching hash map (the `_files` seam).
function fakeModelDir (t) {
  const dir = tmpDir(t, 'varanda-ai-')
  const files = {}
  for (const rel of Object.keys(FILES)) {
    const file = path.join(dir, ...MODEL_ID.split('/'), ...rel.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const bytes = Buffer.from('fake ' + rel)
    fs.writeFileSync(file, bytes)
    files[rel] = crypto.createHash('sha256').update(bytes).digest('hex')
  }
  return { dir, files }
}

// Fakes shaped like transformers.js: encode() -> ids (no truncation),
// tokenizer(text) -> { attention_mask: { data } }, model(inputs) ->
// { last_hidden_state: { dims, data } }. `rows` gives one DIM-vector per
// token; the token count is the text length (so 'x'.repeat(n) is n tokens).
function fakes ({ rows, mask } = {}) {
  const calls = { model: 0 }
  const tokenizer = (text) => {
    const n = text.length
    return Promise.resolve({ attention_mask: { data: BigInt64Array.from(mask || new Array(n).fill(1), BigInt) } })
  }
  tokenizer.encode = (text) => new Array(text.length).fill(7)
  const model = async (inputs) => {
    calls.model++
    const n = inputs.attention_mask.data.length
    const data = new Float32Array(n * DIM)
    for (let t = 0; t < n; t++) {
      const row = rows ? rows(t) : null
      for (let d = 0; d < DIM; d++) data[t * DIM + d] = row ? row[d] : (d === 0 ? 1 : 0)
    }
    return { last_hidden_state: { dims: [1, n, DIM], data } }
  }
  return { tokenizer, model, calls }
}

test('constants and the lazy require', (t) => {
  t.is(MODEL_ID, 'Xenova/paraphrase-multilingual-MiniLM-L12-v2')
  t.ok(/^[0-9a-f]{40}$/.test(MODEL_REVISION))
  t.is(DIM, 384)
  t.is(MAX_TOKENS, 128)
  t.ok(/^[0-9a-f]{64}$/.test(PIN))
  t.is(FILES['onnx/model_quantized.onnx'], PIN)
  t.alike(Object.keys(FILES).sort(), ['config.json', 'onnx/model_quantized.onnx', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json'])
  t.alike(heavyLoaded(), [], 'requiring the embedder loads no transformers.js / onnxruntime')
})

test('sem-modelo: missing dir, missing file, wrong hash, bad device', async (t) => {
  const neverLoad = () => { t.fail('loader must not run'); return {} }
  const root = tmpDir(t, 'varanda-ai-')
  await t.exception(createEmbedder({ modelDir: path.join(root, 'nada'), _load: neverLoad }), { code: 'sem-modelo' })
  await t.exception(createEmbedder({ _load: neverLoad }), { code: 'sem-modelo' })
  // Empty directory, real recorded hashes and the REAL loader: refused before
  // transformers.js is required, so no remote fetch can happen.
  await t.exception(createEmbedder({ modelDir: root }), { code: 'sem-modelo' })
  t.alike(heavyLoaded(), [])
  // Refused before any child is spawned: the fake child records every start.
  const report = path.join(root, 'starts.jsonl')
  const childOpts = { _childPath: FAKE_CHILD, _childInit: { report } }
  await t.exception(createEmbedder({ modelDir: root, ...childOpts }), { code: 'sem-modelo' })
  await t.exception(createEmbedder({ modelDir: path.join(root, 'nada'), ...childOpts }), { code: 'sem-modelo' })

  const { dir, files } = fakeModelDir(t)
  // The recorded hashes never match junk bytes.
  await t.exception(createEmbedder({ modelDir: dir, _load: neverLoad }), { code: 'sem-modelo' })
  const wrong = { ...files, 'onnx/model_quantized.onnx': '0'.repeat(64) }
  await t.exception(createEmbedder({ modelDir: dir, _files: wrong, _load: neverLoad }), { code: 'sem-modelo' })
  await t.exception(createEmbedder({ modelDir: dir, _files: wrong, ...childOpts }), { code: 'sem-modelo' })
  fs.rmSync(path.join(dir, ...MODEL_ID.split('/'), 'tokenizer.json'))
  await t.exception(createEmbedder({ modelDir: dir, _files: files, _load: neverLoad }), { code: 'sem-modelo' })
  await t.exception(createEmbedder({ modelDir: dir, _files: files, ...childOpts }), { code: 'sem-modelo' })
  await t.exception(createEmbedder({ modelDir: dir, device: '', _load: neverLoad }), { code: 'sem-modelo' })
  t.alike(starts(report), [], 'no child was ever spawned')
  t.alike(heavyLoaded(), [])
})

test('a loader failure is sem-modelo too', async (t) => {
  const { dir, files } = fakeModelDir(t)
  await t.exception(createEmbedder({ modelDir: dir, _files: files, _load: async () => { throw new Error('boom') } }), { code: 'sem-modelo' })
})

test('known vectors -> mask-aware mean, L2 normalized, 384 finite floats', async (t) => {
  const { dir, files } = fakeModelDir(t)
  // Token 0 = 3 on dim 0, token 1 = 4 on dim 1, token 2 (masked) = 100 on dim 2.
  const rows = (tok) => {
    const r = new Array(DIM).fill(0)
    r[tok] = [3, 4, 100][tok]
    return r
  }
  const f = fakes({ rows, mask: [1, 1, 0] })
  let seen = null
  const e = await createEmbedder({ modelDir: dir, _files: files, _load: async (opts) => { seen = opts; return f } })
  t.is(e.modelId, MODEL_ID)
  t.is(e.device, 'cpu')
  t.is(seen.device, 'cpu')
  t.is(seen.modelDir, path.resolve(dir))
  const { embedding, truncated } = await e.embed('abc')
  t.is(truncated, false)
  t.is(embedding.length, DIM)
  t.ok(embedding.every(Number.isFinite))
  t.ok(Math.abs(embedding[0] - 0.6) < 1e-9)
  t.ok(Math.abs(embedding[1] - 0.8) < 1e-9)
  t.is(embedding[2], 0, 'masked token ignored')
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0))
  t.ok(Math.abs(norm - 1) < 1e-9)
  await e.close()
  await t.exception(e.embed('abc'), { code: 'fechado' })
})

test('overflow -> truncated, null embedding, no forward pass', async (t) => {
  const { dir, files } = fakeModelDir(t)
  const f = fakes()
  const e = await createEmbedder({ modelDir: dir, _files: files, _load: async () => f })
  const at = await e.embed('x'.repeat(MAX_TOKENS))
  t.is(at.truncated, false)
  t.is(at.embedding.length, DIM)
  t.is(f.calls.model, 1)
  const over = await e.embed('x'.repeat(MAX_TOKENS + 1))
  t.alike(over, { embedding: null, truncated: true })
  t.is(f.calls.model, 1, 'never a prefix vector')
  await e.close()
})

test('bad input and bad output carry only a token; one inference at a time', async (t) => {
  const { dir, files } = fakeModelDir(t)
  const f = fakes()
  let active = 0
  let maxActive = 0
  const model = async (inputs) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return f.model(inputs)
  }
  const e = await createEmbedder({ modelDir: dir, _files: files, _load: async () => ({ tokenizer: f.tokenizer, model }) })
  await t.exception(e.embed(42), { code: 'texto' })
  const all = await Promise.all(['a', 'bb', 'ccc', 'dddd'].map((s) => e.embed(s)))
  t.is(maxActive, 1)
  t.ok(all.every((r) => r.embedding.length === DIM))
  await e.close()

  const nan = await createEmbedder({
    modelDir: dir,
    _files: files,
    _load: async () => ({ tokenizer: f.tokenizer, model: async () => ({ last_hidden_state: { dims: [1, 1, DIM], data: new Float32Array(DIM).fill(NaN) } }) })
  })
  const err = await nan.embed('segredo').catch((e) => e)
  t.is(err.code, 'falha-ia')
  t.absent(err.message.includes('segredo'))
  // The chain survives a failed job.
  await t.exception(nan.embed('a'), { code: 'falha-ia' })
  await nan.close()
  t.alike(heavyLoaded(), [])
})

test('a throwing forward pass leaks nothing to console.error', async (t) => {
  const { dir, files } = fakeModelDir(t)
  const f = fakes()
  const original = console.error
  const seen = []
  const spy = (...args) => { seen.push(args) }
  console.error = spy
  t.teardown(() => { console.error = original })
  // Like transformers.js' sessionRun: logs the inputs, then throws.
  const model = async () => {
    console.error('Inputs given to model:', 'SENTINEL-ids')
    throw new Error('ort failed SENTINEL')
  }
  const e = await createEmbedder({ modelDir: dir, _files: files, _load: async () => ({ tokenizer: f.tokenizer, model }) })
  const err = await e.embed('segredo').catch((x) => x)
  t.is(err.code, 'falha-ia')
  t.absent(err.message.includes('SENTINEL'))
  t.alike(seen, [], 'nothing reached console.error')
  t.is(console.error, spy, 'console.error restored')
  // Still restored after a successful forward pass.
  const ok = await createEmbedder({ modelDir: dir, _files: files, _load: async () => f })
  await ok.embed('abc')
  t.is(console.error, spy)
  await e.close()
  await ok.close()
})

test('child: empty environment, no execArgv, full cycle loads nothing heavy here', async (t) => {
  process.env.VARANDA_TEST_SEGREDO = 'segredo'
  t.teardown(() => { delete process.env.VARANDA_TEST_SEGREDO }, { force: true })
  const { e, report } = await fakeChild(t)
  t.is(e.modelId, MODEL_ID)
  t.is(e.device, 'cpu')
  const [start] = starts(report)
  t.ok(start, 'the child started')
  t.comment('child env keys: ' + JSON.stringify(start.env))
  t.absent(start.env.some((k) => k.startsWith('VARANDA_')), 'no VARANDA_* in the child')
  t.absent(start.env.includes('HOME'))
  t.absent(start.env.includes('PATH'))
  // Empty: macOS itself injects __CF_USER_TEXT_ENCODING into every process.
  t.alike(start.env.filter((k) => k !== '__CF_USER_TEXT_ENCODING'), [], 'empty environment')
  t.alike(start.execArgv, [])
  t.alike(start.argv, [])
  t.is(start.init.type, 'init')
  t.is(start.init.modelId, MODEL_ID)
  t.is(start.init.revision, MODEL_REVISION)
  t.is(start.init.device, 'cpu')
  t.ok(path.isAbsolute(start.init.modelDir))

  const a = await e.embed('o gato subiu no telhado')
  t.is(a.truncated, false)
  t.is(a.embedding.length, DIM)
  t.ok(a.embedding.every(Number.isFinite))
  t.alike(await e.embed('palavra '.repeat(200)), { embedding: null, truncated: true })
  await t.exception(e.embed(42), { code: 'texto' })
  // Serialized: concurrent callers each get their own answer.
  const all = await Promise.all(['um', 'dois', 'tres'].map((s) => e.embed(s)))
  t.ok(all.every((r) => r.embedding.length === DIM))
  t.absent(all[0].embedding.every((v, i) => v === all[1].embedding[i]))
  await e.close()
  await gone(start.pid)
  t.is(starts(report).length, 1, 'one child for the whole cycle')
  t.alike(heavyLoaded(), [], 'no @huggingface / onnxruntime / sharp in the parent')
})

test('child: what it prints never reaches the parent stdout/stderr', async (t) => {
  const { dir, files } = fakeModelDir(t)
  const report = path.join(tmpDir(t, 'varanda-ai-rep-'), 'starts.jsonl')
  const sentinel = 'SENTINELA-' + crypto.randomBytes(8).toString('hex')
  const args = JSON.stringify({ embedder: require.resolve('../lib/account/ai/embedder'), child: FAKE_CHILD, dir, files, report, sentinel })
  const script = [
    'const a = JSON.parse(process.argv[1])',
    'const { createEmbedder } = require(a.embedder)',
    ';(async () => {',
    '  const e = await createEmbedder({ modelDir: a.dir, _files: a.files, _childPath: a.child, _childInit: { report: a.report, sentinel: a.sentinel } })',
    '  const r = await e.embed("texto qualquer")',
    '  await e.close()',
    '  console.log("FIM " + r.embedding.length)',
    '})().catch((err) => { console.log("ERRO " + err.code); process.exit(1) })'
  ].join('\n')
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', script, args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  t.is(out.code, 0)
  t.is(out.stdout.trim(), 'FIM ' + DIM)
  t.absent(out.stdout.includes(sentinel), 'not on stdout')
  t.absent(out.stderr.includes(sentinel), 'not on stderr')
  const [start] = starts(report)
  t.is(start.init.sentinel, sentinel, 'the child did get the sentinel to print')
})

test('child: request deadline -> falha-ia, child killed, lazy respawn after the backoff', async (t) => {
  const { e, report, now } = await fakeChild(t)
  const [first] = starts(report)
  const t0 = Date.now()
  await t.exception(e.embed('HANG'), { code: 'falha-ia' })
  t.ok(Date.now() - t0 < 3000, 'the 500 ms deadline fired')
  await gone(first.pid)
  // Within the backoff: rejected at once, nothing spawned.
  await t.exception(e.embed('ola'), { code: 'falha-ia' })
  t.is(starts(report).length, 1)
  now.advance(5000)
  const r = await e.embed('ola')
  t.is(r.embedding.length, DIM)
  const all = starts(report)
  t.is(all.length, 2, 'respawned once, handshake re-run')
  t.not(all[1].pid, first.pid)
  t.alike(all[1].env.filter((k) => k.startsWith('VARANDA_')), [])
})

test('child: a crash fails the in-flight request, then recovery', async (t) => {
  const { e, report, now } = await fakeChild(t)
  const [first] = starts(report)
  await t.exception(e.embed('CRASH'), { code: 'falha-ia' })
  await gone(first.pid)
  await t.exception(e.embed('ola'), { code: 'falha-ia' }, 'backing off')
  now.advance(5001)
  t.is((await e.embed('ola')).embedding.length, DIM)
  t.is(starts(report).length, 2)
})

test('child: bad vectors are falha-ia; junk and wrong ids are ignored', async (t) => {
  const { e, report } = await fakeChild(t)
  await t.exception(e.embed('BADVEC'), { code: 'falha-ia' })
  await t.exception(e.embed('NANVEC'), { code: 'falha-ia' })
  const junk = await e.embed('JUNK')
  t.is(junk.truncated, false)
  t.is(junk.embedding.length, DIM)
  t.absent(junk.embedding.every((v) => v === 0), 'the real answer, not the wrong-id one')
  t.is((await e.embed('ola')).embedding.length, DIM)
  t.is(starts(report).length, 1, 'a bad answer does not respawn')
})

test('child: no ready or an init error -> sem-modelo, child killed', async (t) => {
  const t0 = Date.now()
  const report = path.join(tmpDir(t, 'varanda-ai-rep-'), 'starts.jsonl')
  await t.exception(fakeChild(t, { report, noReady: true }, { _initMs: 300 }), { code: 'sem-modelo' })
  t.ok(Date.now() - t0 < 3000)
  const [start] = starts(report)
  t.ok(start)
  await gone(start.pid)

  const report2 = path.join(tmpDir(t, 'varanda-ai-rep-'), 'starts.jsonl')
  await t.exception(fakeChild(t, { report: report2, initError: true }), { code: 'sem-modelo' })
  await gone(starts(report2)[0].pid)

  const { dir, files } = fakeModelDir(t)
  await t.exception(createEmbedder({ modelDir: dir, _files: files, _childPath: path.join(dir, 'nada.js'), _initMs: 3000 }), { code: 'sem-modelo' })
})

test('child: close() -> fechado, the child is gone, even mid-request', async (t) => {
  const { e, report } = await fakeChild(t, {}, { _requestMs: 20000 })
  const [start] = starts(report)
  t.is((await e.embed('ola')).embedding.length, DIM)
  const hung = e.embed('HANG').catch((err) => err)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const t0 = Date.now()
  await e.close()
  t.ok(Date.now() - t0 < 3500, 'close resolves within about 3 s')
  t.is((await hung).code, 'fechado')
  await gone(start.pid)
  await t.exception(e.embed('ola'), { code: 'fechado' })
  await e.close()
  t.is(starts(report).length, 1, 'close never respawns')
})

test('real model through the real child (VARANDA_AI_MODEL_DIR): paraphrases closer than unrelated', async (t) => {
  const modelDir = process.env.VARANDA_AI_MODEL_DIR
  if (!modelDir) {
    t.comment('skip: VARANDA_AI_MODEL_DIR not set')
    t.pass()
    return
  }
  const t0 = Date.now()
  const e = await createEmbedder({ modelDir })
  const loadMs = Date.now() - t0
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0)
  const a = await e.embed('Você é um idiota e ninguém gosta de você.')
  const t1 = Date.now()
  const b = await e.embed('Ninguém gosta de você, seu imbecil.')
  const embedMs = Date.now() - t1
  const c = await e.embed('A receita de bolo de cenoura leva três ovos.')
  const long = await e.embed('palavra '.repeat(200))
  await e.close()
  const para = dot(a.embedding, b.embedding)
  const unrelated = dot(a.embedding, c.embedding)
  t.comment('load ' + loadMs + 'ms, embed ' + embedMs + 'ms, paraphrase ' + para.toFixed(4) + ', unrelated ' + unrelated.toFixed(4))
  t.is(a.embedding.length, DIM)
  t.ok(para > unrelated)
  t.alike(long, { embedding: null, truncated: true })
  t.alike(heavyLoaded(), [], 'the model ran in the child only')
})
