'use strict'

// Avaliar rating stars: icons, not characters; chosen differs by shape.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
const screen = read('screens/Avaliar.js')
const icons = read('ui/Icon.js')

test('stars are estrela icons at 36 inside 44 pt targets', (t) => {
  t.ok(screen.includes("<Icon name='estrela' size={36} filled={n <= stars}"), 'icon at 36, filled when chosen')
  t.absent(/[★☆]/.test(screen.replace(/^\/\/.*$/gm, '')), 'no star characters in code')
  t.ok(/star: \{ minWidth: 44, minHeight: 44/.test(screen), '44 pt target')
})

test('radio semantics, checked state and haptic stay', (t) => {
  t.ok(screen.includes("accessibilityRole='radio'"), 'role radio')
  t.ok(screen.includes('accessibilityState={{ checked: stars === n }}'), 'checked state')
  t.ok(screen.includes("tap('select')"), 'select haptic on change')
  t.ok(screen.includes('setStars(n)'), 'value is 1 to 5')
})

test('estrela has a solid variant so selection is not colour-only', (t) => {
  t.ok(/name === 'estrela' && filled\) \{\s*return <Ionicons name='star'/.test(icons), 'filled star is Ionicons solid')
  t.ok(icons.includes("estrela: 'star'"), 'outline stays Feather')
})

// Acting as a Page, Avaliar reads the page's own thread and rates as it.
function slice (name) {
  const match = screen.match(new RegExp('async function ' + name + ' \\([^]*?\\n\\}'))
  if (!match) throw new Error('missing helper: ' + name)
  const max = screen.match(/const MAX_THREAD_PAGES = \d+/)[0]
  // eslint-disable-next-line no-new-func
  return new Function(max + '\n' + match[0] + '\nreturn ' + name)()
}

test('a page reads its own thread: dm.thread carries page on every request', async (t) => {
  const readThread = slice('readThread')
  const calls = []
  const pages = [{ messages: [{ id: 'b', text: '2' }], next: 'n1' }, { messages: [{ id: 'a', text: '1' }] }]
  const request = async (method, params) => {
    calls.push([method, params])
    return pages[calls.length - 1]
  }
  const messages = await readThread(request, 'peer', 'pagekey')
  t.alike(calls, [['dm.thread', { peer: 'peer', page: 'pagekey' }], ['dm.thread', { peer: 'peer', before: 'n1', page: 'pagekey' }]])
  t.alike(messages.map((m) => m.id), ['a', 'b'], 'oldest first')
  calls.length = 0
  await readThread(request, 'peer', null)
  t.alike(calls[0], ['dm.thread', { peer: 'peer' }], 'a person sends no page')
  t.ok(screen.includes('readThread(request, author, page)'), 'the screen passes the acting page')
})

test('the Avaliar gate rates as the page, never refusing a page outright', (t) => {
  t.ok(screen.includes('const page = asPage ? actingPage : null'))
  t.ok(screen.includes('const rater = asPage ? actingPage : me'), 'the rater is the page acted as')
  t.ok(screen.includes('offerState(messages, rater, { author, seq }, origin)'), 'the offer is read for the rater')
  t.ok(screen.includes('canRate({ offer, listing, me: rater })'), 'the gate checks the rater')
  t.ok(screen.includes('rateCall({ offer, listing, me: rater, page, stars, text })'), 'the call carries the page')
  t.absent(/!asPage/.test(screen), 'no page refusal in the gate')
  t.absent(screen.includes('PAGE_NO_RATE'), 'the v1 page notice is gone')
  t.ok(screen.includes('actAs(n, { member: await memberKeyOf(n.request, n), action: call.action, page: call.page, op: call.op })'), 'a page call goes through actAs')
})
