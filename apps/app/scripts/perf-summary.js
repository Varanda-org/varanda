'use strict'

// Reads a saved log (adb logcat, a Metro console capture) and prints median,
// p95 and spread (max - min) across runs, per mark, per render id and per
// frames line. Usage: node scripts/perf-summary.js <log file>
//
// A run starts at each "perf: js-entry" line; lines before the first one are
// left out when the log has any. Per run, a mark counts once (its first line,
// ms since js-entry, or a span's length), render lines are summed per id and
// phase, and frames lines give one sample per list (see frameSamples). So n
// is the number of runs that printed it.

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const MARKS = new Set([
  'js-entry', 'sweep-media-cache', 'worklet-start', 'app-commit', 'config', 'sync.status',
  'identity.status', 'ready', 'blocks-ok', 'details', 'moments', 'splash-end', 'first-rows', 'preview-shown',
  'media-hash', 'rows-snapshot', 'rows-live'
])
const MARK_PREFIXES = ['first-rows:', 'rows-snapshot:', 'rows-live:', 'req:', 'tab:', 'scroll-start:', 'scroll-done:']
// Every token the harness prints: names, ids, key=value fields and numbers.
const SAFE_TOKEN = /^[A-Za-z0-9:._/=-]{1,80}$/
const FRAME_FIELDS = ['n', 'p50', 'p95', 'max', 'over32', 'mounts', 'rendersPerMountMedian', 'rendersPerMountP95']

function knownMark (name) {
  return MARKS.has(name) || MARK_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length)
}

function newRun () {
  return { started: false, marks: new Map(), renders: new Map(), frames: [] }
}

function fields (parts) {
  const out = {}
  for (const p of parts) {
    const eq = p.indexOf('=')
    if (eq > 0) out[p.slice(0, eq)] = p.slice(eq + 1)
  }
  return out
}

function parse (text) {
  const runs = []
  let run = newRun()
  const used = (r) => r.started || r.marks.size > 0 || r.renders.size > 0 || r.frames.length > 0
  for (const raw of text.split('\n')) {
    const at = raw.indexOf('perf: ')
    if (at === -1) continue
    const parts = raw.slice(at + 6).trim().split(/\s+/)
    // Logcat is shared with other apps: a token the harness would never print
    // (a control or bidi character, say) drops the line, so no foreign text
    // reaches the terminal through the report.
    if (!parts.every((p) => SAFE_TOKEN.test(p))) continue
    const name = parts[0]
    if (name === 'js-entry') {
      if (used(run)) runs.push(run)
      run = newRun()
      run.started = true
    }
    if (name === 'render') {
      const count = Number(parts[2])
      const ms = Number(parts[3])
      if (!parts[1] || !Number.isFinite(count) || !Number.isFinite(ms)) continue
      const phase = fields(parts.slice(4)).phase
      const key = parts[1] + (phase ? ' phase=' + phase : '')
      const s = run.renders.get(key) || { count: 0, ms: 0 }
      s.count += count
      s.ms += ms
      run.renders.set(key, s)
    } else if (name === 'frames') {
      const f = fields(parts.slice(1))
      const row = { key: 'list=' + (f.list || '-') + ' run=' + (f.run || 'manual') }
      for (const k of FRAME_FIELDS) if (f[k] !== undefined && Number.isFinite(Number(f[k]))) row[k] = Number(f[k])
      run.frames.push(row)
    } else if (name === 'scroll-aborted') {
      // The aborted run's partial render phase is not a run sample.
      const list = fields(parts.slice(1)).list
      if (list) for (const key of [...run.renders.keys()]) if (key.endsWith(' phase=scroll:' + list)) run.renders.delete(key)
    } else if (knownMark(name)) {
      const ms = Number(parts[1])
      if (Number.isFinite(ms) && !run.marks.has(name)) run.marks.set(name, ms)
    }
  }
  if (used(run)) runs.push(run)
  return runs.some((r) => r.started) ? runs.filter((r) => r.started) : runs
}

const round = (v) => Math.round(v * 10) / 10

// Mean of rows[field] weighted by rows[weight]; a plain mean when no row has
// a weight.
function weighted (rows, field, weight) {
  const have = rows.filter((r) => r[field] !== undefined)
  if (have.length === 0) return undefined
  const total = have.reduce((a, r) => a + (r[weight] || 0), 0)
  if (total === 0) return round(have.reduce((a, r) => a + r[field], 0) / have.length)
  return round(have.reduce((a, r) => a + r[field] * (r[weight] || 0), 0) / total)
}

// One frames sample per list per run, so a run with several scroll sessions
// weighs as much as a run with one. The scripted run=scroll line wins when
// the run has it (manual lines of that list are then left out); otherwise the
// run's manual lines are combined: n, over32 and mounts summed, max the
// largest, p50 and p95 averaged weighted by n, renders per mount weighted by
// mounts. Percentiles do not merge exactly, so a combined p50/p95 is an
// approximation.
function frameSamples (run) {
  const byList = new Map()
  for (const f of run.frames) {
    const list = f.key.slice(0, f.key.indexOf(' run='))
    if (!byList.has(list)) byList.set(list, [])
    byList.get(list).push(f)
  }
  const out = []
  for (const [list, rows] of byList) {
    const scroll = rows.filter((f) => f.key === list + ' run=scroll')
    const use = scroll.length > 0 ? scroll : rows
    if (use.length === 1) {
      out.push(use[0])
      continue
    }
    const row = { key: use[0].key }
    const sum = (k) => use.some((f) => f[k] !== undefined) ? use.reduce((a, f) => a + (f[k] || 0), 0) : undefined
    const put = (k, v) => { if (v !== undefined) row[k] = v }
    put('n', sum('n'))
    put('p50', weighted(use, 'p50', 'n'))
    put('p95', weighted(use, 'p95', 'n'))
    // reduce, not Math.max(...): a spread of a huge array throws RangeError.
    put('max', use.reduce((m, f) => f.max === undefined ? m : (m === undefined || f.max > m ? f.max : m), undefined))
    put('over32', sum('over32'))
    put('mounts', sum('mounts'))
    put('rendersPerMountMedian', weighted(use, 'rendersPerMountMedian', 'mounts'))
    put('rendersPerMountP95', weighted(use, 'rendersPerMountP95', 'mounts'))
    out.push(row)
  }
  return out
}

function statLine (label, values, summary) {
  const s = summary(values)
  return label + ' n=' + s.count + ' median=' + round(s.median) + ' p95=' + round(s.p95) + ' spread=' + round(s.spread)
}

function collect (runs, each) {
  const map = new Map()
  for (const run of runs) {
    for (const [key, value] of each(run)) {
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(value)
    }
  }
  return [...map].sort((a, b) => a[0].localeCompare(b[0]))
}

// The feed prints the bare names. Every other screen suffixes the same marks.
function reopenScreen (name) {
  if (name === 'rows-snapshot' || name === 'rows-live') return 'rua'
  const snap = 'rows-snapshot:'
  const live = 'rows-live:'
  if (name.startsWith(snap) && name.length > snap.length) return name.slice(snap.length)
  if (name.startsWith(live) && name.length > live.length) return name.slice(live.length)
  return null
}

function markAt (marks, screen, kind) {
  if (screen === 'rua' && marks.has(kind)) return marks.get(kind)
  const named = kind + ':' + screen
  if (marks.has(named)) return marks.get(named)
  return null
}

function reopenDeltas (run) {
  const seen = new Set()
  const screens = []
  for (const name of run.marks.keys()) {
    const screen = reopenScreen(name)
    if (screen === null || seen.has(screen)) continue
    seen.add(screen)
    screens.push(screen)
  }
  screens.sort((a, b) => a.localeCompare(b))
  return screens.map((screen) => {
    const snap = markAt(run.marks, screen, 'rows-snapshot')
    const live = markAt(run.marks, screen, 'rows-live')
    const ready = run.marks.has('ready') ? run.marks.get('ready') : null
    const blocks = run.marks.has('blocks-ok') ? run.marks.get('blocks-ok') : null
    // A live mark before the snapshot mark comes from an earlier visit with
    // no copy: pairing them would mix two visits of the screen.
    const cached = snap !== null && (live === null || live >= snap)
    return {
      screen,
      readyToSnapshot: ready === null || !cached ? null : snap - ready,
      blocksToSnapshot: blocks === null || !cached ? null : snap - blocks,
      snapshotToLive: !cached || live === null ? null : live - snap,
      semCache: live !== null && !cached
    }
  })
}

function deltaStat (label, values, summary) {
  if (values.length === 0) return label + ' n=0'
  const s = summary(values)
  return label + ' n=' + s.count + ' median=' + round(s.median) + ' p95=' + round(s.p95)
}

function reopenLines (runs, summary) {
  const acc = new Map()
  for (const run of runs) {
    for (const row of reopenDeltas(run)) {
      if (!SAFE_TOKEN.test(row.screen)) continue
      let slot = acc.get(row.screen)
      if (!slot) {
        slot = { readyToSnapshot: [], blocksToSnapshot: [], snapshotToLive: [], semCache: 0 }
        acc.set(row.screen, slot)
      }
      if (row.readyToSnapshot !== null) slot.readyToSnapshot.push(row.readyToSnapshot)
      if (row.blocksToSnapshot !== null) slot.blocksToSnapshot.push(row.blocksToSnapshot)
      if (row.snapshotToLive !== null) slot.snapshotToLive.push(row.snapshotToLive)
      if (row.semCache) slot.semCache += 1
    }
  }
  const lines = []
  for (const screen of [...acc.keys()].sort((a, b) => a.localeCompare(b))) {
    const slot = acc.get(screen)
    lines.push('  ' + [
      screen,
      deltaStat('ready->rows-snapshot', slot.readyToSnapshot, summary),
      deltaStat('blocks-ok->rows-snapshot', slot.blocksToSnapshot, summary),
      deltaStat('rows-snapshot->rows-live', slot.snapshotToLive, summary),
      'sem cache ' + slot.semCache
    ].join(' '))
  }
  return lines
}

// summary is perfMarks.js's summary(values): { count, median, p95, spread }.
function format (runs, summary) {
  const out = ['runs: ' + runs.length, 'marks (ms since js-entry; span lengths for req:, sweep-media-cache, worklet-start)']
  for (const [name, values] of collect(runs, (r) => r.marks)) out.push('  ' + statLine(name, values, summary))
  out.push('renders per run (count and ms summed per id)')
  for (const [key, values] of collect(runs, (r) => r.renders)) {
    out.push('  ' + statLine(key + ' count', values.map((v) => v.count), summary))
    out.push('  ' + statLine(key + ' ms', values.map((v) => v.ms), summary))
  }
  out.push('frames')
  for (const [key, rows] of collect(runs, (r) => frameSamples(r).map((f) => [f.key, f]))) {
    for (const k of FRAME_FIELDS) {
      const values = rows.filter((f) => f[k] !== undefined).map((f) => f[k])
      if (values.length > 0) out.push('  ' + statLine(key + ' ' + k, values, summary))
    }
  }
  const reopen = reopenLines(runs, summary)
  if (reopen.length > 0) out.push('Reabertura', ...reopen)
  return out.join('\n')
}

function loadStats () {
  return import(pathToFileURL(path.join(__dirname, '..', 'src', 'perfMarks.js')).href)
}

if (require.main === module) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node scripts/perf-summary.js <log file>')
    process.exit(2)
  }
  loadStats().then(({ summary }) => {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      // The path is never echoed: it comes from outside and may carry
      // control characters.
      console.error('perf-summary: não foi possível ler o registro (' + (/^[A-Z]+$/.test(err.code) ? err.code : 'erro') + ')')
      process.exit(1)
    }
    console.log(format(parse(text), summary))
  }).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}

module.exports = { parse, format, frameSamples, knownMark, loadStats, SAFE_TOKEN, reopenDeltas }
