'use strict'

// The setup steps under the boot splash (#355, from #313): App.js and
// Identidade.js read as text so this test never loads JSX.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const app = () => fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
const ident = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Identidade.js'), 'utf8')

test('a node.info error in Identidade reaches the shell at once', (t) => {
  const s = ident()
  t.ok(s.includes("if (notify && typeof onInfoError === 'function') onInfoError(errorText(err))"), 'the catch reports the error')
  t.ok(s.includes('}, [node.request, onInfo, onInfoError])'))
  const a = app()
  t.ok(a.includes("const takeInfoError = useCallback((text) => setInfoError(text || 'erro'), [])"))
  t.ok(a.includes('onInfoError={takeInfoError}'), 'the setup Identidade gets it')
})

test('Escolha seu @nome stays under the splash from the render node.info arrives', async (t) => {
  const { setupInfoKnown } = await import('../src/setupInfoKnown.js')
  const { coverBoot, holdBootCover, bootPatienceMs } = await import('../src/splashGate.js')
  const KEY = 'ab'.repeat(32)
  const info = { publicKey: KEY, memberCert: false }
  // The first render with node.info: the card has not mounted, nothing read.
  const first = setupInfoKnown({ step: 'vinculo', info, infoError: '', accountReadKey: null })
  t.is(first, false, 'not known before the account state is read')
  const cover = coverBoot({ step: 'vinculo', infoKnown: first })
  t.is(cover, true)
  t.is(holdBootCover({ cover, elapsedMs: 0, settled: false, step: 'vinculo' }), true, 'the splash holds, so the latch does not settle')
  t.is(holdBootCover({ cover, elapsedMs: bootPatienceMs('vinculo'), settled: false, step: 'vinculo' }), false, 'the step patience still bounds it')
  t.is(setupInfoKnown({ step: 'vinculo', info, accountReadKey: 'cd'.repeat(32) }), false, 'a read of another key does not count')
  t.is(setupInfoKnown({ step: 'vinculo', info, accountReadKey: KEY }), true, 'read: the form shows')
  t.is(setupInfoKnown({ step: 'vinculo', info: null, infoError: 'falhou' }), true, 'an error shows at once')
  t.is(setupInfoKnown({ step: 'vinculo', info: null }), false)
  t.is(setupInfoKnown({ step: 'vinculo', info: { publicKey: KEY, memberCert: true } }), true, 'a linked member waits for nothing')
  for (const step of ['identidade', 'certificado']) t.is(setupInfoKnown({ step, info }), true, step + ' needs only node.info')
  // After Idade or Telefone the latch is already settled: no splash comes back.
  t.is(holdBootCover({ cover: true, elapsedMs: 0, settled: true, step: 'vinculo' }), false)
})

test('Identidade reports the account read by key and App feeds it to the cover', (t) => {
  const s = ident()
  t.ok(s.includes('if (acctRead && typeof onRead === \'function\') onRead(publicKey)'))
  t.ok(s.includes('onRead={setup ? onAccountRead : undefined}'), 'only the setup step reports it')
  const a = app()
  t.ok(a.includes('infoKnown: setupInfoKnown({ step, info, infoError, accountReadKey })'))
  t.ok(a.includes('onAccountRead={setAccountReadKey}'))
})

test('the manual setup reuses the shell node.info instead of starting empty', (t) => {
  const s = ident()
  t.ok(s.includes('const [info, setInfo] = useState(initialInfo)'))
  t.ok(s.includes('if (mountGeneration.current === generation) return'), 'the generation reset skips the mount')
  t.ok(s.includes('mountGeneration.current = null'), 'every later identity change still clears it')
  t.ok(app().includes('initialInfo={passkey === null ? info : null}'), 'only without a passkey, where the shell read it')
})
