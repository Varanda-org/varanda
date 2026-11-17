'use strict'

// apps/cli/scripts/sentinel-nli-fixture.js: the pure helpers, the --out
// confinement, the file hashing and the pinned tables. The script itself needs
// the real models and is never run here.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('brittle')
const { MODELS, CASES, LABELS, OUT_NAME, inside, realish, resolveOut, hashFile, verifyModel, round6, argmax } = require('../scripts/sentinel-nli-fixture')

// A temp dir with an allowed/ directory (where the fixture may go) and an
// outside/ one, removed after the test.
function sandbox (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-fixture-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const allowed = path.join(root, 'allowed')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(allowed)
  fs.mkdirSync(outside)
  return { root, allowed, outside }
}

test('argmax picks the label of the largest logit', (t) => {
  t.is(argmax([2.5, -1, 0]), 'entailment')
  t.is(argmax([0, 1, -3]), 'neutral')
  t.is(argmax([-4, -3, 0.1]), 'contradiction')
  t.is(LABELS.length, 3)
})

test('round6 keeps six decimals', (t) => {
  t.is(round6(0.12345678), 0.123457)
  t.is(round6(-1.0000004), -1)
})

test('inside tells a child path from an outside one', (t) => {
  const root = path.resolve('/a/b')
  t.ok(inside(path.join(root, 'c', 'd'), root))
  t.ok(inside(root, root))
  t.absent(inside(path.resolve('/a/bc'), root))
  t.absent(inside(path.resolve('/a'), root))
})

test('the pinned models are complete and the cases are fixed and neutral', (t) => {
  t.alike(MODELS.map((m) => m.key), ['minilm', 'mdeberta'])
  for (const m of MODELS) {
    t.ok(/^[0-9a-f]{40}$/.test(m.revision), m.key + ' revision')
    t.ok(/^[0-9a-f]{64}$/.test(m.sha256), m.key + ' sha256')
    t.ok(/^[0-9a-f]{64}$/.test(m.tokenizerSha256), m.key + ' tokenizer sha256')
    t.ok(/^[0-9a-f]{64}$/.test(m.configSha256), m.key + ' config sha256')
    t.ok(/^[0-9a-f]{64}$/.test(m.tokenizerConfigSha256), m.key + ' tokenizer_config sha256')
    t.ok(Number.isSafeInteger(m.bytes) && m.bytes > 0, m.key + ' bytes')
    t.is(m.file, 'onnx/model_quantized.onnx')
  }
  t.is(CASES.length, 6)
  t.is(new Set(CASES.map((c) => c.name)).size, CASES.length)
  for (const c of CASES) t.ok(c.premise && c.hypothesis, c.name)
})

test('resolveOut accepts only <allowed dir>/nliFixture.json', (t) => {
  const { allowed } = sandbox(t)
  const ok = path.join(allowed, OUT_NAME)
  t.is(OUT_NAME, 'nliFixture.json')
  // The file need not exist yet; neither need the directory below the allowed one.
  t.is(resolveOut(ok, allowed), ok)
  t.is(resolveOut(path.join(allowed, 'sub', '..', OUT_NAME), allowed), ok)
  fs.writeFileSync(ok, '{}')
  t.is(resolveOut(ok, allowed), ok, 'an existing regular file is fine')
  t.is(realish(path.join(allowed, 'nope', 'x')), path.join(fs.realpathSync(allowed), 'nope', 'x'))
})

test('resolveOut refuses another file name, even inside the allowed dir', (t) => {
  const { allowed } = sandbox(t)
  t.exception(() => resolveOut(path.join(allowed, 'other.json'), allowed), /nliFixture\.json/)
  t.exception(() => resolveOut(path.join(allowed, 'bench.js'), allowed))
  t.exception(() => resolveOut(allowed, allowed), /nliFixture\.json/)
})

test('resolveOut refuses a path outside the allowed dir', (t) => {
  const { allowed, outside, root } = sandbox(t)
  t.exception(() => resolveOut(path.join(outside, OUT_NAME), allowed))
  t.exception(() => resolveOut(path.join(root, OUT_NAME), allowed))
  t.exception(() => resolveOut(path.join(allowed, '..', OUT_NAME), allowed))
  // A sibling whose name merely starts with the allowed dir's.
  const sibling = allowed + '-x'
  fs.mkdirSync(sibling)
  t.exception(() => resolveOut(path.join(sibling, OUT_NAME), allowed))
})

test('resolveOut refuses a symlink: to a file, dangling, or a directory that leaves', (t) => {
  const { allowed, outside } = sandbox(t)
  const target = path.join(outside, 'victim.txt')
  fs.writeFileSync(target, 'keep')
  const link = path.join(allowed, OUT_NAME)

  fs.symlinkSync(target, link)
  t.exception(() => resolveOut(link, allowed), 'a link to a file outside')
  fs.unlinkSync(link)

  const inner = path.join(allowed, 'real.json')
  fs.writeFileSync(inner, '{}')
  fs.symlinkSync(inner, link)
  t.exception(() => resolveOut(link, allowed), /link simb/, 'a link to a file inside is still a link')
  fs.unlinkSync(link)

  fs.symlinkSync(path.join(outside, 'missing.json'), link)
  t.exception(() => resolveOut(link, allowed), /link simb/, 'a dangling link')
  fs.unlinkSync(link)

  // The allowed dir itself reached through a link, and a link below it that
  // leaves it.
  const leave = path.join(allowed, 'leave')
  fs.symlinkSync(outside, leave)
  t.exception(() => resolveOut(path.join(leave, OUT_NAME), allowed), 'a directory link out of the allowed dir')
  t.is(fs.readFileSync(target, 'utf8'), 'keep')
})

test('resolveOut follows a symlinked allowed dir to the same real place', (t) => {
  const { root, allowed } = sandbox(t)
  const alias = path.join(root, 'alias')
  fs.symlinkSync(allowed, alias)
  const out = path.join(alias, OUT_NAME)
  t.is(resolveOut(out, allowed), out)
})

test('hashFile streams the size and sha256 of a regular file and refuses a symlink or a directory', (t) => {
  const { allowed, outside } = sandbox(t)
  const file = path.join(allowed, 'a.bin')
  // More than one 1 MiB read, so the streaming loop runs more than once.
  const data = crypto.randomBytes((1 << 20) + 12345)
  fs.writeFileSync(file, data)
  const got = hashFile(file)
  t.is(got.bytes, data.length)
  t.is(got.sha256, crypto.createHash('sha256').update(data).digest('hex'))

  const empty = path.join(allowed, 'empty.bin')
  fs.writeFileSync(empty, '')
  t.alike(hashFile(empty), { bytes: 0, sha256: crypto.createHash('sha256').digest('hex') })

  const link = path.join(outside, 'link.bin')
  fs.symlinkSync(file, link)
  t.exception(() => hashFile(link), 'a symlink is never followed')
  t.exception(() => hashFile(allowed), 'a directory')
  t.exception(() => hashFile(path.join(allowed, 'missing.bin')), 'a missing file')
})

// A case-insensitive filesystem (default macOS) resolves a case variant of a
// path to the same directory: it must still count as inside.
test('realish returns the on-disk spelling, so a case variant stays inside', (t) => {
  const { allowed } = sandbox(t)
  const variant = path.join(path.dirname(allowed), 'ALLOWED')
  if (!fs.existsSync(variant)) {
    t.pass('case-sensitive filesystem, nothing to check')
    return
  }
  t.ok(inside(realish(path.join(variant, 'x.json')), realish(allowed)))
})

test('verifyModel checks the model, tokenizer, config and tokenizer_config pins', (t) => {
  const { root } = sandbox(t)
  const files = { 'onnx/model_quantized.onnx': 'model', 'tokenizer.json': 'tok', 'config.json': 'cfg', 'tokenizer_config.json': 'tokcfg' }
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
  const spec = {
    key: 'fake',
    id: 'org/fake',
    file: 'onnx/model_quantized.onnx',
    bytes: 5,
    sha256: sha('model'),
    tokenizerSha256: sha('tok'),
    configSha256: sha('cfg'),
    tokenizerConfigSha256: sha('tokcfg')
  }
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, spec.id, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, body)
  }
  verifyModel(root, spec)
  t.pass('all four pins match')
  for (const rel of Object.keys(files)) {
    const f = path.join(root, spec.id, rel)
    const keep = fs.readFileSync(f)
    fs.writeFileSync(f, Buffer.concat([keep.subarray(0, keep.length - 1), Buffer.from('X')]))
    t.exception(() => verifyModel(root, spec), 'tampered ' + rel)
    fs.writeFileSync(f, keep)
  }
})
