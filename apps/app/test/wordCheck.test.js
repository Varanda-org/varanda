'use strict'

// The on-device word check (src/wordCheck.js, src/blockedTerms.js) and where
// the screens call it. ES modules loaded through import(). The matching rules
// use a made-up list, and the real list is only read from its module, so this
// file never spells a listed term.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/wordCheck.js')
const loadList = async () => (await import('../src/blockedTerms.js')).BLOCKED_TERMS
const SRC = path.join(__dirname, '../src')
const screen = (name) => fs.readFileSync(path.join(SRC, 'screens', name), 'utf8')

test('a term matches whole words only, never inside a longer word', async (t) => {
  const { findTerm, indexTerms } = await load()
  const index = indexTerms(['cu'])
  for (const text of ['cultura', 'curso', 'acu', 'a cultura do cuidado', 'cu1', 'c u']) {
    t.is(findTerm(text, index), null, text)
  }
  for (const text of ['cu', 'o cu dele', 'cu!', '(cu)', 'cu\nfim']) {
    t.is(findTerm(text, index), 'cu', text)
  }
})

test('matching uses the folding of search.js', async (t) => {
  const { findTerm, indexTerms } = await load()
  const index = indexTerms(['crianca'])
  for (const text of ['CRIANÇA', 'criança', 'cria\u200bnça', 'ｃｒｉａｎçａ', 'crianc\u0327a']) {
    t.is(findTerm(text, index), 'crianca', text)
  }
})

test('a term of several words matches only those words in a row', async (t) => {
  const { findTerm, indexTerms } = await load()
  const index = indexTerms(['termo ruim', 'termo ruim demais', 'll fazer'])
  t.is(findTerm('um TERMO, ruim!', index), 'termo ruim', 'punctuation and spaces between the words')
  t.is(findTerm('termo\n\nruim', index), 'termo ruim', 'a line break between the words')
  t.is(findTerm("i'll fazer", index), 'll fazer', 'an apostrophe separates words')
  t.is(findTerm('termo muito ruim', index), null, 'not in a row')
  t.is(findTerm('termos ruins', index), null, 'other words')
  t.is(findTerm('ruim termo', index), null, 'other order')
  t.is(findTerm('termo', index), null, 'text ends mid term')
})

test('the whole text is read, past the bound of search input', async (t) => {
  const { findTerm, indexTerms } = await load()
  const index = indexTerms(['ruim'])
  t.is(findTerm('palavra '.repeat(125) + 'ruim', index), 'ruim', 'after 1000 characters')
  t.is(findTerm('.'.repeat(300) + 'ruim', index), 'ruim', 'after punctuation with no spaces')
})

test('a longer word is not cut down into a term', async (t) => {
  const { findTerm, indexTerms } = await load()
  const term = 'a'.repeat(20)
  t.is(findTerm('a'.repeat(21), indexTerms([term])), null)
  t.is(findTerm(term, indexTerms([term])), term)
})

test('an @nome is read word by word, split at its underscores', async (t) => {
  const { findTerm, indexTerms } = await load()
  const index = indexTerms(['ruim', 'termo ruim'])
  t.is(findTerm('ruim_123', index), 'ruim')
  t.is(findTerm('o_termo_ruim', index), 'termo ruim')
  t.is(findTerm('ruim123', index), null, 'letters and digits together are one word')
  t.is(findTerm(null, index), null, 'an @nome that is not valid yet')
})

test('what is not text refuses nothing', async (t) => {
  const { findTerm, refusalOf } = await load()
  for (const value of [undefined, null, 7, {}, [], '']) {
    t.is(findTerm(value), null)
    t.is(refusalOf(value), '')
  }
  t.is(refusalOf(), '')
})

test('refusalOf names the first listed term, in pt-BR', async (t) => {
  const { refusalOf, refusalText } = await load()
  const list = await loadList()
  const [first, second] = list
  t.is(refusalOf('um texto comum'), '')
  t.is(refusalOf('um texto comum', 'outro texto'), '')
  t.is(refusalOf(first), refusalText(first))
  t.is(refusalOf('nome comum', second), refusalText(second), 'any of the texts')
  t.is(refusalOf(first, second), refusalText(first), 'the first one')
  t.ok(refusalText(first).includes('"' + first + '"'), 'names the term')
  t.ok(refusalText(first).includes('Edite o texto'), 'says what to do')
  t.absent(refusalText(first).includes(String.fromCodePoint(0x2014)), 'no em dash')
})

test('a group is checked only when known to be public', async (t) => {
  const { publicGroupRefusal, refusalText } = await load()
  const [term] = await loadList()
  t.is(publicGroupRefusal('public', term), refusalText(term))
  t.is(publicGroupRefusal('public', 'um texto comum'), '')
  for (const visibility of ['private', null, undefined, '', 'outra']) {
    t.is(publicGroupRefusal(visibility, term), '', String(visibility))
  }
})

test('every listed term is refused and the list keeps its format', async (t) => {
  const { findTerm } = await load()
  const { wholeTokens } = await import('../src/search.js')
  const list = await loadList()
  t.ok(Object.isFrozen(list), 'frozen')
  t.is(new Set(list).size, list.length, 'no repeats')
  for (const term of list) {
    t.is(wholeTokens(term).join(' '), term, term + ': written as it folds')
    t.is(findTerm(term), term, term + ': refused')
    const words = term.split(' ')
    t.ok(words.length <= 6, term + ': a short phrase')
    if (words.length === 1) t.ok(term.length >= 3, term + ': long enough to mean one thing')
  }
})

test('everyday text and the words around the list are not refused', async (t) => {
  const { findTerm } = await load()
  const words = [
    'cultura', 'computador', 'Nigéria', 'Níger', 'nigeriano', 'spicy', 'fagote', 'fagot', 'macaco', 'macaca',
    'crioulo', 'crioula', 'feijão crioulo', 'milho crioulo', 'negro', 'preto', 'judeu', 'judia', 'criança', 'menor',
    'novinha', 'sexo', 'escola', 'matar', 'morte', 'kill', 'killer', 'skills', 'rape', 'grape', 'kid', 'child', 'porn',
    'matar a saudade', 'ele se mata de trabalhar', 'o macaco fugiu do zoológico', 'o menor preço da feira',
    'um pack de seis cervejas', 'proteção de crianças e adolescentes', 'a morte de um amigo', 'kill the process',
    'fui na escola hoje', 'te mato de rir', 'she will kill it on stage', 'a child of ten'
  ]
  for (const text of words) t.is(findTerm(text), null, text)
})

test('the app\'s own legal and help texts are not refused', async (t) => {
  const { findTerm } = await load()
  const { TERMS, PRIVACY } = await import('../src/legal.js')
  const { HELP } = await import('../src/help.js')
  for (const doc of [TERMS, PRIVACY]) {
    for (const section of doc.sections) {
      for (const paragraph of section.paragraphs) t.is(findTerm(paragraph), null, section.heading)
    }
  }
  t.is(findTerm(JSON.stringify(HELP)), null, 'help')
  const { SUGGESTIONS } = await import('../src/inviteCardCopy.js')
  for (const suggestion of Object.values(SUGGESTIONS)) t.is(findTerm(suggestion), null, suggestion)
})

test('the check stays on the device and leaves no trace', (t) => {
  const check = fs.readFileSync(path.join(SRC, 'wordCheck.js'), 'utf8')
  const list = fs.readFileSync(path.join(SRC, 'blockedTerms.js'), 'utf8')
  const imports = [...check.matchAll(/^import .* from '(.*)'$/gm)].map((m) => m[1])
  t.alike(imports, ['./blockedTerms.js', './search.js'], 'imports only its list and the folding')
  t.absent(/^import /m.test(list), 'the list imports nothing')
  for (const word of ['console.', 'fetch(', 'request(', 'Storage', 'Platform', 'XMLHttpRequest', 'navigator']) {
    t.absent(check.includes(word), 'no ' + word)
  }
})

test('the composers check before they send', (t) => {
  const publicar = screen('Publicar.js')
  const send = publicar.slice(publicar.lastIndexOf('const send = async () => {'), publicar.indexOf('return sendAsPage()'))
  t.ok(send.includes('refusalOf(text)'), 'Publicar: the draft is checked before any send path')
  t.ok(send.includes('setCheckError(refused)'), 'Publicar: the refusal is shown')
  t.ok(/if \(refused !== ''\) \{\s*setCheckError\(refused\)\s*return/.test(send), 'Publicar: a refusal stops the send')

  const momentStart = publicar.indexOf('const send = async () => {')
  const moment = publicar.slice(momentStart, publicar.indexOf('putMoment(', momentStart))
  t.ok(/const refused = refusalOf\(text\)\s*if \(refused !== ''\) \{ setError\(refused\); return false \}/.test(moment), 'Momento: a refusal stops the send before the upload')

  const depo = screen('Depoimentos.js')
  const sheetAt = depo.indexOf('export function WriteTestimonialSheet')
  const writeStart = depo.indexOf('const send = async () => {', sheetAt)
  const write = depo.slice(writeStart, depo.indexOf("request('testimonial.write'", writeStart))
  t.ok(/const refused = refusalOf\(body\)\s*if \(refused !== ''\) \{ setError\(refused\); return \}/.test(write), 'Depoimentos: a refusal stops the write')
  t.ok(write.indexOf('refusalOf(body)') < write.indexOf('action.run('), 'Depoimentos: checked before the action runs')
  const showStart = depo.indexOf('const show = useCallback(')
  const shown = depo.slice(showStart, depo.indexOf("request('testimonial.show'", showStart))
  t.ok(shown.includes('refusalOf(row.text)') && shown.includes('setShowError(refused)'), 'Depoimentos: another person\'s text is checked before it goes on the profile')

  const grupo = screen('Grupo.js')
  const draft = grupo.slice(grupo.indexOf('const sendDraft = () => {'), grupo.indexOf('sendMedia(draft'))
  t.ok(draft.includes('publicGroupRefusal('), 'Grupo: the draft is checked before any send path')
  t.ok(draft.includes("if (refused !== '') return"), 'Grupo: a refusal stops the send')
  t.ok(grupo.includes('<ErrorText>{draftRefusal}</ErrorText>'), 'Grupo: the refusal is shown')
})

test('names and bios cannot be saved with a listed term', (t) => {
  const cases = [
    ['Perfil.js', 'const refused = refusalOf(name, bio)', /const valid = .*refused === ''/, '{refused}'],
    ['NovoGrupo.js', 'const refused = publicGroupRefusal(visibility, trimmed)', /const ready = .*refused === ''/, '{refused}'],
    ['Comunidades.js', 'const refused = refusalOf(trimmed)', /const ready = .*refused === ''/, '{refused}'],
    ['ComunidadeInfo.js', 'const nameRefused = refusalOf(newName)', /const nameOk = .*nameRefused === ''/, '{nameRefused}'],
    ['GrupoAjustes.js', 'const nameRefused = publicGroupRefusal(info?.visibility, newName)', /const nameOk = .*nameRefused === ''/, '{nameRefused}'],
    ['NovaPagina.js', 'const refused = refusalOf(username, name, bio)', /const valid = .*refused === ''/, '{refused}'],
    ['PaginaAjustes.js', 'const profileRefused = form ? refusalOf(form.name, form.bio)', /const formValid = .*profileRefused === ''/, '{profileRefused}'],
    ['PaginaAjustes.js', 'const renameRefused = refusalOf(isUsername(renameHandle))', /disabled=\{renameHandle\.trim\(\) === '' \|\| renameRefused !== ''/, '{renameRefused}']
  ]
  for (const [file, check, gate, shown] of cases) {
    const src = screen(file)
    t.ok(src.includes(check), file + ': checks the text')
    t.ok(gate.test(src), file + ': a refusal blocks the button')
    t.ok(src.includes('<ErrorText>' + shown + '</ErrorText>'), file + ': the refusal is shown')
  }
})

test('a member @nome and a Feira rating are checked before they are sent', (t) => {
  const identidade = screen('Identidade.js')
  const stops = /const refused = refusalOf\(username\)\s*if \(refused !== ''\) return setError\(refused\)\s*run\(/
  for (const start of ['const doLink = () => {', 'const doRename = () => {']) {
    const press = identidade.slice(identidade.indexOf(start))
    t.ok(stops.test(press.slice(0, press.indexOf('run(async') + 4)), 'Identidade: ' + start)
  }

  const avaliar = screen('Avaliar.js')
  const send = avaliar.slice(avaliar.indexOf('const send = async () => {'), avaliar.indexOf("request('listing.rate'"))
  t.ok(/const refused = refusalOf\(text\)\s*if \(refused !== ''\) \{\s*setError\(refused\)\s*return/.test(send), 'Avaliar: a refusal stops the send')
})

test('direct messages, reports and appeals stay out of the check', (t) => {
  for (const file of ['Mensagem.js', 'Mensagens.js', 'NovaConversa.js', 'Denunciar.js', 'Recurso.js']) {
    t.absent(screen(file).includes('wordCheck'), file)
  }
})
