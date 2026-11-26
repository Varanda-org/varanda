'use strict'

/* eslint-disable no-new-func */

const test = require('brittle')
const load = () => import('../src/postEdit.js')

test('edit minimum: only media without a quote admits empty text', async (t) => {
  const { minEditText, canSaveEdit } = await load()
  for (const post of [{}, { media: [] }, { media: 'photo' }, { media: [{}], quote: { author: 'a', seq: 1 } }]) {
    t.is(minEditText(post), 1)
    t.absent(canSaveEdit('', post, 'before'))
  }
  t.is(minEditText({ media: [{}] }), 0)
  t.ok(canSaveEdit('', { media: [{}] }, 'before'))
  t.ok(canSaveEdit(' ', {}, 'before'), 'no implicit trimming')
})

test('edit counts code points and requires a different text', async (t) => {
  const { canSaveEdit } = await load()
  t.ok(canSaveEdit('🙂'.repeat(1000), {}, 'before'))
  t.absent(canSaveEdit('🙂'.repeat(1001), {}, 'before'))
  t.ok(canSaveEdit('a'.repeat(1000), {}, 'before'))
  t.absent(canSaveEdit('a'.repeat(1001), {}, 'before'))
  t.absent(canSaveEdit('same', {}, 'same'))
  t.absent(canSaveEdit('', { media: [{}] }, ''))
  t.ok(canSaveEdit('same ', {}, 'same'))
  t.ok(canSaveEdit('e\u0301', {}, 'é'), 'no implicit normalization')
  for (const value of [null, undefined, 3, [], {}]) t.absent(canSaveEdit(value, {}, 'before'))
})

test('edit accepts newlines and refuses the record control characters', async (t) => {
  const { canSaveEdit } = await load()
  t.ok(canSaveEdit('linha\noutra linha', {}, 'before'))
  const forbidden = [
    ...Array.from({ length: 32 }, (_, cp) => cp).filter((cp) => cp !== 10),
    ...Array.from({ length: 33 }, (_, cp) => 0x7f + cp),
    0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2066, 0x2067, 0x2068, 0x2069
  ]
  for (const cp of forbidden) t.absent(canSaveEdit('a' + String.fromCodePoint(cp) + 'b', {}, 'before'), cp.toString(16))
})

const fs = require('fs')
const path = require('path')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

function functionOf (source, name) {
  const start = source.indexOf('function ' + name + ' (')
  return source.slice(start, source.indexOf('\n}', start) + 2)
}

test('own diary post caching carries the entry flag without mutating the record', (t) => {
  const source = read('screens/Diario.js')
  const postOf = new Function(functionOf(source, 'postOf') + '\nreturn postOf')()
  const ownPostOf = new Function('postOf', 'ownPosts', functionOf(source, 'ownPostOf') + '\nreturn ownPostOf')(postOf, new WeakMap())
  const record = Object.freeze({ type: 'post', text: 'Agora', at: '2026-11-26T12:00:00Z' })
  const plain = ownPostOf('a'.repeat(64), 3, record)
  const edited = ownPostOf('a'.repeat(64), 3, record, true)
  t.is(plain.edited, false)
  t.is(edited.edited, true)
  t.is(edited.text, 'Agora')
  t.not(edited, plain)
  t.is(ownPostOf('a'.repeat(64), 3, record, true), edited)
  t.is(postOf('a'.repeat(64), 3, record, 'true').edited, false)
  t.absent('edited' in record)
})

function sheetSave (values) {
  const source = read('ui/EditPostSheet.js')
  const start = source.indexOf('  const save = async () => {')
  const body = source.slice(start, source.indexOf('\n  return (', start))
  return new Function(...Object.keys(values), body + '\nreturn save')(...Object.values(values))
}

function actionHook () {
  const source = read('ui/index.js')
  const hook = new Function('useState', 'useRef', 'useCallback', 'errorText', functionOf(source, 'useAction') + '\nreturn useAction')(
    (value) => [value, () => {}], (current) => ({ current }), (fn) => fn, (error) => error.message
  )
  return hook()
}

test('edit sheet submits once through useAction, even on a double tap', async (t) => {
  const target = { ref: 'a'.repeat(64) + ':3', text: 'Antes' }
  const calls = []
  const edited = []
  let finish
  const save = sheetSave({
    target,
    text: 'Depois',
    ready: true,
    action: actionHook(),
    request: (method, params) => {
      calls.push({ method, params })
      return new Promise((resolve) => { finish = resolve })
    },
    onEdited: (result) => edited.push(result),
    setUncertain: () => t.fail('not uncertain'),
    onUncertain: () => t.fail('not uncertain')
  })
  const first = save()
  await save()
  t.alike(calls, [{ method: 'post.edit', params: { to: target.ref, text: 'Depois' } }])
  finish({ seq: 8, ref: target.ref, changed: true })
  await first
  t.alike(edited, [{ seq: 8, ref: target.ref, text: 'Depois' }])
})

test('edit sheet refuses or reports uncertainty without automatically resending', async (t) => {
  for (const uncertain of [false, true]) {
    let calls = 0
    let locked = false
    let checks = 0
    const values = {
      target: { ref: 'a'.repeat(64) + ':3', text: 'Antes' },
      text: 'Depois',
      ready: true,
      action: actionHook(),
      request: async () => {
        calls++
        throw Object.assign(new Error('recusado'), { uncertain })
      },
      onEdited: () => t.fail('failed edit is not applied locally'),
      setUncertain: (value) => { locked = value },
      onUncertain: () => { checks++ }
    }
    await sheetSave(values)()
    t.is(calls, 1)
    t.is(locked, uncertain)
    t.is(checks, uncertain ? 1 : 0)
    if (uncertain) {
      await sheetSave({ ...values, ready: !locked })()
      t.is(calls, 1, 'disabled until the sheet is closed and the post checked')
    }
  }
  const source = read('ui/EditPostSheet.js')
  t.ok(source.includes('useState(target.text)'), 'the draft starts with raw current text')
  t.ok(source.includes('<ErrorText>{action.error}</ErrorText>'), 'useAction displays the existing uncertain message')
  t.ok(source.includes('!uncertain && canSaveEdit(text, target, target.text)'))
})

test('edited record drops a link card whose url left the text', async (t) => {
  const { editedRecord } = await load()
  const card = { url: 'https://example.com/a', host: 'example.com', title: 'T' }
  const record = { type: 'post', text: 'Veja https://example.com/a', at: 'x', preview: card }
  const kept = editedRecord(record, 'Ainda https://example.com/a')
  t.alike(kept.preview, card)
  t.is(kept.text, 'Ainda https://example.com/a')
  const gone = editedRecord(record, 'Sem link')
  t.absent('preview' in gone)
  t.is(gone.at, 'x', 'other fields kept')
  t.alike(record.preview, card, 'input not mutated')
  t.alike(editedRecord({ type: 'post', text: 'a', preview: null }, 'b').preview, null)
})
