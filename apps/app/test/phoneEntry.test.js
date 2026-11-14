'use strict'

// The phone code field (src/phoneEntry.js) and its wiring in the Telefone
// screen, read as text: importing the screen would load the UI kit.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/phoneEntry.js')
const SCREEN = path.join(__dirname, '../src/screens/Telefone.js')

// String literals are kept whole, so a '//' inside a text never hides code.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const count = (s, part) => s.split(part).length - 1

test('cellsOf: one entry per cell, digits only', async (t) => {
  const { cellsOf, CODE_LENGTH } = await load()
  t.is(CODE_LENGTH, 6)
  t.alike(cellsOf(''), ['', '', '', '', '', ''])
  t.alike(cellsOf('1'), ['1', '', '', '', '', ''])
  t.alike(cellsOf('123'), ['1', '2', '3', '', '', ''])
  t.alike(cellsOf('123456'), ['1', '2', '3', '4', '5', '6'])
  t.alike(cellsOf('1234567890'), ['1', '2', '3', '4', '5', '6'], 'extra digits are not drawn')
  t.alike(cellsOf('1a2-3'), ['1', '2', '3', '', '', ''], 'only digits are drawn')
  t.alike(cellsOf('12', 4), ['1', '2', '', ''])
  t.alike(cellsOf('123456', 4), ['1', '2', '3', '4'])
  for (const bad of [undefined, null, 123456, {}, ['1']]) t.alike(cellsOf(bad), ['', '', '', '', '', ''], String(bad))
  for (const n of [0, -1, 2.5, '6', null]) t.is(cellsOf('12', n).length, 6, 'bad size ' + String(n))
})

test('shouldAutoSubmit: only six digits, not the last checked, while not locked', async (t) => {
  const { shouldAutoSubmit } = await load()
  t.is(shouldAutoSubmit({ code: '123456', last: null, locked: false }), true)
  t.is(shouldAutoSubmit({ code: '123456', last: '654321', locked: false }), true, 'a different code')
  t.is(shouldAutoSubmit({ code: '123456', last: '123456', locked: false }), false, 'the same code twice')
  t.is(shouldAutoSubmit({ code: '123456', last: null, locked: true }), false, 'locked (busy, waiting, awaiting or offline)')
  for (const locked of [undefined, null, 0, '', 'false', 1, true]) {
    t.is(shouldAutoSubmit({ code: '123456', last: null, locked }), false, 'locked ' + JSON.stringify(locked))
  }
  for (const code of ['', '1', '12345', '1234567', '12345a', ' 123456', '123456 ', '12 456', '１２３４５６', undefined, null, 123456, {}]) {
    t.is(shouldAutoSubmit({ code, last: null, locked: false }), false, 'code ' + JSON.stringify(code))
  }
  t.is(shouldAutoSubmit(), false, 'omitted')
  t.is(shouldAutoSubmit({}), false, 'empty')
})

// The screen's edit handler, reduced to its decision: every edit may check,
// and a check records the code. One check per completed code, none while
// locked, nothing again after an error until the code changes.
test('an edit sequence sends at most one check per completed code', async (t) => {
  const { shouldAutoSubmit } = await load()
  const sent = []
  let last = null
  let locked = false
  const edit = (code) => {
    if (shouldAutoSubmit({ code, last, locked })) {
      last = code
      sent.push(code)
    }
  }
  for (const code of ['1', '12', '123', '1234', '12345']) edit(code)
  t.alike(sent, [], 'nothing before the sixth digit')
  edit('123456')
  t.alike(sent, ['123456'], 'one check for the completed code')
  locked = true
  edit('123456')
  edit('123457')
  t.alike(sent, ['123456'], 'nothing while busy or awaiting')
  locked = false
  edit('123456')
  t.alike(sent, ['123456'], 'after an error or an uncertain answer the same code stays')
  edit('12345')
  edit('123456')
  t.alike(sent, ['123456'], 'retyping the same digits never sends them again')
  edit('12345')
  edit('123450')
  t.alike(sent, ['123456', '123450'], 'a different completed code is checked once')
  edit('123450')
  t.alike(sent, ['123456', '123450'])
  let inFlight = true
  const editLive = (code) => {
    if (shouldAutoSubmit({ code, last, locked: locked || inFlight })) {
      last = code
      sent.push(code)
    }
  }
  editLive('111111')
  t.alike(sent, ['123456', '123450'], 'an edit during a request in flight sends nothing')
  t.is(last, '123450', 'and is not marked as checked')
  inFlight = false
  editLive('111111')
  t.alike(sent, ['123456', '123450', '111111'])
})

test('phoneEntry stays pure', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/phoneEntry.js'), 'utf8')
  t.absent(/^import /m.test(src), 'imports nothing')
  t.absent(/\b(react|react-native|Platform|localStorage|sessionStorage|AsyncStorage|console|setTimeout|setInterval)\b/.test(src))
  t.absent(src.includes('\u2014'))
})

test('Telefone: one transparent code input under six hidden cells', (t) => {
  const src = fs.readFileSync(SCREEN, 'utf8')
  const code = withoutComments(src)
  t.ok(code.includes("import { cellsOf, shouldAutoSubmit } from '../phoneEntry'"))
  t.ok(code.includes("const NO_AUTOFILL = { autoComplete: 'off', autoCorrect: false, autoCapitalize: 'none', spellCheck: false, importantForAutofill: 'no', textContentType: 'none' }"))
  t.ok(code.includes("const CODE_LABEL = 'Código de 6 números'"))
  const start = code.indexOf('function CodeInput (')
  t.ok(start > 0)
  const box = code.slice(start, code.indexOf('\n}\n', start))
  t.is(count(box, '<TextInput'), 1, 'one input for the code')
  t.ok(box.includes('{...NO_AUTOFILL}'))
  t.ok(box.includes('maxLength={12}'))
  t.ok(box.includes("keyboardType='number-pad'"))
  t.ok(box.includes('accessibilityLabel={label}'))
  t.ok(box.includes('onSubmitEditing={onSubmitEditing}'))
  t.ok(box.includes('style={styles.codeInput}'))
  t.ok(box.includes('const cells = cellsOf(value)'))
  t.ok(box.includes("<View style={styles.cells} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>"))
  t.ok(box.indexOf('styles.cells') < box.indexOf('<TextInput'), 'the input is drawn on top of the cells')
  t.ok(box.includes('selection={{ start: value.length, end: value.length }}'), 'the caret stays at the end')
  t.ok(box.includes('onSelectionChange={pinCaret}'), 'a moved caret goes back to the end')
  t.ok(box.includes('const [, setCaretPin] = useState(0)'))
  t.ok(box.includes('if (sel && (sel.start !== value.length || sel.end !== value.length)) setCaretPin((n) => n + 1)'), 'a caret away from the end forces a render that reapplies selection')
  t.ok(box.includes('const [focused, setFocused] = useState(false)'))
  t.ok(box.includes('onFocus={() => setFocused(true)}'))
  t.ok(box.includes('onBlur={() => setFocused(false)}'))
  t.ok(box.includes('<View key={i} style={[styles.cell, editable && focused && i === at && styles.cellOn, !editable && styles.off]}>'), 'the active cell shows only while focused')
  t.is(count(box, 'styles.cellOn'), 1)
  t.ok(code.includes('minHeight: 52,'), 'cells grow with the font scale')
  t.absent(/\bheight: 52\b/.test(code.replace('minHeight: 52', '')))
  t.ok(code.includes("codeInput: { ...StyleSheet.absoluteFillObject, color: 'transparent', backgroundColor: 'transparent'"))
  t.is(count(code, '<TextInput'), 2, 'the number input and the code input')
  t.is(count(code, '{...NO_AUTOFILL}'), 2, 'both ask for no autofill')
  t.ok(code.includes('<CodeInput label={CODE_LABEL} value={code} onChangeText={editCode} editable={!locked} onSubmitEditing={confirm} />'))
  t.absent(src.includes('\u2014'))
})

test('Telefone: a completed code is checked once from the edit, never from an effect', (t) => {
  const code = withoutComments(fs.readFileSync(SCREEN, 'utf8'))
  t.is(count(code, 'verify.check('), 1, 'one place sends a check')
  const check = code.slice(code.indexOf('const checkCode = async (candidate) => {'), code.indexOf('const confirm = '))
  t.ok(check.includes('lastChecked.current = candidate'))
  t.ok(check.indexOf('lastChecked.current = candidate') < check.indexOf('await verify.check(candidate)'), 'recorded before it goes')
  const guard = 'if (!isCode(candidate) || inFlight.current !== null) return'
  t.ok(check.includes(guard), 'only a six-digit code, and never during a request in flight')
  t.ok(check.indexOf(guard) < check.indexOf('lastChecked.current = candidate'), 'nothing is recorded when nothing goes')
  t.ok(check.indexOf('inFlight.current = mine') < check.indexOf('await verify.check(candidate)'))
  t.ok(check.includes('if (inFlight.current === mine) inFlight.current = null'))
  t.ok(check.includes('if (r !== null && r.uncertain === true) setAwaiting(r.key)'))
  t.ok(code.includes("import { codeDigits, isCode } from '../phone'"))
  t.ok(code.includes('const confirm = () => {\n    if (!canConfirm) return\n    checkCode(code.trim())\n  }'), 'Enter does no more than the button')
  t.ok(code.includes('const codeLocked = locked || awaiting !== null'))
  t.ok(code.includes('const canConfirm = !codeLocked && code.trim().length === 6'))
  t.ok(code.includes('onSubmitEditing={confirm}'))
  const sendFn = code.slice(code.indexOf('const send = async () => {'), code.indexOf('const checkCode = '))
  t.ok(sendFn.includes('if (inFlight.current === null) inFlight.current = mine'), 'a send in flight holds the edit too')
  t.ok(sendFn.includes('if (inFlight.current === mine) inFlight.current = null'))
  t.is(count(code, 'lastChecked.current ='), 3, 'set only by checkCode, by Trocar n\u00famero and by a new gate')
  t.ok(code.includes('useEffect(() => {\n    inFlight.current = null\n    lastChecked.current = null\n  }, [gateKey])'), 'a new gate key forgets the old request and code')
  const changeFn = code.slice(code.indexOf('const change = () => {'), code.indexOf('const resendLabel'))
  t.ok(changeFn.includes('lastChecked.current = null'), 'a new number forgets the last code')
  t.ok(changeFn.includes('inFlight.current = null'))
  t.ok(code.includes('<StepLink label={CHANGE_LABEL} onPress={change}'))
  t.absent(sendFn.includes('lastChecked'), 'a resend keeps the last code')
  t.is(count(code, 'shouldAutoSubmit('), 1)
  const edit = code.slice(code.indexOf('const editCode = (text) => {'), code.indexOf('const change = '))
  t.ok(edit.includes('const next = codeDigits(text)'))
  t.ok(edit.includes('setCode(next)'))
  t.ok(edit.includes('if (shouldAutoSubmit({ code: next, last: lastChecked.current, locked: codeLocked || inFlight.current !== null })) checkCode(next)'), 'the explicit candidate, never state')
  t.ok(code.includes('const locked = verify.busy || waiting || offline'))
  t.is(count(code, 'checkCode('), 2, 'from Confirmar and from the edit')
  let at = code.indexOf('useEffect(')
  while (at !== -1) {
    const end = code.indexOf('}, [', at)
    const body = code.slice(at, end)
    t.absent(body.includes('checkCode') || body.includes('verify.check') || body.includes('confirm') || body.includes('editCode'), 'no check from an effect')
    at = code.indexOf('useEffect(', at + 1)
  }
  for (const timer of ['useLayoutEffect', 'useInsertionEffect', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask', 'setImmediate']) {
    t.absent(code.includes(timer), 'no ' + timer + ' can reach a check')
  }
  t.ok(code.includes('<Btn label={CONFIRM_LABEL} onPress={confirm} disabled={!canConfirm} pending={verify.busy} block large />'), 'the button and Enter share one rule')
  const hook = fs.readFileSync(path.join(__dirname, '../src/usePhoneVerify.js'), 'utf8')
  t.ok(hook.includes("if (typeof who !== 'string' || busyRef.current || !liveRef.current) return null"), 'check keeps its guards')
  t.ok(hook.includes('if (!isCode(c)) {'))
})

test('Telefone: Reenviar código is a link with the wait in its label and sends only when pressed', (t) => {
  const code = withoutComments(fs.readFileSync(SCREEN, 'utf8'))
  t.ok(code.includes("const RESEND_LABEL = 'Reenviar código'"))
  t.ok(code.includes("const resendLabel = verify.resendIn > 0 ? RESEND_LABEL + ' em ' + verify.resendIn + ' s' : RESEND_LABEL"))
  t.ok(code.includes('<StepLink label={resendLabel} onPress={send} disabled={locked || verify.resendIn > 0} />'))
  t.absent(code.includes('<Btn label={resendLabel}'))
  t.absent(/resendIn[^\n]*(send\(|checkCode\(|verify\.check)/.test(code.replace('onPress={send}', '')), 'the wait never sends')
  t.is(count(code, 'verify.send('), 1)
})
