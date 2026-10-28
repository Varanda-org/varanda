'use strict'

const test = require('brittle')

const load = () => import('../src/onboarding.js')

const hosted = { mode: 'hosted', locked: false, recovering: false, hasIdentity: true, memberCert: true, profileKnown: true, hasName: true, skippedName: false }
const local = (mode) => ({ ...hosted, mode })

test('onboardingStep: hosted transitions', async (t) => {
  const { onboardingStep } = await load()
  t.alike(onboardingStep({ ...hosted, locked: true }), { step: 'entrar', index: 0, total: 3 })
  t.alike(onboardingStep({ ...hosted, recovering: true }), { step: 'recuperando', index: 1, total: 3 })
  t.alike(onboardingStep({ ...hosted, memberCert: false }), { step: 'vinculo', index: 1, total: 3 })
  t.alike(onboardingStep({ ...hosted, profileKnown: false }), { step: 'carregando', index: 2, total: 3 })
  t.alike(onboardingStep({ ...hosted, hasName: false }), { step: 'perfil', index: 2, total: 3 })
  t.alike(onboardingStep(hosted), { step: 'pronto', index: 3, total: 3 })
})

test('onboardingStep: native and serve transitions', async (t) => {
  const { onboardingStep } = await load()
  for (const mode of ['native', 'serve']) {
    t.alike(onboardingStep({ ...local(mode), hasIdentity: false }), { step: 'identidade', index: 0, total: 3 })
    t.alike(onboardingStep({ ...local(mode), memberCert: false }), { step: 'certificado', index: 1, total: 3 })
    t.alike(onboardingStep({ ...local(mode), profileKnown: false }), { step: 'carregando', index: 2, total: 3 })
    t.alike(onboardingStep({ ...local(mode), hasName: false }), { step: 'perfil', index: 2, total: 3 })
    t.alike(onboardingStep(local(mode)), { step: 'pronto', index: 3, total: 3 })
  }
})

test('onboardingStep: skipping the name always reaches the tabs', async (t) => {
  const { onboardingStep } = await load()
  for (const mode of ['hosted', 'native', 'serve']) {
    for (const profileKnown of [true, false]) {
      for (const hasName of [true, false]) {
        t.is(onboardingStep({ ...local(mode), profileKnown, hasName, skippedName: true }).step, 'pronto')
      }
    }
  }
})

test('onboardingStep: locked and recovering take precedence over the skip', async (t) => {
  const { onboardingStep } = await load()
  t.is(onboardingStep({ ...hosted, locked: true, recovering: true, skippedName: true }).step, 'entrar')
  t.is(onboardingStep({ ...hosted, recovering: true, memberCert: false, skippedName: true }).step, 'recuperando')
  t.is(onboardingStep({ ...hosted, memberCert: false, skippedName: true }).step, 'vinculo')
})

test('onboardingStep: the acceptance case', async (t) => {
  const { onboardingStep } = await load()
  t.is(onboardingStep({ mode: 'hosted', locked: false, recovering: false, memberCert: true, profileKnown: true, hasName: false, skippedName: false }).step, 'perfil')
})

test('step titles and hints cover every step', async (t) => {
  const { STEP_TITLES, STEP_HINTS } = await load()
  const steps = ['entrar', 'recuperando', 'vinculo', 'identidade', 'certificado', 'carregando', 'perfil', 'pronto']
  t.alike(Object.keys(STEP_TITLES).sort(), steps.slice().sort())
  for (const s of steps) t.ok(STEP_HINTS[s].length > 0)
})

test('step titles and hints avoid technical words', async (t) => {
  const { STEP_TITLES, STEP_HINTS } = await load()
  const technical = /(^|[^\p{L}])(semeador|chave|certificado|nó)(?![\p{L}])/iu
  for (const text of [...Object.values(STEP_TITLES), ...Object.values(STEP_HINTS)]) {
    t.absent(technical.test(text), text)
  }
})
