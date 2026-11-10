'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')

const load = () => import('../src/legal.js')

test('legal: version, date and review note', async (t) => {
  const { LEGAL_VERSION, LEGAL_DATE, REVIEW_NOTE } = await load()
  t.is(LEGAL_VERSION, 34)
  t.is(LEGAL_DATE, '09/11/2026')
  t.is(REVIEW_NOTE, 'Versão 34, sujeita a revisão jurídica. Não é parecer jurídico.')
})

test('legal: version 29 has no tolerance for abuse, a real contact, a content license and the age check on the app', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('não tolera conteúdo censurável nem abuso contra outras pessoas'))
  t.absent(text(TERMS).includes('obrigações de conduta'), 'no clause denying conduct rules')
  t.absent(text(TERMS).includes('protótipo'), 'not described as a prototype')
  t.ok(text(TERMS).includes('recusam, no próprio aparelho e antes de publicar ou enviar, publicações, momentos, mensagens de grupo público, nomes, bios e @nomes de pessoas e de páginas, anúncios e avaliações da Feira, cartões de convite, nomes de grupo público ou de comunidade e depoimentos (também ao mostrar no perfil um depoimento recebido)'), 'on-device word check, with what it covers')
  t.ok(text(TERMS).includes('Você pode bloquear outra pessoa'), 'member blocking')
  t.ok(text(PRIVACY).includes('Esse mesmo bloco guarda as pessoas que você bloqueou'), 'block list in the seen block')
  t.ok(TERMS.sections.some(({ heading }) => heading === 'Seu conteúdo'), 'content license section')
  t.ok(text(TERMS).includes('As denúncias funcionam na versão web hospedada e no app ligado à instalação da associação'))
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(text(doc).includes('contato@varanda.app'), doc.title + ': contact address')
    t.absent(text(doc).includes('provisório'), doc.title + ': contact is not provisional')
    t.ok(text(doc).includes('no app ligado à instalação da associação, antes de a conta ser liberada, a idade é confirmada'), doc.title + ': age check on the app')
    t.ok(text(doc).includes('No app com configuração manual'), doc.title + ': the case without the check')
    t.absent(text(doc).includes('ainda não é feita'), doc.title + ': no claim that the app skips the check')
  }
  t.absent(text(PRIVACY).includes('sem fluxo por conta própria'), 'account deletion exists')
  t.ok(text(PRIVACY).includes('o registro de erros do servidor web pode guardar o endereço pedido'), 'search text in the error log')
  t.ok(text(PRIVACY).includes('Quando o operador liga as estatísticas de uso'), 'usage statistics')
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
    // Case-sensitive: "todo" is an ordinary Portuguese word.
    t.absent(/\b(?:TODO|XXX|[Ll]orem)\b|\[/.test(value), 'no placeholders')
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

test('legal: appeals are disclosed in the terms and in the privacy policy', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('o recurso'))
  t.ok(text(TERMS).includes('depois de 30 dias'))
  for (const required of ['o serviço de conta guarda o recurso', 'o texto opcional que a pessoa escreveu', 'a assinatura', 'a observação de quem julgou', 'o recurso não aparece para a própria pessoa nem para quem decidiu a denúncia que bloqueou a conta', 'pode ser revisto por qualquer moderador', 'Denúncias, recursos e decisões não são apagados automaticamente']) {
    t.ok(text(PRIVACY).includes(required), required)
  }
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
  t.is(digest, 'f17c654975e04bf2fa24b9d1478031734d2693336c1fc43d3d81cc131318f51a', 'o texto mudou: suba LEGAL_VERSION (e TERMS_VERSION em @varanda/core lib/terms.js) e atualize este digest')
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

test('legal: pages are described in Terms and Privacy, including end-to-end messages', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.filter(({ heading }) => heading === 'Páginas').flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('Só o dono convida e remove administradores'))
  t.ok(text(TERMS).includes('só vale se ela aceitar'))
  t.ok(text(PRIVACY).includes('lista de administradores'))
  t.ok(text(TERMS).includes('cifradas de ponta a ponta entre o aparelho de quem conversa com a página e os aparelhos do dono e dos administradores'))
  t.ok(text(TERMS).includes('Um administrador removido continua com o que já leu'))
  t.ok(text(TERMS).includes('começa uma caixa nova'))
  t.ok(text(PRIVACY).includes('cifradas de ponta a ponta'))
})

test('legal: version 33 states the residual risks of a page\'s end-to-end Conversas', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const pages = (doc) => doc.sections.filter(({ heading }) => heading === 'Páginas').flatMap(({ paragraphs }) => paragraphs).join(' ')
  const all = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(pages(doc).includes('guarda só envelopes de chave selados'), doc.title + ': sealed envelopes only')
    t.ok(pages(doc).includes('assina as mensagens da página sem vê-las e fica sabendo qual administrador pediu a assinatura de cada mensagem e quando'), doc.title + ': blind signing, who and when')
    t.ok(pages(doc).includes('quais membros guardam as chaves de mensagens da página'), doc.title + ': key holders')
    t.ok(pages(doc).includes('as mensagens que essa pessoa ainda enviar para a chave antiga da página também podem ser lidas pela associação'), doc.title + ': old key after activation')
    t.ok(pages(doc).includes('Por até 8 dias depois da remoção, ele ainda pode enviar, em nome da página, mensagens que já tinha preparado antes de ser removido'), doc.title + ': prepared messages after removal')
    t.absent(pages(doc).includes('o ponto até onde já leu as mensagens da página'), doc.title + ': no service read cursor')
    t.ok(pages(doc).includes('As mensagens escritas antes da ativação podiam ser lidas pelo serviço'), doc.title + ': before activation')
    t.ok(pages(doc).includes('copiadas para o aparelho do dono e depois apagadas no serviço'), doc.title + ': copied, then deleted')
    t.ok(pages(doc).includes('a associação poderia trocar a chave de mensagens publicada da página por uma chave dela'), doc.title + ': key replacement')
    t.ok(pages(doc).includes('se recusam a enviar em nome da página e mostram um aviso quando alguém tenta enviar'), doc.title + ': the warning')
    t.ok(pages(doc).includes('as mensagens enviadas para a chave trocada poderiam ser lidas pela associação'), doc.title + ': until acted on')
    t.ok(pages(doc).includes('receba em 7 dias se perde'), doc.title + ': 7-day collection')
    t.absent(all(doc).includes('Ao conversar com uma Página, a associação pode ler essa conversa'), doc.title + ': no service-readable page chat')
    t.ok(all(doc).includes('A conversa com uma Página que ativou as Conversas privadas é cifrada entre você e quem administra a página'), doc.title + ': Feira line')
  }
  t.absent(pages(TERMS).includes('pode ler as mensagens enviadas para a página'))
  t.absent(pages(PRIVACY).includes('podem ser lidas pelo serviço de conta'))
})

test('legal: version 34 keeps a page\'s private-group key on the owner\'s and admins\' devices', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const pages = (doc) => doc.sections.filter(({ heading }) => heading === 'Páginas').flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.absent(pages(doc).includes('pode ler as publicações da página em grupos privados'), doc.title + ': no service-readable private-group posts')
    t.absent(pages(doc).includes('a caixa dos grupos privados'), doc.title + ': the service holds no group box')
    t.ok(pages(doc).includes('a chave da página fica'), doc.title + ': key on devices')
    t.ok(pages(doc).includes('aparelhos do dono e dos administradores'), doc.title + ': owner and admins')
    t.ok(pages(doc).includes('guarda só as chaves de escrita da página'), doc.title + ': writer keys only')
    t.ok(pages(doc).includes('publicações já cifradas, que ele não consegue ler'), doc.title + ': sealed appends')
    t.ok(pages(doc).includes('As publicações da página em grupos privados escritas antes desta mudança podiam ser lidas pelo serviço'), doc.title + ': before this change')
    t.ok(pages(doc).includes('os administradores do grupo precisam aprovar a página de novo'), doc.title + ': re-admission after an admin removal')
    t.ok(pages(doc).includes('a página sai dele'), doc.title + ': no room, the page leaves')
    t.ok(pages(doc).includes('o dono precisa renovar a chave dos grupos nos ajustes da página'), doc.title + ': legacy page renews')
    t.ok(pages(doc).includes('o administrador removido ainda pode ler as publicações novas daquele grupo'), doc.title + ': removed admin until re-admission')
    t.ok(pages(doc).includes('Ele vê em quais grupos a página está e quando ela publica, mas não o que ela escreve'), doc.title + ': metadata the service sees')
    t.ok(pages(doc).includes('como escritor da página'), doc.title + ': the service appends as the writer')
    t.ok(pages(doc).includes('fica sabendo qual administrador enviou cada publicação da página em grupos privados e quem pediu cada renovação da chave dos grupos'), doc.title + ': which admin sent each post')
  }
  t.ok(pages(TERMS).includes('grupos públicos continua público como a página'))
  t.ok(pages(PRIVACY).includes('Comunidades e grupos públicos continuam públicos'))
})

test('legal: version 15 names the group box, the notices custody, the burned name and the automatic follow', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.filter(({ heading }) => heading === 'Páginas').flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('lê os avisos enviados para a página'))
  t.ok(text(TERMS).includes('o @nome nunca mais é dado a ninguém'))
  t.ok(text(TERMS).includes('passam a seguir a chave nova sozinhos'))
  t.ok(text(TERMS).includes('uma chave guardada naquele aparelho'))
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

test('legal: version 28 describes the Feira listings, offers and ratings', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('pode ser indexado por buscadores'))
  t.ok(text(TERMS).includes('A primeira versão, com texto e fotos, continua no diário até o anúncio ser apagado'))
  t.ok(text(TERMS).includes('não é contrato, e aceitá-la não reserva o anúncio'))
  t.ok(text(TERMS).includes('só depois de quem anuncia ter aceitado a oferta'))
  t.ok(text(TERMS).includes('com os limites descritos em Páginas'))
  t.ok(text(PRIVACY).includes('Os anúncios salvos e as buscas salvas ficam só no seu aparelho'))
  t.ok(text(PRIVACY).includes('feira-invites.json'))
})

test('legal: version 27 describes the invite card in the link and the messenger preview', async (t) => {
  const { PRIVACY } = await load()
  const text = PRIVACY.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text.includes('vai dentro do link, no trecho que o serviço de conta não recebe'))
  t.ok(text.includes('Qualquer pessoa com o link consegue ler o cartão'))
  t.ok(text.includes('por até 24 horas'))
  t.ok(text.includes('só pela chave, a situação pública da conta de quem convida'))
  t.ok(text.includes('o @nome de quem convidou para qualquer pessoa com o link'))
  t.ok(text.includes('sem guardar nada novo'))
})

test('legal: version 28 describes sealed depoimentos shown only by the recipient', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('depoimento de até 400 caracteres'))
  t.ok(text(TERMS).includes('só a pessoa que recebe consegue ler'))
  t.ok(text(TERMS).includes('fica público só o fato de que você escreveu um depoimento para ela'))
  t.ok(text(TERMS).includes('O texto só fica público quando quem recebe escolhe mostrá-lo no próprio perfil'))
  t.ok(text(TERMS).includes('Você pode retirar o seu depoimento a qualquer momento'))
  t.ok(text(TERMS).includes('nunca entrega o texto'))
  t.ok(text(PRIVACY).includes('cifrado de ponta a ponta para a chave de mensagens de quem recebe'))
  t.ok(text(PRIVACY).includes('Se não escolhe, nada é publicado no diário dela'))
  t.ok(text(PRIVACY).includes('quem recebeu pode tirá-lo do perfil apagando o registro dela'))
  t.ok(text(PRIVACY).includes('As duas pessoas podem denunciar a conta da outra'))
  t.ok(text(PRIVACY).includes('perfil, seguidos, depoimentos, momentos, fotos'))
})

test('legal: version 29 describes momentos that disappear but are not erased', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('uma foto e até 200 caracteres de texto, que quem segue você vê por 24 horas'))
  t.ok(text(TERMS).includes('Depois de 24 horas, o momento deixa de aparecer no app'))
  t.ok(text(TERMS).includes('A foto é removida dos servidores da Varanda em até 7 dias'))
  t.ok(text(TERMS).includes('O texto fica no seu diário até você apagar o momento'))
  t.ok(text(TERMS).includes('Sumir não é apagar: cópias que outras pessoas fizeram'))
  t.ok(text(TERMS).includes('não podem ser recolhidas'))
  t.ok(text(PRIVACY).includes('a chave para abri-la fica no próprio registro, de propósito'))
  t.ok(text(PRIVACY).includes('A foto é removida dos servidores da Varanda em até 7 dias'))
  t.ok(text(PRIVACY).includes('sumir não é apagar'))
  t.ok(text(PRIVACY).includes('A foto de um momento fica no semeador por até 7 dias, sem renovação'))
  t.ok(text(PRIVACY).includes('perfil, seguidos, depoimentos, momentos, fotos'))
})
