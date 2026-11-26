'use strict'

// The own Depoimentos list opens from its stored copy ('listas' snapshot,
// src/listsSnapshot.js). Depoimentos.js loads react-native, so the wiring is
// checked on its text; the render gate runs on the pure cachedRows module.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const DEP = withoutComments(fs.readFileSync(path.join(SRC, 'screens', 'Depoimentos.js'), 'utf8'))

function section (src, start, end) {
  const a = src.indexOf(start)
  if (a < 0) return ''
  const b = src.indexOf(end, a + start.length)
  return b < 0 ? src.slice(a) : src.slice(a, b)
}

const OWN = 'aa'.repeat(32)
const WRITER = 'bb'.repeat(32)
const BLOCKED = 'cc'.repeat(32)
const row = (from) => ({ from, seq: 1, text: 't', at: '2026-11-01T00:00:00.000Z', ref: OWN + ':1' })

const HOOK = section(DEP, 'export function useTestimonials (', '// A mutating action with its own pending flag')

test('only the own list reads or writes the copy, with a member binding', (t) => {
  t.ok(HOOK.includes("const ownList = typeof ownKey === 'string' && owner === ownKey"), 'own list only')
  t.ok(HOOK.includes("const binding = ownList ? memberSnapshotBinding({ node, acting, pageKey: acting.kind === 'page' ? acting.key : null }) : null"), 'no binding for another member, a page actor or a locked session')
  t.ok(HOOK.includes('const bindingOk = binding !== null && binding.owner === owner'), 'the snapshot owner is the list owner')
  const init = section(HOOK, 'const [state, setState] = useState(() => {', 'const bindingRef')
  t.ok(init.includes('if (!hosted || !bindingOk) return base'), 'nothing without a binding')
  t.ok(init.includes("loadScreenSnapshot('listas', binding)"))
  t.ok(init.includes("entry.scope !== ''"), 'the scope is checked')
  t.ok(init.includes("{ phase: 'ready', rows: entry.rows, index: null, error: null, seeded: true, seedBinding: binding }"), 'seeded start')
  t.ok(HOOK.includes('const [pending, setPending] = useState({ rows: [], error: null, loaded: false })'), 'pending is never seeded')
  t.absent(/lists\.(?!depoimentos)/.test(HOOK), 'no other list is read')
})

test('the rows go through the block gate on every change', (t) => {
  const gate = section(HOOK, 'const shownRows = useMemo(() => {', 'const load = useCallback')
  t.ok(gate.includes('if (state.seeded !== true) return state.rows'), 'live rows pass')
  t.ok(gate.includes('cachedRowsShown(state.rows, { loadState: blocks.loadState, blocked: blocks.keys, owner: b.owner, authorsOf: (r) => [r.from] })'))
  t.ok(gate.includes('[state, blocks.loadState, blocks.keys, bindingKey]'), 'recomputed when block.list answers or a block arrives')
  t.ok(HOOK.includes('rows: shownRows,') && HOOK.includes('seeded: state.seeded === true'))
})

test('the gate holds cached rows until block.list is ok and drops a block that arrives later', async (t) => {
  const { cachedRowsShown } = await import('../src/cachedRows.js')
  const opts = (loadState, keys) => ({ loadState, blocked: new Set(keys), owner: OWN, authorsOf: (r) => [r.from] })
  const rows = [row(WRITER), row(BLOCKED)]
  t.is(cachedRowsShown(rows, opts('pending', [])).length, 0, 'pending: nothing paints')
  t.is(cachedRowsShown(rows, opts('ok', [])).length, 2, 'ok: shown')
  t.alike(cachedRowsShown(rows, opts('ok', [BLOCKED])).map((r) => r.from), [WRITER], 'a block arriving later hides the writer')
})

test('a cached row offers no action and an empty gate is not an empty list', (t) => {
  t.is(DEP.split('onRemove={own && data.seeded !== true ? setRemoving : undefined}').length - 1, 2, 'the tab and the screen')
  t.absent(/onRemove=\{own \? setRemoving/.test(DEP))
  t.is(DEP.split('onReport={data.seeded !== true ? onReport : undefined}').length - 1, 2, 'no report from a cached row')
  t.ok(HOOK.includes("state.seeded === true && shownRows.length === 0 && state.phase === 'ready' && !state.error ? 'loading'"), 'skeleton while the gate holds every row')
})

test('the live answer replaces the rows and drops seeded, a failure keeps them', (t) => {
  const answer = section(HOOK, 'const shown = readShown(request, owner).then((v) => {', 'const tasks = [shown]')
  t.ok(answer.includes("setState({ phase: 'ready', rows: v.rows, index: v.index, incomplete: v.incomplete === true, error: null })"), 'no seeded key')
  t.ok(answer.includes("setState((s) => ({ ...s, phase: s.phase === 'ready' ? 'ready' : 'error', error: errorText(err) }))"), 'failure keeps rows and seeded')
})

test('a save needs a complete live read and uses the generation and binding read before the request', (t) => {
  const load = section(HOOK, 'const load = useCallback(async () => {', 'const tasks = [shown]')
  const gen = load.indexOf('const gen = cacheGeneration()')
  const bind = load.indexOf('const saveBinding = bindingRef.current')
  const req = load.indexOf('readShown(request, owner)')
  t.ok(gen > 0 && bind > 0 && req > 0 && gen < req && bind < req, 'both before readShown')
  t.ok(load.includes('if (v.incomplete !== true && saveBinding !== null) armSave(gen, saveBinding, v.rows)'), 'only a complete read arms')
  const arm = section(HOOK, 'const armSave = useCallback(', 'const bindingKey')
  t.ok(arm.includes('if (b === null || cacheGeneration() !== gen) return'), 'a purge arms nothing')
  t.ok(arm.includes('SAVE_DELAY_MS') && DEP.includes('const SAVE_DELAY_MS = 2000'), '2 s debounce')
  const flush = section(HOOK, 'const flushSave = useCallback(', 'const armSave')
  t.ok(flush.includes("b.loadState !== 'ok' || cacheGeneration() !== armed.gen || !sameSnapshotBinding(armed.binding, bindingRef.current)"), 'generation, binding and block list at write time')
  t.ok(flush.includes('!b.keys.has(r.from)') && flush.includes('.slice(0, SAVE_ROWS_MAX)'), 'no blocked writer, 30 rows')
  t.ok(flush.includes("name: 'depoimentos', scope: ''") && flush.includes('previous: stored === null ? null : stored.body'), 'only this list, the others kept')
  t.ok(flush.includes("saveScreenSnapshot('listas', snapshot, armed.gen)"))
  t.absent(/setTimeout/.test(flush), 'a refused save is not retried')
  t.ok(HOOK.includes('runRef.current++; cancelSave()'), 'unmount cancels the debounce')
})

test('saved rows never show the end of the list', (t) => {
  const footer = section(DEP, 'export function tabFooterKind (', '\n}\n')
  t.ok(footer.includes("if (seeded === true && rowCount > 0) return failed || phase === 'error' ? 'error' : 'loading'"), 'seeded rows: a skeleton or a retry, never Fim')
  t.ok(footer.indexOf('seeded === true') < footer.indexOf("return 'end'"), 'checked before the end of the list')
  t.ok(DEP.includes('seeded: data.seeded === true })'), 'the tab passes the seeded mark')
})
