'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')

const load = () => import('../src/legal.js')

test('legal: version, date and review note', async (t) => {
  const { LEGAL_VERSION, LEGAL_DATE, REVIEW_NOTE } = await load()
  t.is(LEGAL_VERSION, 24)
  t.is(LEGAL_DATE, '06/11/2026')
  t.is(REVIEW_NOTE, 'Versão 24, sujeita a revisão jurídica. Não é parecer jurídico.')
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
  t.is(digest, 'd5b887d2fccd9299061effbeb08bd842ffaed41509a480fe1cb3352e362b6dd3', 'o texto mudou: suba LEGAL_VERSION (e TERMS_VERSION em @varanda/core lib/terms.js) e atualize este digest')
})

test('legal: version 19 describes extra passkeys and the recovery code for the same account', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.absent(/outra passkey (?:cria|corresponde a) outra conta/i.test(text(doc)), doc.title + ': no other account per passkey')
    t.absent(text(doc).includes('Perder a passkey é perder a conta'), doc.title + ': no loss of account per passkey')
    t.ok(text(doc).includes('até quatro outras passkeys e um código de recuperação para a mesma conta'), doc.title + ': extra passkeys')
    t.ok(text(doc).includes('criação de uma passkey nova naquele aparelho'), doc.title + ': code ends with a new passkey')
    t.ok(text(doc).includes('Sem nenhuma passkey e sem o código, a conta não pode ser recuperada'), doc.title + ': no recovery without both')
    t.ok(text(doc).includes('Adicionar uma passkey ou um código de recuperação exige a conta vinculada ao Google'), doc.title + ': extra entries need a Google-linked account')
    // The original passkey is never looked up at the service; an added passkey
    // or the code is fetched from it at every new sign-in ceremony.
    t.ok(text(doc).includes('também sem internet, em qualquer aparelho'), doc.title + ': original passkey works offline')
    t.ok(text(doc).includes('Uma passkey adicionada ou o código precisa'), doc.title + ': added passkey or code needs the service')
    t.ok(text(doc).includes('toda vez que você entra de novo com ela ou com ele'), doc.title + ': at every new sign-in')
    t.ok(text(doc).includes('uma sessão que continua aberta no aparelho não precisa'), doc.title + ': a kept session avoids it')
    t.absent(text(doc).includes('Num aparelho novo, a primeira entrada'), doc.title + ': no first-use-only claim')
  }
  t.ok(text(TERMS).includes('Passkeys e recuperação'))
  t.ok(text(PRIVACY).includes('um texto cifrado que ele não consegue abrir'))
  t.ok(text(PRIVACY).includes('um identificador que ele não consegue ligar a uma passkey'))
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
  for (const planned of ['encaminhar']) {
    t.absent(text(TERMS).includes(planned) || text(PRIVACY).includes(planned), 'not described as available: ' + planned)
  }
})

test('legal: version 18 describes voice notes in chats and the report audio', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('mensagem de voz de até dois minutos'))
  t.ok(text(TERMS).includes('só pede acesso ao microfone quando você começa a gravar'))
  t.ok(text(TERMS).includes('o botão de gravar não aparece'))
  t.ok(text(TERMS).includes('só os aparelhos dos membros conseguem ouvi-la'))
  t.ok(text(TERMS).includes('Vídeos não são aceitos'))
  t.ok(text(PRIVACY).includes('As conversas não aceitam vídeo'))
  t.ok(text(PRIVACY).includes('o áudio vai junto com a denúncia, aberto'))
  t.ok(text(PRIVACY).includes('se tiver até 700 KB'))
})

test('legal: version 20 describes GIF search through the account service', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('Quando a associação liga a busca de GIFs'))
  t.ok(text(TERMS).includes('O provedor recebe só o texto da busca'))
  t.ok(text(TERMS).includes('quem recebe nunca fala com o provedor'))
  t.ok(text(TERMS).includes('até 120 buscas e 60 GIFs por dia'))
  t.ok(text(TERMS).includes('o botão não aparece'))
  t.ok(text(PRIVACY).includes('não guarda o texto das buscas'))
  t.ok(text(PRIVACY).includes('a partir do endereço da associação'))
  t.ok(text(PRIVACY).includes('esse provedor pode estar fora do Brasil'))
  for (const name of ['Giphy', 'GIPHY', 'Tenor', 'Klipy']) {
    t.absent(text(TERMS).includes(name) || text(PRIVACY).includes(name), 'no provider name: ' + name)
  }
})

test('legal: version 22 describes Excluir conta, what goes, what stays and the 7 days', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(text(doc).includes('Ajustes, na tela Excluir conta'), doc.title + ': where to delete')
    t.absent(text(doc).includes('exclusão de conta por conta própria'), doc.title + ': no claim that it is missing')
    t.absent(text(doc).includes('não permite excluir a conta'), doc.title + ': no claim that it is missing')
  }
  t.ok(text(TERMS).includes('em até 7 dias'))
  t.ok(text(TERMS).includes('encerrá-la ou transferi-la antes'))
  t.ok(text(TERMS).includes('deixam de existir para todos os participantes'))
  t.ok(text(PRIVACY).includes('Ficam a chave pública, a data da exclusão e os @nomes já usados'))
  t.ok(text(PRIVACY).includes('A mesma conta Google pode criar uma conta nova'))
})

test('legal: version 23 describes the passkey key the service keeps and the 7-day wait without it', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('a exclusão fica agendada por 7 dias'))
  t.ok(text(TERMS).includes('você pode cancelar de qualquer um deles'))
  t.ok(text(PRIVACY).includes('o serviço de conta guarda o identificador, a chave pública, um contador do autenticador e a data'))
  t.ok(text(PRIVACY).includes('não guarda nenhum segredo da passkey'))
  t.ok(text(PRIVACY).includes('cancelar o pedido apaga só a data'))
})

test('legal: version 24 describes link previews built once and never fetched by readers', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('No app nativo, quem monta a prévia é o aparelho de quem envia'))
  t.ok(text(TERMS).includes('que lê o link uma vez, a partir do próprio endereço, e não guarda nada'))
  t.ok(text(TERMS).includes('uma imagem de até 32 KB'))
  t.ok(text(TERMS).includes('Quem lê nunca fala com o site'))
  t.ok(text(TERMS).includes('A chave Prévia de links, em Ajustes, desliga a montagem'))
  t.ok(text(TERMS).includes('os cartões que outras pessoas enviam continuam aparecendo'))
  t.ok(text(TERMS).includes('até 60 prévias por dia'))
  t.ok(text(PRIVACY).includes('O serviço não guarda o link, o título nem a imagem'))
  t.ok(text(PRIVACY).includes('Quem lê nunca fala com o site'))
  t.ok(text(PRIVACY).includes('A chave Prévia de links, em Ajustes, desliga a montagem'))
})
