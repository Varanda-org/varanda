'use strict'

const test = require('brittle')
const { PEEK_RULE } = require('@varanda/core/lib/peek')
const load = () => import('../src/help.js')

test('help keys match the supported tabs and setup steps', async (t) => {
  const { HELP } = await load()
  t.alike(Object.keys(HELP).sort(), [
    'rua', 'espiadinha', 'seguindo', 'avisos', 'diario', 'entrar', 'vinculo',
    'identidade', 'certificado', 'perfil', 'busca', 'ausentes', 'bloqueio',
    'instalar', 'denuncia', 'termosAparelho', 'convites', 'carteira'
  ].sort())
})

test('help and short texts are non-empty and frozen', async (t) => {
  const { HELP, SHORT } = await load()
  t.ok(Object.isFrozen(HELP))
  t.ok(Object.isFrozen(SHORT))
  for (const [key, entry] of Object.entries(HELP)) {
    t.ok(Object.isFrozen(entry), key + ' is frozen')
    t.alike(Object.keys(entry).sort(), ['paragraphs', 'title'])
    t.ok(typeof entry.title === 'string' && entry.title.trim().length > 0, key + ' has a title')
    t.ok(Array.isArray(entry.paragraphs) && entry.paragraphs.length > 0, key + ' has paragraphs')
    t.ok(Object.isFrozen(entry.paragraphs), key + ' paragraphs are frozen')
    for (const paragraph of entry.paragraphs) {
      t.ok(typeof paragraph === 'string' && paragraph.trim().length > 0, key + ' has non-empty text')
    }
  }
  for (const value of Object.values(SHORT)) {
    t.ok(typeof value === 'string' && value.trim().length > 0)
  }
})

test('help preserves the peek rule and search explanation', async (t) => {
  const { HELP } = await load()
  const { SEARCH_HINT, SEARCH_MEMORY } = await import('../src/topics.js')
  t.is(HELP.espiadinha.paragraphs[0], PEEK_RULE)
  t.is(HELP.busca.paragraphs[0], SEARCH_HINT)
  t.ok(HELP.busca.paragraphs[0].includes('"ceu" encontra "Céu" e "#Céu"'))
  t.is(HELP.busca.paragraphs[1], SEARCH_MEMORY)
})

test('link help keeps the account and privacy disclosures', async (t) => {
  const { HELP, SHORT } = await load()
  const text = HELP.vinculo.paragraphs.join(' ')
  for (const fact of [
    'confirme uma conta Google e escolha seu @nome',
    'vínculo entre a conta Google e a sua conta Varanda',
    'liberar sua conta e seu @nome', 'ordem judicial', 'bloquear a conta',
    'e-mail nunca', 'seu diário', 'seu perfil', 'este navegador',
    'idade não é verificada', 'Política de Privacidade', 'Ajustes → Termos e privacidade',
    'pedir sua passkey de novo', '3 a 20 letras minúsculas, números ou _, começando por letra',
    'Você pode trocá-lo depois', '7 dias'
  ]) {
    t.ok(text.includes(fact), fact)
  }
  for (const fact of ['associação', 'Google', 'e-mail nunca']) {
    t.ok(SHORT.link.includes(fact), fact)
  }
})

test('invite help keeps the validity, renewal and privacy facts', async (t) => {
  const { HELP } = await load()
  const text = HELP.convites.paragraphs.join(' ')
  for (const fact of ['uma pessoa só', '7 dias', 'segunda-feira', 'horário de Brasília', 'não acumulam', 'nunca o nome, o e-mail']) {
    t.ok(text.includes(fact), fact)
  }
  t.ok(HELP.vinculo.paragraphs.join(' ').includes('Se a rede estiver por convite,'))
})

test('missing diaries help covers all eight skip reasons', async (t) => {
  const { HELP } = await load()
  const text = HELP.ausentes.paragraphs[0]
  for (const reason of [
    'não está liberada pela associação', 'foi bloqueada', 'teve a liberação cancelada',
    'o histórico dele não confere', 'o diário ficou grande demais',
    'uma publicação dele é grande demais para ler', 'não respondeu a tempo',
    'não há publicação no trecho lido'
  ]) {
    t.ok(text.includes(reason), reason)
  }
})

test('installation help keeps browser instructions and local storage limits', async (t) => {
  const { HELP, SHORT } = await load()
  const text = [SHORT.install, ...HELP.instalar.paragraphs].join(' ')
  for (const fact of [
    'Abra o menu do navegador e escolha instalar o app',
    'No iPhone: Compartilhar e depois Adicionar à Tela de Início',
    'No Android, instale pelo Chrome', 'No Samsung Internet a instalação fica desligada',
    'porque o Android bloqueia o app que esse navegador cria',
    'No Chrome, entre com a mesma passkey',
    'abre mesmo sem internet e mostra o que já está neste aparelho',
    'Apagar os dados do site apaga o que está guardado aqui',
    'Outra aba deste navegador fica bloqueada enquanto esta estiver aberta'
  ]) {
    t.ok(text.includes(fact), fact)
  }
})

test('help and short texts avoid jargon and em dashes', async (t) => {
  const { HELP, SHORT } = await load()
  const jargon = new Set([
    'semeador', 'semeadores', 'nó', 'nós', 'chave', 'chaves', 'certificado',
    'certificados', 'bootstrap', 'dht', 'hypercore', 'índice', 'índices', 'indice'
  ])
  const texts = [
    ...Object.values(HELP).flatMap(({ title, paragraphs }) => [title, ...paragraphs]),
    ...Object.values(SHORT)
  ]
  for (const text of texts) {
    t.absent(text.includes('\u2014'), 'no em dash: ' + text)
    const words = text.toLowerCase().split(/[^a-zà-ÿ0-9]+/)
    t.alike(words.filter((word) => jargon.has(word)), [], 'no jargon: ' + text)
  }
})

test('wallet help lists only the fees of features the mode offers', async (t) => {
  const { HELP, carteiraHelp } = await load()
  const fees = { payout: 'sem taxa', transfer: 'sem taxa', crypto: 'R$ 1,00 + 1%' }
  const pix = carteiraHelp({ mode: 'pix', fees, maxCents: null })
  const pixFee = pix.paragraphs.find((p) => p.startsWith('Taxa da Varanda hoje.'))
  t.is(pixFee, 'Taxa da Varanda hoje. Pagar por Pix: sem taxa. Receber por Pix: sem taxa da Varanda.')
  t.absent(pix.paragraphs.some((p) => p.includes('Enviar para')))
  const full = carteiraHelp({ mode: 'completo', fees, maxCents: null })
  const fullFee = full.paragraphs.find((p) => p.startsWith('Taxa da Varanda hoje.'))
  t.is(fullFee, 'Taxa da Varanda hoje. Pagar por Pix: sem taxa. Enviar para alguém da Varanda: sem taxa. Enviar para outra carteira: R$ 1,00 + 1%. Receber por Pix: sem taxa da Varanda.')
  t.is(carteiraHelp(null), HELP.carteira)
  t.ok(HELP.carteira.paragraphs[0].includes('quando o serviço liberar'))
  t.absent(HELP.carteira.paragraphs.some((p) => p.includes('próximas versões') || p.includes('Quando enviar dinheiro estiver disponível')))
})
