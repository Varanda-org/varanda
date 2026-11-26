'use strict'

// Source-text checks for the post frame in the Publicar composer, and runs
// of its real framing functions.

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const src = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')

const between = (start, end) => {
  const at = src.indexOf(start)
  return at < 0 ? '' : src.slice(at, src.indexOf(end, at + start.length))
}

const addFiles = between('  const addFiles = async (files, onRoom, until = Infinity) => {', '\n  const readyItem')
const readyItem = between('  const readyItem = (id, encoded) => {', '\n  // \'tentar de novo\'')
const reencode = between('  const reencode = async (id) => {', '\n  const attach = async')
const reframe = between('  const reframe = async (nextId, crops, chosen) => {', '\n  const openFrame')
const encodeFor = between('  const encodeFor = async (item, opts) => {', '\n  const dropStaged')
const removeItems = between('  const removeItems = (ids) => {', '\n  // Closing the composer')
const cleanup = between('  useEffect(() => () => {\n    genRef.current++', '}, [])')

test('attach and retry encode once, cropped to the frame, with the whole copy', (t) => {
  for (const [name, code] of [['addFiles', addFiles], ['reencode', reencode]]) {
    t.ok(/encodeFile\([^)]*\{ whole: true, cropFor: \(dims\) => cropTo\(id, initialCrop\(\), dims\) \}\)/.test(code), name + ' passes cropFor and whole: true')
  }
  t.ok(src.includes('if (frameRef.current === null) setFrame(seedFrame(null, dims))'), 'the first photo seeds the frame')
})

test('readyItem seeds a null frame and the frame resets through keepsFrame', (t) => {
  t.ok(readyItem.includes('if (frameRef.current === null) setFrame(seedFrame(null, encoded))'), 'a GIF first seeds it from its size')
  t.ok(src.includes('if (frameRef.current !== null && !keepsFrame(frameRef.current, items)) setFrame(null)'), 'an emptied draft drops the frame')
})

test('the editor gets editorPhotos(items) and a leading GIF locks the frame', (t) => {
  t.ok(src.includes('photos={editorPhotos(items)}'))
  t.ok(src.includes('lockedFrameId={leadFrame(items)}'))
  t.ok(src.includes('onApply={applyFrame}') && src.includes('onCancel={closeFrame}'))
})

test('a batch encodes one photo at a time, falls back to encodeBytes and swaps all at once', (t) => {
  t.ok(/for \(const id of ids\) \{[\s\S]*?out = await encodeFor\(item, opts\)/.test(reframe), 'serial awaits inside the loop')
  t.absent(reframe.includes('Promise.all'), 'never in parallel')
  t.ok(reframe.includes('if (gen !== genRef.current)') && reframe.includes('if (!liveRef.current.has(id)) continue'), 'the guards follow each await')
  t.ok(encodeFor.includes("if (item.cropBase === 'encoded') return { result: await encodeBytes(stillOf(item.encoded), opts)"), 'bytes already cropped stay the source')
  t.ok(encodeFor.includes('originalsRef.current.get(item.id)') && encodeFor.includes('encodeBytes(stillOf(item.whole), opts)'), 'the original, else the whole copy')
  t.ok(reframe.indexOf('if (failed) {') < reframe.indexOf('setItems('), 'nothing changes before every photo succeeded')
  t.ok(reframe.includes("setNote('não foi possível enquadrar as fotos; elas ficaram como estavam')"))
  t.is(reframe.split('setItems(').length - 1, 1, 'one swap')
})

test('whole copies and originals are freed with their photo and on unmount', (t) => {
  t.ok(/sourcesRef\.current\.delete\(id\)\s*(?:originalsRef\.current\.delete\(id\)|dropOriginal\(id\))[\s\S]*?revokeUrl\(wholesRef\.current\.get\(id\)\)\s*wholesRef\.current\.delete\(id\)/.test(removeItems))
  t.ok(cleanup.includes('for (const url of wholesRef.current.values()) revokeUrl(url)') && cleanup.includes('originalsRef.current.clear()'))
})

test('the sheet holds while the editor is open and nothing sends during a batch', (t) => {
  t.ok(src.includes('onClose={busy ? noop : framing ? closeFrame : onClose}'))
  t.ok(src.includes('dismissable={!busy && !framing}'))
  t.ok(src.includes('disabled={!valid || framing || reframing}'), 'the Publicar Pill')
  t.ok(src.includes('const sendFramed = () => (reframingRef.current ? undefined : send())') && src.includes('onPress={sendFramed}'))
  t.ok(src.includes("label={'Formato: ' + frameLabel(shownFrame)}") && src.includes("accessibilityLabel={'enquadrar fotos, formato ' + frameLabel(shownFrame)}"))
})

test('sourcesRef handling is unchanged and originals are only picked files', (t) => {
  t.ok(/if \(until === Infinity\) originalsRef\.current\.set\(id, file\)\s*readyItem\(id, encoded\)/.test(addFiles))
  t.ok(/originalsRef\.current\.set\(id, source\.file\)\s*sourcesRef\.current\.delete\(id\)\s*readyItem\(id, encoded\)\s*settleShare\(\[id\]\)/.test(reencode))
  t.ok(addFiles.includes('sourcesRef.current.set(id, { file, until })'))
})

test('the editor scrolls in its own ScrollView and a share waits for the batch', (t) => {
  t.ok(src.includes("<ScrollView key='frame' style={styles.flex} keyboardShouldPersistTaps='handled'>\n              <FrameEditor"), 'small phones reach Aplicar')
  t.ok(src.includes('!reframing && !frozen && !busy && !moment.pending)) return'), 'no share intake during a batch')
  t.ok(src.includes('}, [open, shared && shared.id, sharedAs, momentOn, canVideo, frozen, busy, moment.pending, moment.held, reframing])'), 'taken once it ends')
  t.ok(/rest\.status = 'ready'\s*rest\.error = ''\s*rest\.progress = 0/.test(reframe), 'a re-framed failed photo uploads fresh')
})

// The real cropTo .. reframe and readyItem, run on a fake encoder that
// records which source each encode read.
async function composer (wholes) {
  const { frameRect, initialCrop, isWholeRect } = await import('../src/media/crop.js')
  const { frameRatioOf, reframeIds, seedFrame } = await import('../src/frameDraft.js')
  const code = between('  // The rect of one photo in the post frame', '\n  const openFrame') + '\n' + readyItem
  const reads = []
  let url = 0
  const encode = (source, src, opts) => {
    reads.push({ source, width: src.width, height: src.height })
    const rect = opts.cropFor({ width: src.width, height: src.height })
    const out = { bytes: new Uint8Array([reads.length]), mime: 'image/jpeg', width: rect.sw, height: rect.sh }
    if (wholes.shift() !== false) out.whole = { bytes: new Uint8Array([0]), mime: 'image/jpeg', width: src.width, height: src.height }
    return out
  }
  const refs = {
    originalsRef: { current: new Map() },
    wholesRef: { current: new Map() },
    thumbsRef: { current: new Map() },
    appliedRef: { current: new Map() },
    frameRef: { current: null },
    reframingRef: { current: false },
    genRef: { current: 0 },
    liveRef: { current: new Set() }
  }
  const s = { ...refs, items: [], reads }
  const deps = {
    ...refs,
    setFrame: (next) => { s.frameRef.current = next },
    setReframing: (next) => { s.reframingRef.current = next },
    setItems: (fn) => { s.items = fn(s.items) },
    patch: (id, fields) => { s.items = s.items.map((it) => (it.id === id ? { ...it, ...fields } : it)) },
    setNote: () => {},
    urlFromBytes: () => 'blob:' + (++url),
    revokeUrl: () => {},
    discardCapture: () => {},
    encodeFile: async (file, opts) => encode('file', file, opts),
    encodeBytes: async (bytes, opts) => encode('bytes', bytes, opts),
    frameRect,
    initialCrop,
    isWholeRect,
    frameRatioOf,
    reframeIds,
    seedFrame
  }
  const build = () => new Function(...Object.keys(deps), 'items', code + '\nreturn { cropTo, reframe, readyItem }')(...Object.values(deps), s.items) // eslint-disable-line no-new-func
  s.attach = async (id, file) => {
    s.liveRef.current.add(id)
    s.items = [...s.items, { id, status: 'encoding', progress: 0, thumb: null, encoded: null, descriptor: null, error: '', crop: initialCrop(), whole: null, cropBase: 'full' }]
    const { cropTo, readyItem } = build()
    const encoded = await deps.encodeFile(file, { whole: true, cropFor: (dims) => cropTo(id, initialCrop(), dims) })
    s.originalsRef.current.set(id, file)
    readyItem(id, encoded)
  }
  s.reframe = (frameId, crops) => build().reframe(frameId, crops, true)
  return s
}

test('a crop made on cropped bytes never reaches the original file', async (t) => {
  // The uncropped copy fails at attach, so the crop is relative to the
  // cropped bytes from then on.
  const s = await composer([false, true, true])
  await s.attach('a', { width: 4000, height: 3000 })
  t.is(s.items[0].cropBase, 'encoded')
  t.absent(s.originalsRef.current.has('a'), 'readyItem forgets the original')
  await s.reframe('portrait', { a: { zoom: 1, cx: 0.5, cy: 0.5 } })
  t.is(s.items[0].cropBase, 'full')
  await s.reframe('square', { a: { zoom: 2, cx: 0.2, cy: 0.2 } })
  t.alike(s.reads.map((r) => r.source), ['file', 'bytes', 'bytes'], 'the second re-frame reads the copy of the cropped bytes')
  t.alike(s.reads[2], { source: 'bytes', width: 3000, height: 3000 })
})

test('a re-frame whose uncropped copy failed forgets the original', async (t) => {
  // A photo already in the frame's shape keeps no copy; the first re-frame
  // reads the original, and its copy fails.
  const s = await composer([true, false, true, true])
  await s.attach('a', { width: 3000, height: 3000 })
  t.is(s.items[0].cropBase, 'full')
  t.ok(s.originalsRef.current.has('a'), 'an uncropped photo keeps its original')
  await s.reframe('portrait', { a: { zoom: 1, cx: 0.5, cy: 0.5 } })
  t.is(s.items[0].cropBase, 'encoded')
  t.absent(s.originalsRef.current.has('a'), 'the swap forgets it')
  await s.reframe('landscape', { a: { zoom: 1, cx: 0.5, cy: 0.5 } })
  await s.reframe('square', { a: { zoom: 2, cx: 0.2, cy: 0.2 } })
  t.alike(s.reads.map((r) => r.source), ['file', 'file', 'bytes', 'bytes'])
})

test('a re-frame of bytes already cropped forgets the original', async (t) => {
  const s = await composer([true])
  const encoded = { bytes: new Uint8Array([1]), mime: 'image/jpeg', width: 3000, height: 3000 }
  s.frameRef.current = { id: 'square', chosen: true }
  s.liveRef.current.add('a')
  s.items = [{ id: 'a', status: 'ready', progress: 0, thumb: 'blob:a', encoded, descriptor: null, error: '', crop: { zoom: 1, cx: 0.5, cy: 0.5 }, whole: null, cropBase: 'encoded' }]
  s.originalsRef.current.set('a', { width: 4000, height: 3000 })
  await s.reframe('portrait', { a: { zoom: 1, cx: 0.5, cy: 0.5 } })
  t.is(s.items[0].cropBase, 'full', 'its new crop is on a copy of the cropped bytes')
  t.absent(s.originalsRef.current.has('a'))
  t.absent('keep' in s.items[0])
  t.absent('keptUri' in s.items[0])
})
