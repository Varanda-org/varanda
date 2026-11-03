'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')

const load = () => import('../src/legal.js')

test('legal: version, date and review note', async (t) => {
  const { LEGAL_VERSION, LEGAL_DATE, REVIEW_NOTE } = await load()
  t.is(LEGAL_VERSION, 10)
  t.is(LEGAL_DATE, '03/11/2026')
  t.is(REVIEW_NOTE, 'Versão 10, sujeita a revisão jurídica. Não é parecer jurídico.')
})

test('legal: complete documents with plain, visible text and project URLs', async (t) => {
  const { TERMS, PRIVACY, LEGAL_DATE, REVIEW_NOTE } = await load()
  t.is(TERMS.title, 'Termos de Uso')
  t.is(PRIVACY.title, 'Política de Privacidade')
  const strings = [LEGAL_DATE, REVIEW_NOTE]
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(Array.isArray(doc.sections) && doc.sections.length >= 6, doc.title + ': sections')
    strings.push(doc.title)
    for (const section of doc.sections) {
      t.ok(Array.isArray(section.paragraphs) && section.paragraphs.length > 0, section.heading + ': paragraphs')
      strings.push(section.heading, ...section.paragraphs)
    }
  }
  for (const value of strings) {
    t.ok(typeof value === 'string' && value.trim().length > 0, 'non-empty string')
    t.absent(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(value), 'no control, bidi or invisible characters')
    t.absent(/\b(?:TODO|XXX|lorem)\b|\[/i.test(value), 'no placeholders')
    t.absent(/[<>`*]/.test(value), 'no markup')
    for (const match of value.matchAll(/https:\/\/\S+/g)) {
      t.ok(match[0].startsWith('https://github.com/Varanda-org/varanda/'), 'project URL: ' + match[0])
    }
  }
})

test('legal: profile photo disclosures', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(PRIVACY).includes('foto do perfil'))
  t.ok(text(TERMS).includes('imagem parada'))
})

test('legal: privacy identifies unresolved retention and contact', async (t) => {
  const { PRIVACY } = await load()
  const text = PRIVACY.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const required of ['encarregado', 'ainda não nomeado', 'issue #38', 'e-mail', 'https://github.com/Varanda-org/varanda/issues']) {
    t.ok(text.includes(required), required)
  }
})

// A copy change requires a new acceptance version, including the core's
// independent constant. Pin the serialized contract, not a digest of itself.
test('legal: published text is pinned to its acceptance version', async (t) => {
  const { LEGAL_VERSION, TERMS, PRIVACY } = await load()
  const digest = createHash('sha256').update(JSON.stringify({ LEGAL_VERSION, TERMS, PRIVACY })).digest('hex')
  t.is(digest, '8818eafa91cfcce525a4cfd58a8b6ac8f5c82f1fef936c6b6da8c6f68e8d62c0', 'o texto mudou: suba LEGAL_VERSION (e TERMS_VERSION em @varanda/core lib/terms.js) e atualize este digest')
})

test('legal: privacy names the in-page liveness provider and keeps the Sumsub page', async (t) => {
  const { PRIVACY } = await load()
  const text = PRIVACY.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text.includes('Amazon Rekognition'), 'Amazon Rekognition')
  t.ok(text.includes('AWS Cognito'), 'AWS Cognito')
  t.ok(text.includes('só na memória, por no máximo 30 minutos'), 'token in memory for 30 minutes')
  t.ok(text.includes('o aplicativo instalado continua abrindo essa página'), 'installed app keeps the Sumsub page')
})

test('legal: privacy names the third-party CPF and the ledger cap', async (t) => {
  const { PRIVACY } = await load()
  const text = PRIVACY.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const required of ['o CPF dela vai para a Hodle só para essa operação, e o Varanda não o guarda', 'no máximo 20000 operações']) {
    t.ok(text.includes(required), required)
  }
})

test('legal: terms disclose the payment fees before confirming', async (t) => {
  const { TERMS } = await load()
  const text = TERMS.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const required of ['CPF de outra pessoa', 'o valor, a taxa do parceiro, a taxa do Varanda e o total', 'não há taxa do Varanda para receber', 'só é cobrada depois que a Hodle informa que esse Pix foi concluído', 'normalmente é cobrada no seu próximo envio confirmado com o PIN', 'a taxa dele nunca é cobrada', 'todas as taxas pendentes; esse dinheiro fica na sua carteira', 'não devolve automaticamente uma taxa', 'o CPF dela vai para a Hodle só para essa operação, e o Varanda não o guarda']) {
    t.ok(text.includes(required), required)
  }
})
