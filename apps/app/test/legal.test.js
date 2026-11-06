'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')

const load = () => import('../src/legal.js')

test('legal: version, date and review note', async (t) => {
  const { LEGAL_VERSION, LEGAL_DATE, REVIEW_NOTE } = await load()
  t.is(LEGAL_VERSION, 18)
  t.is(LEGAL_DATE, '06/11/2026')
  t.is(REVIEW_NOTE, 'Versão 18, sujeita a revisão jurídica. Não é parecer jurídico.')
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
  t.is(digest, 'e5073e130b060ff0738b4814692eb3e03d47bb1f56d01b84fedfebb517755027', 'o texto mudou: suba LEGAL_VERSION (e TERMS_VERSION em @varanda/core lib/terms.js) e atualize este digest')
})

test('legal: pages are described in Terms and Privacy, including service-readable messages', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.filter(({ heading }) => heading === 'Páginas').flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('Só o dono convida e remove administradores'))
  t.ok(text(TERMS).includes('só vale se ela aceitar'))
  t.ok(text(PRIVACY).includes('lista de administradores'))
  t.ok(text(TERMS).includes('pode ler as mensagens enviadas para a página'))
  t.ok(text(TERMS).includes('perde o acesso a essas mensagens no momento da remoção'))
  t.ok(text(TERMS).includes('começa uma caixa nova'))
  t.ok(text(PRIVACY).includes('podem ser lidas pelo serviço de conta'))
})

test('legal: version 15 names the group box, the notices custody, the burned name and the automatic follow', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.filter(({ heading }) => heading === 'Páginas').flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('a caixa dos grupos privados e as chaves de escrita'))
  t.ok(text(TERMS).includes('lê os avisos enviados para a página'))
  t.ok(text(TERMS).includes('o @nome nunca mais é dado a ninguém'))
  t.ok(text(TERMS).includes('passam a seguir a chave nova sozinhos'))
  t.ok(text(TERMS).includes('uma chave guardada naquele aparelho'))
  t.ok(text(PRIVACY).includes('pode ler as publicações da página em grupos privados'))
  t.ok(text(PRIVACY).includes('lê os avisos enviados para a página'))
})

test('legal: version 17 describes photos in chats and the report image', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('até 4 por mensagem'))
  t.ok(text(TERMS).includes('sob um identificador aleatório, por até sete dias'))
  t.ok(text(TERMS).includes('só os aparelhos dos membros conseguem abri-la'))
  t.ok(text(TERMS).includes('marcada como não conferida'))
  t.ok(text(PRIVACY).includes('Fotos de grupos públicos são públicas'))
  t.ok(text(PRIVACY).includes('cópia reduzida em JPEG de até 700 KB'))
  for (const planned of ['áudio', 'mensagem de voz', 'busca de GIF', 'prévia de link', 'encaminhar']) {
    t.absent(text(TERMS).includes(planned) || text(PRIVACY).includes(planned), 'not described as available: ' + planned)
  }
})
