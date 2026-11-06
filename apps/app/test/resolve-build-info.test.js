'use strict'

const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { applyBuildInfo, BUILD_DATE_RE } = require('../scripts/resolve-build-info')

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const MODULE = path.join(__dirname, '..', 'scripts', 'resolve-build-info.js')
const ROOT = process.env.VARANDA_TEST_TMPDIR || fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-bi-'))

let n = 0
function dir (withGit) {
  const d = path.join(ROOT, 'd' + n++)
  fs.mkdirSync(d, { recursive: true })
  if (withGit === 'dir') fs.mkdirSync(path.join(d, '.git'))
  if (withGit === 'file') fs.writeFileSync(path.join(d, '.git'), 'gitdir: /elsewhere\n')
  return d
}

function run (env, opts = {}) {
  const calls = []
  const execFileSync = opts.exec || ((...args) => { calls.push(args); return C + '\n' })
  const realWrite = process.stderr.write
  const lines = []
  process.stderr.write = (s) => { lines.push(String(s)); return true }
  let out
  try {
    out = applyBuildInfo({
      env,
      repoRoot: opts.repoRoot === undefined ? dir() : opts.repoRoot,
      now: opts.now || (() => new Date('2026-11-05T10:20:30.456Z')),
      execFileSync
    })
  } finally { process.stderr.write = realWrite }
  return { out, calls, lines }
}

test('explicit public commit wins over EAS and git', (t) => {
  const env = { EXPO_PUBLIC_VARANDA_COMMIT: A, EAS_BUILD_GIT_COMMIT_HASH: B }
  const r = run(env, { repoRoot: dir('dir') })
  t.is(r.out.commit, A)
  t.is(env.EXPO_PUBLIC_VARANDA_COMMIT, A)
  t.is(r.calls.length, 0)
})

test('invalid explicit public value falls through to EAS', (t) => {
  const r = run({ EXPO_PUBLIC_VARANDA_COMMIT: 'nope', EAS_BUILD_GIT_COMMIT_HASH: B })
  t.is(r.out.commit, B)
})

test('uppercase EAS hash is lowercased', (t) => {
  const r = run({ EAS_BUILD_GIT_COMMIT_HASH: B.toUpperCase() })
  t.is(r.out.commit, B)
})

test('EAS value that is not a hash falls through to git', (t) => {
  const r = run({ EAS_BUILD_GIT_COMMIT_HASH: 'xyz' }, { repoRoot: dir('dir') })
  t.is(r.out.commit, C)
  t.is(r.calls.length, 1)
  t.is(r.calls[0][0], 'git')
})

test('no .git means no git call and an empty commit', (t) => {
  const env = {}
  const r = run(env)
  t.is(r.out.commit, '')
  t.is(r.calls.length, 0)
  t.is(env.EXPO_PUBLIC_VARANDA_COMMIT, '')
})

test('a .git file (worktree) still calls git', (t) => {
  const root = dir('file')
  const r = run({}, { repoRoot: root })
  t.is(r.calls.length, 1)
  t.alike(r.calls[0][1], ['-C', root, 'rev-parse', '--verify', 'HEAD'])
  t.is(r.out.commit, C)
})

test('git stdout that is not 40 hex plus LF gives an empty commit', (t) => {
  for (const out of [C, C + '\n\n', 'HEAD\n', '']) {
    const r = run({}, { repoRoot: dir('dir'), exec: () => out })
    t.is(r.out.commit, '')
  }
})

test('a throwing git gives an empty commit without throwing', (t) => {
  const r = run({}, { repoRoot: dir('dir'), exec: () => { throw new Error('boom') } })
  t.is(r.out.commit, '')
  t.is(r.lines.join(''), 'build-info: commit desconhecido\n')
})

test('build date: valid explicit kept, invalid replaced without milliseconds', (t) => {
  const kept = run({ EXPO_PUBLIC_VARANDA_BUILD_DATE: '2026-01-02T03:04:05Z' })
  t.is(kept.out.builtAt, '2026-01-02T03:04:05Z')
  const env = { EXPO_PUBLIC_VARANDA_BUILD_DATE: 'yesterday' }
  const replaced = run(env)
  t.is(replaced.out.builtAt, '2026-11-05T10:20:30Z')
  t.is(env.EXPO_PUBLIC_VARANDA_BUILD_DATE, '2026-11-05T10:20:30Z')
  t.ok(BUILD_DATE_RE.test(replaced.out.builtAt))
})

test('writes exactly one stderr line', (t) => {
  const r = run({ EXPO_PUBLIC_VARANDA_COMMIT: A })
  t.alike(r.lines, ['build-info: commit ' + A + '\n'])
  const cwd = dir()
  const child = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(MODULE) + ').applyBuildInfo({ repoRoot: process.cwd() })'], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH }
  })
  t.is(child.status, 0)
  t.is(child.stdout, '')
  t.is(child.stderr, 'build-info: commit desconhecido\n')
})

test('metro.config.js stamps the build info before the config and keys the cache', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'metro.config.js'), 'utf8')
  const apply = src.indexOf('applyBuildInfo(')
  t.ok(apply !== -1)
  t.ok(apply < src.indexOf('getDefaultConfig(__dirname)'))
  t.ok(src.includes('config.cacheVersion'))
})
