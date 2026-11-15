'use strict'

// A send that came back uncertain stays on screen as the sender's own faded
// bubble (never as delivered), with the composer free for a new message.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const count = (s, needle) => s.split(needle).length - 1

test('heldBubble: the held text as an own uncertain item, nothing without text', async (t) => {
  const { heldBubble, sendPlan } = await import('../src/dm-screen.js')
  const item = heldBubble({ text: 'oi', quoteId: null, at: 1000 })
  t.is(item.text, 'oi')
  t.is(item.rawText, 'oi')
  t.is(item.at, 1000)
  t.is(item.status, 'uncertain')
  t.is(heldBubble(null), null)
  t.is(heldBubble({ text: '' }), null)
  // The composer is empty now: a new text is compared with the held one.
  const hold = { text: 'oi', quoteId: null }
  t.is(sendPlan(hold, 'outra', null), 'confirm', 'a different text asks first')
  t.is(sendPlan(hold, 'oi', null), 'retry')
})

test('the uncertain bubble shows Enviada with its time and is faded, never delivered', (t) => {
  const bubble = read('ui/Bubble.js')
  t.ok(bubble.includes("status === 'uncertain' && styles.faded"))
  t.ok(/faded: \{ opacity: 0\.7 \}/.test(bubble))
  t.ok(bubble.includes("(status === 'pending' || status === 'uncertain')"), 'the meta prefix stays')
  t.absent(bubble.includes('Entregue'))
})

test('Mensagem: an uncertain send clears the composer and the held text is a faded bubble at the end', (t) => {
  const src = read('screens/Mensagem.js')
  const at = src.indexOf('setHold({ text, quoteId, card, typed, ctx, at: Date.now()')
  t.ok(at > 0, 'the hold keeps its time')
  const before = src.slice(at - 420, at)
  t.ok(before.includes("setDraft((d) => (d === text || d === typed || (followed && d === followed.text) ? '' : d))"), 'the composer is cleared first')
  t.ok(src.includes("<Bubble item={heldBubble(hold)} mine status='uncertain' shape='single' />"))
  t.ok(src.includes('ListFooterComponent={hold || reactionError'), 'the bubble ends the list')
  const footer = src.slice(src.indexOf('ListFooterComponent'), src.indexOf('ListHeaderComponent'))
  t.is(count(footer, '{LABELS.uncertain}'), 1, 'the uncertain line is under the bubble')
  t.ok(footer.includes("label='Tentar de novo'") && footer.includes("label='descartar'"), 'with both pills')
  t.absent(src.includes('{hold\n          ? (\n            <View style={styles.inline}>'), 'and no longer above the composer')
  t.ok(src.includes('const plan = sendPlan(hold, attempt, quoteId)') && src.includes("if (plan === 'confirm') setAskNew(true)"), 'a new draft still asks first')
  t.absent(/setHold\(\{[^}]*\}\)\s*\n\s*send\(/.test(src), 'no automatic resend')
})

test('no em dash in the sources and the test', (t) => {
  for (const f of ['screens/Mensagem.js', 'screens/Grupo.js', 'ui/Bubble.js', 'dm-screen.js']) t.absent(read(f).includes(String.fromCharCode(0x2014)), f)
  t.absent(fs.readFileSync(__filename, 'utf8').includes(String.fromCharCode(0x2014)))
})
