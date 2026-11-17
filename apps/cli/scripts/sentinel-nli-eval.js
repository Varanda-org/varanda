#!/usr/bin/env node
'use strict'

// Dev-only: measures how well a zero-shot NLI model ("Jev leve") flags the
// categories of the Terms (apps/app/src/legal.js, Convivência e denúncias) on
// a small synthetic pt-BR set, for the Sentinela spike 2. Never run by npm
// test, npm run demo or CI. Never downloads anything: it needs the models
// already extracted in transformers.js layout in a directory OUTSIDE the
// repository (<dir>/<id>/{config.json,tokenizer.json,tokenizer_config.json,
// onnx/model_quantized.onnx}).
// Quantized files are produced locally, quantizing only the embedding table
// (Gather): onnxruntime-node 1.21 badly degrades dynamic-int8 MatMul logits of
// these classifiers on this Mac, so MatMul stays fp32. Both files come from
// onnxruntime 1.32.0 quantize_dynamic(QInt8, op_types_to_quantize=['Gather'])
// over the fp32 model.onnx and their logits match fp32 under ORT 1.21. The
// published mDeBERTa model_quantized.onnx has the MatMul problem and must NOT
// be used. The model and tokenizer files are pinned (sha256, size) by the
// table in sentinel-nli-fixture.js, which this script reuses.
// One (premise, hypothesis) pair per post and category; the category score is
// softmax over [entailment, contradiction] logits, i.e. P(entail). The post
// text is never printed: only ids, numbers and category names.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { configureEnv } = require('../lib/account/ai/embed-child')
const { MODELS, inside, realish, verifyModel } = require('./sentinel-nli-fixture')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const SET_PATH = path.join(__dirname, 'sentinel-nli-eval-set.json')
const THRESHOLDS = [0.5, 0.7, 0.9]
const MAX_TOKENS = 256
const WARMUP = 3

function usage (msg) {
  if (msg) console.error('erro: ' + msg)
  console.error('uso: node apps/cli/scripts/sentinel-nli-eval.js --model-dir <diretório fora do repositório> [--json <arquivo fora do repositório>]')
  process.exit(2)
}

function arg (argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return null
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) usage('informe o valor de ' + name)
  return argv[i + 1]
}

function pct (sortedAsc, p) {
  if (!sortedAsc.length) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

// P(entailment) from the [entailment, contradiction] logits only.
function pEntail (ent, con) {
  const m = Math.max(ent, con)
  const e = Math.exp(ent - m)
  const c = Math.exp(con - m)
  return e / (e + c)
}

// ROC AUC (rank based, ties count half); null when a class is empty.
function auc (scores, truth) {
  let pos = 0
  let neg = 0
  let sum = 0
  for (let i = 0; i < scores.length; i++) {
    if (!truth[i]) continue
    pos++
    for (let j = 0; j < scores.length; j++) {
      if (truth[j]) continue
      if (scores[i] > scores[j]) sum += 1
      else if (scores[i] === scores[j]) sum += 0.5
    }
  }
  for (const t of truth) if (!t) neg++
  return pos && neg ? sum / (pos * neg) : null
}

function prf (tp, fp, fn) {
  const precision = tp + fp ? tp / (tp + fp) : null
  const recall = tp + fn ? tp / (tp + fn) : null
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : (precision === null || recall === null ? null : 0)
  return { tp, fp, fn, precision, recall, f1 }
}

function fmt (v, d = 2) {
  return v === null || v === undefined ? 'n/a' : v.toFixed(d)
}

async function loadModel (hf, modelDir, spec) {
  const dir = path.join(modelDir, spec.id)
  verifyModel(modelDir, spec)
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
  const byName = {}
  for (const [k, v] of Object.entries(cfg.id2label || {})) byName[String(v).toLowerCase()] = Number(k)
  if (byName.entailment === undefined || byName.contradiction === undefined) throw new Error('config sem entailment/contradiction em ' + spec.key)
  configureEnv(hf.env, modelDir)
  const opts = { local_files_only: true }
  const tokenizer = await hf.AutoTokenizer.from_pretrained(spec.id, opts)
  configureEnv(hf.env, modelDir)
  const model = await hf.AutoModelForSequenceClassification.from_pretrained(spec.id, { ...opts, dtype: 'q8' })
  return { tokenizer, model, iEnt: byName.entailment, iCon: byName.contradiction }
}

async function scorePair (m, premise, hypothesis) {
  const inputs = m.tokenizer(premise, { text_pair: hypothesis, padding: false, truncation: true, max_length: MAX_TOKENS })
  const out = await m.model(inputs)
  const d = out.logits.data
  if (!d || d.length !== 3 || !Number.isFinite(d[m.iEnt]) || !Number.isFinite(d[m.iCon])) throw new Error('logits inválidos')
  const p = pEntail(d[m.iEnt], d[m.iCon])
  if (typeof out.logits.dispose === 'function') out.logits.dispose()
  return p
}

async function evalModel (hf, modelDir, spec, set) {
  const m = await loadModel(hf, modelDir, spec)
  const cats = set.categories
  const lat = []
  // Warm-up (not timed, not scored): the first runs allocate buffers.
  for (let i = 0; i < WARMUP; i++) await scorePair(m, set.posts[i % set.posts.length].text, set.hypotheses.canonical[cats[0]])
  const result = { key: spec.key, id: spec.id, variants: {} }
  for (const variant of ['canonical', 'alt']) {
    const scores = {} // category -> [score per post]
    for (const c of cats) {
      scores[c] = []
      for (const post of set.posts) {
        const t0 = process.hrtime.bigint()
        const p = await scorePair(m, post.text, set.hypotheses[variant][c])
        lat.push(Number(process.hrtime.bigint() - t0) / 1e6)
        scores[c].push(p)
      }
    }
    result.variants[variant] = analyse(set, scores)
  }
  if (typeof m.model.dispose === 'function') await m.model.dispose()
  lat.sort((a, b) => a - b)
  result.latencyMs = { pairs: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95) }
  return result
}

function analyse (set, scores) {
  const cats = set.categories
  const posts = set.posts
  const out = { perCategory: {}, any: {}, trickyFlagged: {}, scoreStats: {} }
  for (const c of cats) {
    const truth = posts.map((p) => p.labels.includes(c))
    const row = { positives: truth.filter(Boolean).length, auc: auc(scores[c], truth), thresholds: {} }
    for (const t of THRESHOLDS) {
      let tp = 0; let fp = 0; let fn = 0
      posts.forEach((p, i) => {
        const pred = scores[c][i] >= t
        if (pred && truth[i]) tp++
        else if (pred) fp++
        else if (truth[i]) fn++
      })
      row.thresholds[t] = prf(tp, fp, fn)
    }
    out.perCategory[c] = row
  }
  const anyTruth = posts.map((p) => p.labels.length > 0)
  for (const t of THRESHOLDS) {
    let tp = 0; let fp = 0; let fn = 0
    const flagged = []
    posts.forEach((p, i) => {
      const hit = cats.filter((c) => scores[c][i] >= t)
      const pred = hit.length > 0
      if (pred && anyTruth[i]) tp++
      else if (pred) fp++
      else if (anyTruth[i]) fn++
      if (pred && p.tricky) flagged.push(p.id + '(' + hit.join('+') + ')')
    })
    out.any[t] = prf(tp, fp, fn)
    out.trickyFlagged[t] = flagged
  }
  // Max-over-categories score per post: AUC for the "any" decision.
  const maxScores = posts.map((p, i) => Math.max(...cats.map((c) => scores[c][i])))
  out.anyAuc = auc(maxScores, anyTruth)
  const clean = maxScores.filter((s, i) => !anyTruth[i]).sort((a, b) => a - b)
  const bad = maxScores.filter((s, i) => anyTruth[i]).sort((a, b) => a - b)
  out.scoreStats = { cleanMaxMedian: pct(clean, 0.5), cleanMaxP95: pct(clean, 0.95), flaggedMaxMedian: pct(bad, 0.5), flaggedMaxP05: pct(bad, 0.05) }
  return out
}

function printReport (set, results) {
  const nTricky = set.posts.filter((p) => p.tricky).length
  const nClean = set.posts.filter((p) => !p.labels.length).length
  console.log('# Sentinela NLI eval')
  console.log('')
  console.log('Set: ' + set.posts.length + ' posts sintéticos (' + nClean + ' limpos, ' + nTricky + ' deles "tricky"; ' + (set.posts.length - nClean) + ' com rótulo), categorias: ' + set.categories.join(', '))
  console.log('CPU: ' + os.cpus()[0].model + ' x' + os.cpus().length + ', Node ' + process.version + ', ' + process.platform + '/' + process.arch + ', onnxruntime-node (backend CPU), um processo, threads padrão')
  console.log('Score: P(entail) = softmax([entailment, contradiction]); um par (post, hipótese) por categoria; truncamento em ' + MAX_TOKENS + ' tokens')
  console.log('')
  for (const variant of ['canonical', 'alt']) {
    console.log('## Hipóteses: ' + variant)
    console.log('')
    for (const c of set.categories) console.log('- ' + c + ': ' + set.hypotheses[variant][c])
    console.log('')
    for (const r of results) {
      const v = r.variants[variant]
      console.log('### ' + r.key + ' / ' + variant)
      console.log('')
      console.log('| categoria | n+ | AUC | P@0.5 | R@0.5 | F1@0.5 | P@0.7 | R@0.7 | F1@0.7 | P@0.9 | R@0.9 | F1@0.9 |')
      console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
      const line = (name, n, a, get) => {
        const cells = [name, n, fmt(a)]
        for (const t of THRESHOLDS) {
          const x = get(t)
          cells.push(fmt(x.precision), fmt(x.recall), fmt(x.f1))
        }
        console.log('| ' + cells.join(' | ') + ' |')
      }
      for (const c of set.categories) line(c, v.perCategory[c].positives, v.perCategory[c].auc, (t) => v.perCategory[c].thresholds[t])
      line('QUALQUER', set.posts.length - nClean, v.anyAuc, (t) => v.any[t])
      console.log('')
      console.log('Falsos positivos nos posts limpos "tricky" (qualquer categoria), ids(categorias):')
      for (const t of THRESHOLDS) console.log('- limiar ' + t + ': ' + v.trickyFlagged[t].length + '/' + nTricky + (v.trickyFlagged[t].length ? ' ' + v.trickyFlagged[t].join(', ') : ''))
      const s = v.scoreStats
      console.log('- maior score por post: limpos mediana ' + fmt(s.cleanMaxMedian) + ', p95 ' + fmt(s.cleanMaxP95) + '; com rótulo mediana ' + fmt(s.flaggedMaxMedian) + ', p05 ' + fmt(s.flaggedMaxP05))
      console.log('')
    }
  }
  console.log('## Latência por par (tokenização + inferência, Node)')
  console.log('')
  console.log('| modelo | pares | p50 ms | p95 ms |')
  console.log('|---|---|---|---|')
  for (const r of results) console.log('| ' + r.key + ' | ' + r.latencyMs.pairs + ' | ' + fmt(r.latencyMs.p50, 1) + ' | ' + fmt(r.latencyMs.p95, 1) + ' |')
}

async function main () {
  const argv = process.argv.slice(2)
  const modelArg = arg(argv, '--model-dir')
  if (!modelArg) usage('informe --model-dir')
  const repo = fs.realpathSync.native(REPO_ROOT)
  const modelDir = path.resolve(modelArg)
  if (inside(realish(modelDir), repo)) usage('o diretório do modelo não pode ficar dentro do repositório')
  const jsonArg = arg(argv, '--json')
  let jsonOut = null
  if (jsonArg) {
    jsonOut = path.resolve(jsonArg)
    if (inside(realish(jsonOut), repo)) usage('--json precisa ficar fora do repositório')
  }

  const set = JSON.parse(fs.readFileSync(SET_PATH, 'utf8'))
  const hf = require('@huggingface/transformers')
  const results = []
  for (const spec of MODELS) {
    results.push(await evalModel(hf, modelDir, spec, set))
  }
  printReport(set, results)

  if (jsonOut) {
    let link = false
    try { link = fs.lstatSync(jsonOut).isSymbolicLink() } catch {}
    if (link) throw new Error('--json não pode ser um link simbólico')
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true })
    const fd = fs.openSync(jsonOut, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644)
    try { fs.writeSync(fd, JSON.stringify({ hypotheses: set.hypotheses, results }, null, 2) + '\n') } finally { fs.closeSync(fd) }
  }
}

// No process.exit on success: with the onnxruntime sessions alive, an explicit
// exit can abort in the native teardown (exit code 134) after the report.
main().then(() => { process.exitCode = 0 }, (err) => {
  console.error('erro: ' + (err && err.code ? err.code : err && err.message ? err.message : 'falha'))
  process.exitCode = 1
})
