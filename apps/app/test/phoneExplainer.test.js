'use strict'

// The one-launch phone explainer (src/phoneExplainer.js). TelefoneAviso is
// read as text: importing the screen would load the UI kit.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/phoneExplainer.js')

const TITLE = 'Agora a Varanda usa o seu celular'
const POINTS = [
  'O número não é a sua identidade na rede e não aparece no perfil, no diário nem no certificado.',
  'O número não serve para recuperar a conta.',
  'A associação só entrega o número com ordem judicial ou a seu próprio pedido.',
  'Enquanto durar um bloqueio, o mesmo número não pode ser usado em outra conta.',
  'O número fica guardado lacrado no Brasil.',
  'O número fica lacrado por até 180 dias depois de excluir a conta e então é apagado.',
  'O seu @nome e as suas postagens continuam iguais.'
]
const CONTINUE_LABEL = 'Confirmar meu celular'
const DELETE_LABEL = 'Excluir minha conta'

// String literals are kept whole, so a '//' inside a text never hides code.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

test('EXPLAINER pins the title, every point and both buttons', async (t) => {
  const mod = await load()
  t.alike(Object.keys(mod.EXPLAINER), ['title', 'points'])
  t.is(mod.EXPLAINER.title, TITLE)
  t.alike(mod.EXPLAINER.points, POINTS)
  t.is(mod.EXPLAINER.points.length, 7)
  for (const point of POINTS) t.ok(mod.EXPLAINER.points.includes(point), point)
  t.is(mod.CONTINUE_LABEL, CONTINUE_LABEL)
  t.is(mod.DELETE_LABEL, DELETE_LABEL)
  const visible = [TITLE, ...POINTS, CONTINUE_LABEL, DELETE_LABEL]
  t.absent(visible.some((text) => text.includes('\u2014')), 'no em dash')
  t.ok(Object.isFrozen(mod.EXPLAINER))
  t.ok(Object.isFrozen(mod.EXPLAINER.points))
})

test('showExplainer is true only for a hosted linked member who needs the phone and has not acknowledged', async (t) => {
  const { showExplainer } = await load()
  const hostedValues = [true, false, undefined, null, 0, 1, 'true', 'hosted']
  const linkedValues = [true, false, undefined, null, 0, 1, 'true']
  const gateValues = ['needed', 'ok', 'off', 'loading', undefined, null, '', 'needed ', 'Needed', true, false, 'pendente']
  const ackValues = [false, undefined, null, true, 0, 1, '', 'true', 'false']
  for (const hosted of hostedValues) {
    for (const linked of linkedValues) {
      for (const gate of gateValues) {
        for (const acknowledged of ackValues) {
          const input = { hosted, linked, gate, acknowledged }
          const expected = hosted === true && linked === true && gate === 'needed' && acknowledged !== true
          t.is(showExplainer(input), expected, JSON.stringify(input))
        }
      }
    }
  }
  t.is(showExplainer(), false, 'omitted')
  t.is(showExplainer({}), false, 'empty')
  t.is(showExplainer({ hosted: true }), false, 'hosted alone')
  t.is(showExplainer({ hosted: true, linked: true }), false, 'hosted and linked')
  t.is(showExplainer({ hosted: true, linked: true, gate: 'needed' }), true, 'acknowledgement omitted')
  t.is(showExplainer({ hosted: true, linked: true, gate: 'needed', acknowledged: false, extra: 1 }), true, 'extra field ignored')
  t.is(showExplainer({ hosted: true, linked: true, gate: 'needed', acknowledged: true }), false, 'acknowledged this launch')
})

test('phoneExplainer stays pure', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/phoneExplainer.js'), 'utf8')
  t.absent(/^import /m.test(src), 'imports nothing')
  t.absent(/\b(react|react-native|Platform|localStorage|sessionStorage|AsyncStorage|console)\b/.test(src))
  t.absent(src.includes('\u2014'))
  const { showExplainer } = await load()
  t.is(typeof showExplainer, 'function')
})

test('TelefoneAviso renders the explainer and keeps the acknowledgement with the caller', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/TelefoneAviso.js'), 'utf8')
  const code = withoutComments(src)
  t.ok(code.includes("from '../phoneExplainer'"))
  t.ok(code.includes('title={EXPLAINER.title}'))
  t.ok(code.includes('EXPLAINER.points.map'))
  t.ok(code.includes('<Btn key=\'continue\' label={CONTINUE_LABEL} onPress={onContinue} block large />'))
  t.ok(code.includes('<Btn key=\'delete\' label={DELETE_LABEL} secondary onPress={onDelete} block large />'))
  t.ok(code.includes('function TelefoneAviso ({ onContinue, onDelete })'))
  t.absent(code.includes('useState'), 'acknowledgement stays in the caller')
  t.absent(code.includes('Platform'))
  for (const api of [
    'window.location',
    'document.createElement',
    'document.body',
    'document.addEventListener',
    'document.visibilityState',
    'document.getElementById',
    'document.createRange',
    'crypto.subtle',
    'globalThis.open(',
    'globalThis.document',
    'globalThis.navigator',
    'localStorage',
    'sessionStorage',
    'AsyncStorage',
    'navigator.',
    'window.',
    'document.',
    'console.'
  ]) {
    t.absent(code.includes(api), api)
  }
  t.absent(src.includes('\u2014'))
  for (const point of POINTS) t.absent(src.includes(point), 'points live in the pure module')
  t.absent(src.includes(CONTINUE_LABEL))
  t.absent(src.includes(DELETE_LABEL))
  t.absent(src.includes(TITLE))
})
