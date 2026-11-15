#!/usr/bin/env node
'use strict'

// Dev-only: builds apps/app/src/sentinel/nliFixture.json, the pair-encoded
// token ids and reference logits the on-device Sentinela NLI spike compares
// against, so it can check parity with the model run by transformers.js
// without porting either tokenizer. Never run by npm test, npm run demo or
// CI. Never downloads anything: it needs the two NLI models already fetched
// and quantized (see below) into a directory OUTSIDE the repository,
// laid out the way transformers.js reads a local model:
//   <dir>/<model id>/{config.json,tokenizer.json,tokenizer_config.json,onnx/model_quantized.onnx}
//   node apps/cli/scripts/sentinel-nli-fixture.js --model-dir /var/lib/varanda/nli-model
// The sha256 of all four files (and the size of the model) are checked
// against the table below before anything loads. The premises are
// fixed, neutral and carry no member content; the hypotheses are neutral too.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { configureEnv } = require('../lib/account/ai/embed-child')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const OUT_NAME = 'nliFixture.json'
const DEFAULT_OUT = path.join(REPO_ROOT, 'apps', 'app', 'src', 'sentinel', OUT_NAME)
const MAX_TOKENS = 256
const LABELS = ['entailment', 'neutral', 'contradiction']

// Both files were produced locally from the fp32 onnx/model.onnx of the pinned
// revision with onnxruntime 1.32.0 quantize_dynamic(QInt8,
// op_types_to_quantize=['Gather']): only the embedding table is int8. Any int8
// MatMul (the default, per-channel, and the published mDeBERTa
// model_quantized.onnx) squashes the logits under onnxruntime 1.21, the version
// the app and the server run. The hash pins the bytes: quantization is not
// reproducible across onnxruntime versions.
const MODELS = [
  {
    key: 'minilm',
    id: 'MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli',
    revision: '0a71e92a985b6e1ad1828cf67ce9c459639c1dca',
    file: 'onnx/model_quantized.onnx',
    sha256: 'c15eef0c5b1e987b3190259c2a5c81f9bca023c508002881ade33af3706675c9',
    bytes: 139580898,
    tokenizerSha256: '098c131bb4423163db239755e309facaa6850059f850f9f3d88a78344a4b631c',
    configSha256: '79862295be1538a947e0f56d495ef8d658c3eaebcfb42c7ad96229d195ca745d',
    tokenizerConfigSha256: '86139ce1f39e814bcdb99a6fe30c0c4983911508aad07417e616d994fb74eb25'
  },
  {
    key: 'mdeberta',
    id: 'MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7',
    revision: 'b5113eb38ab63efdd7f280f8c144ea8b13f978ce',
    file: 'onnx/model_quantized.onnx',
    sha256: '9d433ee4019854e340020c20e62903d92d76d9ec25f8fc8d6a7ad4a0f6832bd6',
    bytes: 538123257,
    tokenizerSha256: 'e23095eb61ba944c7be3a5d3e8ec19e37ce7ced0daa03550bde03e83c21b3f8a',
    configSha256: 'bc7b85f164a17c1b007d87fb99d3676f4a4d2e6511d2288dd3f5334dc0f34e6b',
    tokenizerConfigSha256: '25e9f84c6b43da7bff43a0aee8eeee2c8a39d246823d8464b9275ef704eab42f'
  }
]

const T16 = 'Fui à feira com minha irmã e compramos mangas.'
const T64 = 'No sábado a gente se reuniu na praça do bairro para plantar mudas de ipê e de pitanga. As crianças trouxeram regadores pequenos e os vizinhos levaram café e bolo de milho. Foi uma manhã tranquila, com sol fraco e vento leve, e todos voltaram contentes.'
const T128 = 'Neste fim de semana organizamos a limpeza da horta comunitária atrás da escola. Chegamos cedo, com luvas, enxadas e baldes. Primeiro arrancamos o mato alto ao redor dos canteiros, depois separamos as folhas secas para fazer adubo. O seu João ensinou a preparar a terra para plantar alface e coentro, e a dona Marta explicou como regar sem desperdiçar água. As crianças colocaram as plaquinhas em cada fileira. No fim da manhã dividimos um lanche simples e combinamos de voltar daqui a quinze dias.'

const CASES = [
  { name: 'p16-compras', premise: T16, hypothesis: 'Este texto fala de compras.' },
  { name: 'p16-ofensa', premise: T16, hypothesis: 'Este texto ofende uma pessoa.' },
  { name: 'p64-plantio', premise: T64, hypothesis: 'Este texto fala de plantar árvores.' },
  { name: 'p64-ofensa', premise: T64, hypothesis: 'Este texto ofende uma pessoa.' },
  { name: 'p128-horta', premise: T128, hypothesis: 'Este texto fala de uma horta comunitária.' },
  { name: 'p128-futebol', premise: T128, hypothesis: 'Este texto fala de futebol.' }
]

function usage (msg) {
  if (msg) console.error('erro: ' + msg)
  console.error('uso: node apps/cli/scripts/sentinel-nli-fixture.js --model-dir <diretório fora do repositório> [--out <arquivo>]')
  process.exit(2)
}

function arg (argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return null
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) usage('informe o valor de ' + name)
  return argv[i + 1]
}

// The real path of the nearest existing ancestor (symlinks resolved), plus
// the rest of the path: a symlink cannot smuggle the directory into the repo.
function realish (p) {
  let cur = p
  const rest = []
  while (!fs.existsSync(cur)) {
    rest.unshift(path.basename(cur))
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  // .native returns the on-disk spelling: on a case-insensitive filesystem a
  // case variant of the repository path must still count as inside it.
  return path.join(fs.realpathSync.native(cur), ...rest)
}

function inside (child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

// The only file --out can name: <allowedDir>/nliFixture.json. The fixture
// lives next to the bench, so --out cannot overwrite any other file, in the
// repository or outside it. Refuses another file name, a path whose real
// location (symlinks resolved) is outside allowedDir, and a symlink at the
// target itself, dangling or not: realish() sees a dangling symlink as a
// missing file, so lstat has to catch it.
function resolveOut (out, allowedDir) {
  const abs = path.resolve(out)
  if (path.basename(abs) !== OUT_NAME) throw new Error('--out precisa se chamar ' + OUT_NAME)
  if (!inside(realish(abs), realish(allowedDir))) throw new Error('--out precisa ficar em ' + path.relative(REPO_ROOT, allowedDir))
  let link = false
  try { link = fs.lstatSync(abs).isSymbolicLink() } catch {}
  if (link) throw new Error('--out não pode ser um link simbólico')
  return abs
}

function round6 (v) {
  return Math.round(v * 1e6) / 1e6
}

function argmax (logits) {
  let best = 0
  for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i
  return LABELS[best]
}

// Streams the file (the models are hundreds of MB) and returns its size and
// sha256; refuses a symlink so the bytes hashed are the bytes in the model dir.
function hashFile (file) {
  const st = fs.lstatSync(file)
  if (!st.isFile()) throw new Error('arquivo inválido: ' + file)
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return { bytes: st.size, sha256: h.digest('hex') }
}

function verifyModel (modelDir, m) {
  const base = path.join(modelDir, m.id)
  const model = hashFile(path.join(base, m.file))
  if (model.bytes !== m.bytes || model.sha256 !== m.sha256) throw new Error('modelo ' + m.key + ' não confere com o pinado (tamanho ou sha256)')
  const tok = hashFile(path.join(base, 'tokenizer.json'))
  if (tok.sha256 !== m.tokenizerSha256) throw new Error('tokenizer de ' + m.key + ' não confere com o pinado')
  // config.json carries id2label (which logit is entailment) and
  // tokenizer_config.json the tokenizer settings: pinned too, or a swapped
  // label would invert every score while the model hash still matches.
  if (hashFile(path.join(base, 'config.json')).sha256 !== m.configSha256) throw new Error('config.json de ' + m.key + ' não confere com o pinado')
  if (hashFile(path.join(base, 'tokenizer_config.json')).sha256 !== m.tokenizerConfigSha256) throw new Error('tokenizer_config.json de ' + m.key + ' não confere com o pinado')
}

async function runModel (hf, modelDir, m) {
  configureEnv(hf.env, modelDir)
  const tokenizer = await hf.AutoTokenizer.from_pretrained(m.id, { local_files_only: true })
  configureEnv(hf.env, modelDir)
  // dtype q8 selects onnx/model_quantized.onnx, the file verified above.
  const model = await hf.AutoModelForSequenceClassification.from_pretrained(m.id, { local_files_only: true, dtype: 'q8' })
  try {
    const out = []
    for (const c of CASES) {
      const enc = await tokenizer(c.premise, { text_pair: c.hypothesis, truncation: false, padding: false })
      const inputIds = Array.from(enc.input_ids.data, Number)
      const attentionMask = Array.from(enc.attention_mask.data, Number)
      const n = inputIds.length
      if (n > MAX_TOKENS) throw new Error('par ' + c.name + ' passa de ' + MAX_TOKENS + ' tokens (' + n + ')')
      if (attentionMask.length !== n || attentionMask.some((v) => v !== 1)) throw new Error('máscara inesperada em ' + c.name)
      const res = await model({ input_ids: enc.input_ids, attention_mask: enc.attention_mask })
      const t = res && res.logits
      if (!t || !Array.isArray(t.dims) || t.dims.length !== 2 || t.dims[0] !== 1 || t.dims[1] !== LABELS.length) throw new Error('saída inesperada em ' + c.name)
      const logits = Array.from(t.data, Number)
      if (!logits.every(Number.isFinite)) throw new Error('logits inválidos em ' + c.name)
      const rounded = logits.map(round6)
      out.push({ inputIds, attentionMask, n, logits: rounded, argmax: argmax(rounded) })
    }
    return out
  } finally {
    if (typeof model.dispose === 'function') await model.dispose()
  }
}

async function main () {
  const argv = process.argv.slice(2)
  const modelArg = arg(argv, '--model-dir')
  if (!modelArg) usage('informe --model-dir')
  const modelDir = path.resolve(modelArg)
  const repo = fs.realpathSync.native(REPO_ROOT)
  if (inside(realish(modelDir), repo)) usage('o diretório do modelo não pode ficar dentro do repositório')
  let out
  try {
    out = resolveOut(arg(argv, '--out') || DEFAULT_OUT, path.dirname(DEFAULT_OUT))
  } catch (err) {
    usage(err.message)
  }

  for (const m of MODELS) verifyModel(modelDir, m)

  const hf = require('@huggingface/transformers')
  const results = {}
  for (const m of MODELS) results[m.key] = await runModel(hf, modelDir, m)

  const doc = {
    models: MODELS.map((m) => ({ key: m.key, id: m.id, revision: m.revision, file: m.file, sha256: m.sha256, bytes: m.bytes })),
    cases: CASES.map((c, i) => ({
      name: c.name,
      premise: c.premise,
      hypothesis: c.hypothesis,
      perModel: Object.fromEntries(MODELS.map((m) => [m.key, results[m.key][i]]))
    }))
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  // O_NOFOLLOW: a link planted after resolveOut() is not followed either.
  const fd = fs.openSync(out, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644)
  try { fs.writeSync(fd, JSON.stringify(doc) + '\n') } finally { fs.closeSync(fd) }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex').slice(0, 12)
  console.log('ok ' + path.relative(REPO_ROOT, out) + ' (casos: ' + CASES.map((c) => c.name).join(', ') + '; sha256 ' + digest + ')')
  for (const c of doc.cases) {
    console.log('  ' + c.name + ': ' + MODELS.map((m) => m.key + '=' + c.perModel[m.key].argmax + ' n=' + c.perModel[m.key].n).join(' '))
  }
}

module.exports = { MODELS, CASES, LABELS, OUT_NAME, DEFAULT_OUT, inside, realish, resolveOut, hashFile, verifyModel, round6, argmax }

if (require.main === module) {
  // No process.exit() on success: onnxruntime-node aborts (SIGABRT, a mutex
  // error in its static teardown) when the process is torn down while its
  // thread pool is still alive. Letting the loop drain exits cleanly.
  main().then(() => {}, (err) => {
    console.error('erro: ' + (err && err.code ? err.code : err && err.message ? err.message : 'falha'))
    process.exitCode = 1
  })
}
