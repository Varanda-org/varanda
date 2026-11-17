// Dev-only on-device benchmark for the Sentinela spike
// (EXPO_PUBLIC_VARANDA_SENTINEL_BENCH=1, index.js). Prints formatLine
// output (timings, sizes, counts and cosines) plus, on failure, an A-Z error
// code: never text, ids or vectors.
import { isAvailable, load, embed, classify, memory, unload } from '../../modules/sentinel-spike'
import { cosine, maxAbsDiff, argmax, summary, formatLine } from './bench'
import fixture from './benchFixture.json'
import nliFixture from './nliFixture.json'

const THREADS = [1, 2, 4]
const WARMUPS = 5
const RUNS = 50
const LOOP_MS = 60000
const PASS = 0.99
const NLI_WARMUPS = 3
const NLI_RUNS = 30
const NLI_PASS = 1e-3

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const log = (name, stats) => console.log(formatLine(name, stats))

async function mem (name) {
  try {
    const { bytes } = await memory()
    log(name, { bytes })
  } catch (err) {
    logError(err)
  }
}

function logError (err) {
  const code = err && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? err.code : 'FAILED'
  console.log('sentinel-bench error ' + code)
}

async function runCase (threads, c) {
  for (let i = 0; i < WARMUPS; i++) await embed(c.inputIds, c.attentionMask)
  const infer = []
  const rt = []
  let last = null
  for (let i = 0; i < RUNS; i++) {
    const t0 = now()
    const r = await embed(c.inputIds, c.attentionMask)
    rt.push(now() - t0)
    infer.push(r.inferMs)
    last = r.vector
  }
  const cos = cosine(last, c.expected)
  const a = summary(infer)
  const b = summary(rt)
  log('embed-t' + threads + '-' + c.name, {
    n: c.n,
    infer_p50: a.p50,
    infer_p95: a.p95,
    rt_p50: b.p50,
    rt_p95: b.p95,
    cos,
    pass: cos >= PASS ? 1 : 0
  })
}

async function loop (c) {
  const infer = []
  const end = now() + LOOP_MS
  while (now() < end) {
    const r = await embed(c.inputIds, c.attentionMask)
    infer.push(r.inferMs)
    await tick()
  }
  const a = summary(infer)
  log('loop-t1-' + c.name, { count: a.n, infer_p50: a.p50, infer_p95: a.p95 })
}

async function runNliCase (threads, c) {
  const m = c.perModel.minilm
  for (let i = 0; i < NLI_WARMUPS; i++) await classify(m.inputIds, m.attentionMask)
  const infer = []
  const rt = []
  let last = null
  for (let i = 0; i < NLI_RUNS; i++) {
    const t0 = now()
    const r = await classify(m.inputIds, m.attentionMask)
    rt.push(now() - t0)
    infer.push(r.inferMs)
    last = r.logits
  }
  const a = summary(infer)
  const b = summary(rt)
  const same = last.length === m.logits.length
  const maxAbs = same ? maxAbsDiff(last, m.logits) : null
  const argmaxOk = same && argmax(last) === argmax(m.logits)
  const ok = same && maxAbs <= NLI_PASS && argmaxOk
  log('nli-t' + threads + '-' + c.name, {
    n: m.n,
    infer_p50: a.p50,
    infer_p95: a.p95,
    rt_p50: b.p50,
    rt_p95: b.p95,
    max_abs: maxAbs,
    argmax_ok: argmaxOk ? 1 : 0,
    pass: ok ? 1 : 0
  })
}

// The NLI phase: only the MiniLM entry runs on a phone (mDeBERTa is Node-only,
// too big). Returns after logging one line when the model file is absent.
async function runNli () {
  const entry = nliFixture.models.find((x) => x.key === 'minilm')
  const pin = entry.sha256
  let loaded = false
  try {
    for (const threads of THREADS) {
      const t0 = now()
      let info
      try {
        info = await load('nli', pin, threads)
      } catch (err) {
        if (err && err.code === 'MISSING') { log('nli-skipped', {}); return }
        throw err
      }
      loaded = true
      log('nli-load-t' + threads, { load_ms: now() - t0, native_load_ms: info.loadMs, file_bytes: info.fileBytes })
      await mem('nli-memory-load-t' + threads)
      for (const c of nliFixture.cases) await runNliCase(threads, c)
      await mem('nli-memory-run-t' + threads)
      await unload()
      loaded = false
      await mem('nli-memory-unload-t' + threads)
    }
  } finally {
    if (loaded) await unload().catch(() => {})
  }
}

export async function runSentinelBench () {
  try {
    if (!isAvailable()) { log('unavailable', {}); return }
    const pin = fixture.model.sha256
    await mem('memory-baseline')
    let loaded = false
    try {
      for (const threads of THREADS) {
        const t0 = now()
        let info
        try {
          info = await load('embed', pin, threads)
        } catch (err) {
          if (err && (err.code === 'MISSING' || err.code === 'UNSUPPORTED')) { log('unavailable', {}); return }
          throw err
        }
        loaded = true
        log('load-t' + threads, { load_ms: now() - t0, native_load_ms: info.loadMs, file_bytes: info.fileBytes })
        await mem('memory-load-t' + threads)
        for (const c of fixture.cases) await runCase(threads, c)
        await mem('memory-run-t' + threads)
        await unload()
        loaded = false
        await mem('memory-unload-t' + threads)
      }
      await load('embed', pin, 1)
      loaded = true
      await loop(fixture.cases.find((c) => c.name === 't64'))
    } finally {
      if (loaded) await unload().catch(() => {})
    }
    await runNli()
  } catch (err) {
    logError(err)
  }
}
