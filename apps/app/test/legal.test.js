'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')

const load = () => import('../src/legal.js')

test('legal: version, date and review note', async (t) => {
  const { LEGAL_VERSION, LEGAL_DATE, REVIEW_NOTE } = await load()
  t.is(LEGAL_VERSION, 102)
  t.is(LEGAL_DATE, '19/11/2026')
  t.is(REVIEW_NOTE, 'Versão 102, sujeita a revisão jurídica. Não é parecer jurídico.')
})

test('legal: this version describes music covers as never stored', async (t) => {
  const { TERMS, PRIVACY } = await load()
  for (const [doc, prefix] of [[TERMS, 'Quando a associação liga as capas'], [PRIVACY, 'Capas: quando a associação liga as capas']]) {
    const paragraph = doc.sections.find((s) => s.heading === 'Música do Audius').paragraphs.find((p) => p.startsWith(prefix)) || ''
    t.ok(/nunca é guardada|não é guardada/.test(paragraph), doc.title + ': covers are never stored')
    t.ok(paragraph.includes('na publicação nem no momento') || paragraph.includes('na publicação, no momento nem em arquivo'), doc.title + ': no cover in posts or momentos')
    t.ok(paragraph.includes('enquanto o app está aberto'), doc.title + ': device memory lasts only for the app session')
  }
  const terms = TERMS.sections.find((s) => s.heading === 'Música do Audius').paragraphs.join(' ')
  for (const required of [
    'só mostrar o cartão não faz pedidos',
    'num momento, só depois que o trecho começa a tocar; numa publicação, só depois do seu toque no cartão',
    'Sem capa, o app mostra um quadro com o símbolo de música'
  ]) t.ok(terms.includes(required), required)
  const section = (heading) => PRIVACY.sections.find((s) => s.heading === heading).paragraphs.join(' ')
  t.ok(section('Música do Audius').includes('mantém a imagem só na memória por até 10 minutos e não a grava em disco nem em registros'))
  t.ok(section('Por quanto tempo').includes('As capas ficam só na memória do serviço, por até 10 minutos, e a contagem diária de capas por membro também fica só na memória; ambas desaparecem ao reiniciar'))
  t.ok(section('Compartilhamento e cópias fora do Brasil').includes('Para as capas, o servidor de imagens indicado pelo Audius recebe o endereço da associação e o caminho da imagem'))
})

test('legal: version 39 describes music through the account service', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const required of [
    'Quando a associação liga a música, você pode buscar no catálogo do Audius, de artistas independentes',
    'anexar um trecho de 15 segundos, uma faixa inteira ou uma playlist a uma publicação',
    'Se a associação também ligar a música nos momentos, você poderá anexar um trecho de 15 segundos a um momento',
    'Um link do Audius que você cola numa publicação também pode virar um cartão de música',
    'Há limites diários de uso',
    'Todo cartão de música mostra o artista, o título, a fonte Audius e um link para a página da faixa ou da playlist',
    'A publicação guarda o título, o artista e esse link, como qualquer cartão de link',
    'A música vem do Audius, sob a licença própria do serviço, e pode deixar de estar disponível',
    'Uma faixa que infringe direitos deve ser denunciada ao Audius'
  ]) t.ok(text(TERMS).includes(required), required)
  for (const doc of [TERMS, PRIVACY]) {
    for (const required of [
      'o texto da busca, a posição e o tamanho da página de resultados, o identificador da faixa ou da playlist ou o link colado',
      'a partir do endereço da associação',
      'nunca o endereço de internet do seu aparelho, a sua chave ou o seu token de acesso',
      'O áudio passa pelo serviço de conta da associação, que não guarda uma cópia',
      'Os cartões de música do Audius nas publicações do diário passam pelo serviço de conta, como descrito em Música do Audius, também no app nativo',
      'Nas conversas, nos grupos ou quando a música não está disponível ao compor uma publicação, um link do Audius é tratado como qualquer outro link',
      'Nesses casos, no app nativo, a prévia é buscada pelo aparelho de quem envia, diretamente no site',
      'O app nunca carrega um quadro do Audius'
    ]) t.ok(text(doc).includes(required), doc.title + ': ' + required)
  }
  const section = (heading) => (PRIVACY.sections.find((s) => s.heading === heading)?.paragraphs || []).join(' ')
  for (const required of [
    'O serviço vê o texto da busca, a posição da página de resultados, o link colado, o identificador da faixa ou da playlist e o áudio em trânsito',
    'Os registros do serviço de conta não levam texto de busca, link, identificador de faixa ou playlist nem ticket',
    'só mostrar o cartão não faz pedido ao Audius nem ao serviço de conta',
    'O app nunca carrega um quadro do Audius'
  ]) t.ok(section('Música do Audius').includes(required), required)
  t.ok(section('Finalidades e bases legais propostas').includes('Música do Audius: para buscar, anexar e ouvir a música que você escolhe, inclusive a de uma publicação em que você toca, e para pedir a capa depois desse toque, a base legal proposta é execução de contrato, Art. 7º, V, ainda sujeita a parecer jurídico'))
  for (const required of [
    'Na música do Audius, o serviço de conta não guarda a busca nem o áudio',
    'Os metadados dos itens e os tickets ficam só na memória e desaparecem ao reiniciar o serviço',
    'Seus prazos são de validade, não de remoção',
    'um item vencido pode continuar na memória até um uso posterior, uma substituição ou um reinício',
    'O título, o artista e o link ficam na publicação e seguem a retenção dela'
  ]) t.ok(section('Por quanto tempo').includes(required), required)
  for (const required of [
    'Na música do Audius, podem sair do Brasil o texto da busca, a posição e o tamanho da página de resultados, o identificador da faixa ou da playlist ou o link colado e o endereço da associação',
    'O Audius pode tratar esses dados fora do Brasil',
    'O mecanismo dessa transferência internacional, conforme a Resolução CD/ANPD nº 19/2024, ainda será confirmado por parecer jurídico'
  ]) t.ok(section('Compartilhamento e cópias fora do Brasil').includes(required), required)
  const terms = TERMS.sections.find((s) => s.heading === 'Música do Audius').paragraphs.join(' ')
  t.ok(terms.includes('Num momento, se a associação ligar a música nos momentos, ver um momento com música, inclusive um seu, já pede o trecho de 15 segundos ao serviço de conta, sem um toque à parte; o trecho toca em seguida, a não ser que o navegador só deixe tocar som depois de um toque. Num momento aberto com o som silenciado, o app só pede o trecho quando você ativa o som. O Audius continua recebendo só o endereço da associação.'), 'terms: momento music starts on view')
  t.ok(section('Música do Audius').includes('Num momento, se a associação ligar a música nos momentos, ver um momento com música, inclusive um seu, já pede o trecho de 15 segundos ao serviço de conta, sem um toque à parte; o trecho toca em seguida, a não ser que o navegador só deixe tocar som depois de um toque.'), 'privacy: momento music starts on view')
})

test('legal: version 50 asks for the next momento snippet ahead, never while muted', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const terms = TERMS.sections.find((s) => s.heading === 'Música do Audius').paragraphs.join(' ')
  t.ok(terms.includes('Enquanto você vê os momentos, o app pode pedir ao serviço de conta o trecho do momento seguinte um pouco antes de ele aparecer, no máximo um à frente, sem a capa e nunca com o som silenciado.'), 'terms: one momento ahead, no cover, not muted')
  const privacy = PRIVACY.sections.find((s) => s.heading === 'Música do Audius').paragraphs.join(' ')
  for (const required of [
    'Enquanto você vê os momentos, o app também pode pedir antes o trecho do momento seguinte, quando ele tem música, para que a música possa começar junto com a foto: pede a faixa e a permissão para tocá-la e, às vezes, o começo do áudio, sem tocar nada antes de o momento aparecer.',
    'Por isso o serviço fica sabendo que a sua conta pediu aquela faixa, mesmo que você não chegue a esse momento.',
    'Com o som silenciado, o app não pede nada antes.',
    'Esse pedido antecipado conta nos mesmos limites diários de uso.',
    'A capa continua sendo pedida só depois que a música daquele momento começa a tocar.',
    'O áudio não é guardado no aparelho.'
  ]) t.ok(privacy.includes(required), 'privacy: ' + required)
  t.ok(PRIVACY.sections.find((s) => s.heading === 'Finalidades e bases legais propostas').paragraphs.join(' ').includes('A mesma base legal proposta vale para pedir e tocar o trecho de um momento com música quando ele aparece e, um pouco antes, para pedir o trecho do momento seguinte da fila.'), 'privacy: legal basis covers momento music and the next snippet')
  const retention = PRIVACY.sections.find((s) => s.heading === 'Por quanto tempo').paragraphs.join(' ')
  t.ok(retention.includes('No aparelho, o título, o artista e o link da faixa de um momento ficam só na memória, enquanto o momento está na tela e, depois, por até 10 minutos, para o app não pedir de novo; saem quando o app é bloqueado, quando você sai da conta ou troca de conta e quando o app fecha; o app não guarda o áudio.'), 'privacy: device keeps momento track info in memory only')
})

test('legal: version 46 sends a momento reaction as a private message', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const terms = TERMS.sections.find((s) => s.heading === 'Fotos, vídeos e recursos planejados').paragraphs.join(' ')
  for (const required of [
    'Num momento de outra pessoa, tocar num dos seis emojis rápidos envia uma mensagem privada só para quem o publicou, como as outras mensagens diretas.',
    'Não há contagem pública, lista de quem reagiu nem registro no diário.'
  ]) t.ok(terms.includes(required), 'terms: ' + required)
  const privacy = PRIVACY.sections.find((s) => s.heading === 'Diário, perfil, fotos e vídeos').paragraphs.join(' ')
  for (const required of [
    'Uma reação a um momento é enviada como uma mensagem direta a quem o publicou: leva o emoji, o número do registro do momento no diário dessa pessoa, a hora e a sua conta como remetente, cifrados como qualquer mensagem direta.',
    'Nada da foto ou do vídeo é copiado.',
    'A conversa mostra uma prévia pequena só enquanto o app ainda mostra o momento.',
    'A reação gasta selos de envio como uma mensagem e não pode ser removida.',
    'Um app que não foi atualizado não a mostra.'
  ]) t.ok(privacy.includes(required), 'privacy: ' + required)
})

test('legal: version 47 sentences on post video sound, momento music and covers still hold', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const terms = TERMS.sections.find((s) => s.heading === 'Música do Audius').paragraphs.join(' ')
  for (const required of [
    'Num vídeo de publicação, os controles do próprio vídeo também podem ligar o som daquele vídeo.',
    'Num momento aberto com o som silenciado, o app só pede o trecho quando você ativa o som.',
    'O Audius continua recebendo só o endereço da associação.',
    'o serviço de conta busca a capa da faixa ou da playlist',
    'maior enquanto você escolhe o trecho'
  ]) t.ok(terms.includes(required), 'terms: ' + required)
  for (const gone of [
    'silencia a música das publicações até você tocar',
    'para ouvir numa publicação, você precisa tocar',
    'capa pequena',
    'só depois que você toca para ouvir'
  ]) t.absent(terms.includes(gone), 'terms: no ' + gone)
  const privacy = PRIVACY.sections.find((s) => s.heading === 'Música do Audius').paragraphs.join(' ')
  for (const required of [
    'quem compõe uma publicação pode buscar no Audius ou colar um link dele, e quem lê pode ouvir.',
    'o trecho toca em seguida, a não ser que o navegador só deixe tocar som depois de um toque. Num momento aberto com o som silenciado, o app só pede o trecho quando você ativa o som.',
    'o serviço de conta pede a capa ao servidor de imagens indicado pelo Audius'
  ]) t.ok(privacy.includes(required), 'privacy: ' + required)
  for (const gone of [
    'quem lê pode tocar para ouvir',
    'Só mostrar um cartão não faz pedido',
    'capa pequena'
  ]) t.absent(privacy.includes(gone), 'privacy: no ' + gone)
})

test('legal: version 49 keeps a loaded music player at any scroll distance', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('Ao carregar, o serviço recebe o endereço de internet do seu aparelho'), 'terms: player sends the device address')
  t.ok(text(PRIVACY).includes('Ao carregar, o provedor recebe o endereço de internet do seu aparelho'), 'privacy: player sends the device address')
  t.ok(text(TERMS).includes('o serviço continua em contato com o seu aparelho'), 'terms: an offscreen player keeps contact')
  t.ok(text(PRIVACY).includes('o provedor continua em contato com o seu aparelho'), 'privacy: an offscreen player keeps contact')
  for (const doc of [TERMS, PRIVACY]) {
    for (const required of [
      'Um link de YouTube, SoundCloud, Spotify ou Apple Music pode aparecer como um cartão com o player do próprio serviço',
      'numa publicação, numa citação, numa conversa privada, num grupo e na prévia enquanto você escreve',
      'mas fica sabendo que o seu aparelho mostrou aquele item, e quando',
      'Na prévia enquanto você escreve, o player pode carregar assim que a prévia fica pronta e aparece na tela, antes de você publicar ou enviar; enquanto o teclado cobre a prévia, ele não carrega.',
      'O player carrega sozinho um pouco antes de o cartão aparecer',
      'pode usar cookies e outros dados que o serviço guarda no aparelho',
      'O player não começa com som: o som só sai quando você toca o play dentro do player',
      'Ouvir músicas completas depende do serviço',
      'Um toque num link dentro do player abre, fora do Varanda, o endereço indicado pelo player',
      'no app instalado (Android e iOS), só endereços do próprio serviço são abertos',
      'na versão web, inclusive instalada na tela inicial, o link abre em outra aba, e o Varanda não confere o endereço',
      'um toque na capa não abre o link',
      'No máximo quatro players ficam carregados ao mesmo tempo'
    ]) t.ok(text(doc).includes(required), doc.title + ': ' + required)
    for (const gone of [
      'Tocar aqui',
      'não faz nenhum pedido a esses serviços',
      'A partir desse toque',
      'Tocar é opcional',
      'O cartão traz um link',
      'Rolar o cartão para fora da tela',
      'no aplicativo, só endereços do próprio serviço',
      'abre a página do serviço fora do Varanda',
      'quando o cartão fica longe na lista'
    ]) t.absent(text(doc).includes(gone), doc.title + ': no ' + gone)
  }
  const section = (heading) => PRIVACY.sections.find((s) => s.heading === heading).paragraphs.join(' ')
  const thirdParties = section('Compartilhamento e cópias fora do Brasil')
  for (const required of [
    'informações do navegador ou app (user agent)',
    'Também recebe, como referência (referrer), o endereço do site ou, no app, um endereço fixo do app Varanda',
    'O provedor é o controlador desses dados',
    'podem ser tratados fora do Brasil por esse provedor'
  ]) t.ok(thirdParties.includes(required), required)
  t.ok(section('Finalidades e bases legais propostas').includes('Players de música de terceiros, carregados um pouco antes de o cartão aparecer: para mostrar a publicação, a mensagem ou a prévia com o player do link publicado ou enviado, a base legal proposta é execução de contrato, Art. 7º, V, ainda sujeita a parecer jurídico'))
  const retention = section('Por quanto tempo')
  t.ok(retention.includes('Nos players de YouTube, SoundCloud, Spotify e Apple Music, a associação não guarda os dados enviados ao provedor pelo player de música nem um histórico do que você ouve'))
  t.ok(retention.includes('A retenção pelo provedor segue a política dele; o cartão continua guardado como a publicação ou a mensagem em que ele está.'))
})

test('legal: version 51 preloads music players before the card appears', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    for (const required of [
      'O player carrega sozinho um pouco antes de o cartão aparecer, quando o item está perto da parte visível da lista na tela que você está olhando',
      'também para itens aos quais você nunca chega a rolar, inclusive numa conversa privada ou num grupo',
      'No máximo quatro players ficam carregados ao mesmo tempo, e menos (nunca menos de dois) depois que o sistema fecha players por falta de memória',
      'Um player em que você não tocou continua carregado',
      'quando você troca de aba, abre outra tela, um menu, um painel ou uma foto ampliada',
      'Um player em que você tocou fecha nesses casos, quando outro áudio do Varanda começa',
      'Todo player fecha quando o aplicativo é bloqueado ou vai para segundo plano',
      'ou quando um cartão mais perto precisa do lugar dele'
    ]) t.ok(text(doc).includes(required), doc.title + ': ' + required)
    for (const gone of ['no máximo dois ficam carregados', 'quando o cartão fica visível na tela', 'a qualquer distância', 'sempre pronto']) {
      t.absent(text(doc).includes(gone), doc.title + ': no ' + gone)
    }
  }
})

test('legal: version 52 shows a provider cover until the player loads and fetches it at compose time', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  const domains = '(subdomínios de ytimg.com, scdn.co, sndcdn.com e mzstatic.com; para um vídeo do YouTube, a miniatura padrão em i.ytimg.com)'
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(text(doc).includes('Até a página do provedor carregar, o lugar do player mostra uma capa do mesmo tamanho, feita só com o cartão guardado (a imagem, o título e o nome do serviço), sem buscar nada para desenhá-la, e um toque na capa não abre o link.'), doc.title + ': cover until the player loads')
    t.ok(text(doc).includes(domains), doc.title + ': provider image domains')
    t.ok(text(doc).includes('Quem lê nunca fala com o site para mostrar o cartão'), doc.title + ': readers fetch nothing')
    for (const gone of ['o cartão guardado continua como cartão de link', 'um toque no cartão abre o link']) {
      t.absent(text(doc).includes(gone), doc.title + ': no ' + gone)
    }
  }
  t.ok(text(TERMS).includes('Para um link de YouTube, SoundCloud, Spotify ou Apple Music, a imagem pequena é a capa do próprio serviço, buscada uma vez, quando a prévia é montada, quando possível: no app nativo, o aparelho de quem envia busca a capa só nos endereços de imagem do próprio serviço ' + domains + '; na versão web hospedada, o serviço de conta busca a imagem que a página indica, como em qualquer prévia, e, para um vídeo do YouTube, a mesma miniatura; se a busca falhar, o cartão fica sem imagem.'))
  t.ok(text(PRIVACY).includes('Para um link de YouTube, SoundCloud, Spotify ou Apple Music, o aparelho de quem envia também fala com o endereço de imagem do próprio serviço ' + domains + ', para buscar a capa uma vez, quando possível; na versão web hospedada, o serviço de conta busca a imagem que a página indica, como em qualquer prévia, e, para um vídeo do YouTube, a mesma miniatura.'))
  for (const doc of [TERMS, PRIVACY]) {
    t.absent(text(doc).includes('ou o serviço de conta na versão web hospedada, também fala com o endereço de imagem'), doc.title + ': the service is not limited to the provider image domains')
  }
})

test('legal: version 53 makes post music wait for a tap, stops it off screen and keeps the sound mute on the device', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  const section = (doc, heading) => doc.sections.find((s) => s.heading === heading).paragraphs.join(' ')
  const terms = section(TERMS, 'Música do Audius')
  for (const required of [
    'Numa publicação, um trecho de 15 segundos, uma faixa inteira ou uma playlist aparece como um cartão que espera o seu toque, e a música nunca começa sozinha: só mostrar o cartão não faz pedidos ao serviço de conta nem ao Audius, e o app pede a música só quando você toca no cartão.',
    'Depois do seu toque, uma faixa ou uma playlist pausa, e um trecho para, pouco depois de a publicação sair da parte visível da tela, e um pedido que ainda está carregando é cancelado; a música não volta a tocar sozinha.',
    'Ela também para quando você muda de tela ou sai do app.',
    'O botão de som de um vídeo de publicação ou de um momento (Silenciar som e Ativar som) silencia o som: o som dos vídeos das publicações e a música e o som dos vídeos dos momentos ficam mudos até você ativar o som de novo.',
    'Essa escolha fica guardada neste aparelho, num pequeno arquivo do app no Android e no iPhone e no armazenamento local do navegador (localStorage) na web, continua valendo depois de fechar e abrir o app ou recarregar a página e não é enviada a ninguém.',
    'Ela não silencia um cartão de música do Audius em que você toca nem os players de YouTube, SoundCloud, Spotify e Apple Music.',
    'num momento, só depois que o trecho começa a tocar; numa publicação, só depois do seu toque no cartão.',
    'Num momento, se a associação ligar a música nos momentos, ver um momento com música, inclusive um seu, já pede o trecho de 15 segundos ao serviço de conta, sem um toque à parte; o trecho toca em seguida, a não ser que o navegador só deixe tocar som depois de um toque.'
  ]) t.ok(terms.includes(required), 'terms: ' + required)
  const privacy = section(PRIVACY, 'Música do Audius')
  for (const required of [
    'Numa publicação, com um trecho, uma faixa ou uma playlist, só mostrar o cartão não faz pedido ao Audius nem ao serviço de conta: o app pede a música, e depois a capa, só quando você toca no cartão.',
    'A escolha de silenciar o som fica guardada neste aparelho, num pequeno arquivo do app no Android e no iPhone e no armazenamento local do navegador (localStorage) na web, continua valendo depois de fechar e abrir o app ou recarregar a página, até você ativar o som de novo, e não é enviada a ninguém.',
    'Ela não silencia um cartão de música do Audius em que você toca nem os players de YouTube, SoundCloud, Spotify e Apple Music.'
  ]) t.ok(privacy.includes(required), 'privacy: ' + required)
  t.ok(section(PRIVACY, 'Finalidades e bases legais propostas').includes('Música do Audius: para buscar, anexar e ouvir a música que você escolhe, inclusive a de uma publicação em que você toca, e para pedir a capa depois desse toque, a base legal proposta é execução de contrato'), 'privacy: legal basis needs a tap for post music')
  for (const doc of [TERMS, PRIVACY]) {
    for (const required of [
      'Um player em que você tocou fecha nesses casos, quando outro áudio do Varanda começa e pouco depois de o cartão sair da parte visível da lista: o Varanda não consegue pausar o player, então o fecha, e, quando você volta ao cartão, ele mostra a capa e um player novo, sem som.',
      'No app para Android e iPhone, um player em tela cheia continua aberto. Fora da tela cheia, quando a tela gira ou a janela muda de retrato para paisagem ou de volta, como pode acontecer na versão web, no iPad e em aparelhos Android de tela grande, um player em que você tocou pode continuar aberto depois de o cartão sair da parte visível da lista, até outro player começar, você bloquear o aparelho ou trocar de tela.',
      'Com um leitor de tela ligado, um player que esteve na parte visível da lista conta como um player em que você tocou.',
      'Um player em que você não tocou continua carregado',
      'O som que você iniciou pode continuar enquanto o player está aberto, inclusive em tela cheia e no pouco tempo entre o cartão sair da parte visível da lista e o player fechar.'
    ]) t.ok(text(doc).includes(required), doc.title + ': ' + required)
    for (const gone of [
      'Tocar música sozinha',
      'adesivo de música',
      'adesivo',
      'abrir o app outra vez',
      'Essa escolha fica só na memória do app, neste aparelho, e não é enviada a ninguém.',
      'A escolha de silenciar o som fica só na memória do app, neste aparelho, e não é enviada a ninguém.',
      'fica só na memória do app',
      'Uma playlist sempre espera o seu toque.',
      'Um player em que você tocou fecha nesses casos e quando outro áudio do Varanda começa.',
      'enquanto o player está aberto.'
    ]) t.absent(text(doc).includes(gone), doc.title + ': no ' + gone)
  }
  const { termsDecision } = await import('../src/terms.js')
  const member = 'ab'.repeat(32)
  const record = { v: 1, version: 52, members: { [member]: { acceptedAt: '2026-11-14T12:00:00.000Z', synced: true } } }
  t.is(termsDecision({ record, version: LEGAL_VERSION, member, hosted: false }), 'updated', 'an acceptance of version 52 asks again')
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
    t.absent(value.includes('\u2014'), 'no em dash')
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
  for (const required of ['o serviço de conta guarda o recurso', 'o texto opcional que a pessoa escreveu', 'a assinatura', 'a observação de quem julgou', 'o recurso não aparece para a própria pessoa nem para quem decidiu a denúncia que bloqueou a conta', 'pode ser revisto por qualquer moderador', 'Enquanto a conta existe, denúncias, recursos e decisões ligados a ela não são apagados automaticamente']) {
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

test('legal: version 86 describes web share of a page post', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 86)
  const terms = TERMS.sections.flatMap((s) => s.paragraphs).join('\n')
  const privacy = PRIVACY.sections.flatMap((s) => s.paragraphs).join('\n')
  t.ok(terms.includes('O dono ou um administrador de uma página pode fazer o mesmo com uma publicação da página. A escolha é um registro no diário da página'), 'terms: an owner or admin shares a page post, recorded in the page diary')
  t.ok(terms.includes('encerrar a página retira todas'), 'terms: closing the page withdraws every share')
  t.ok(terms.includes('a associação poderia publicar ou retirar uma publicação da página sem que ninguém da página pedisse'), 'terms: the residual risk of the service-held page key')
  t.ok(terms.includes('A escolha de publicar uma publicação da página na web também é pública como a página.'), 'terms: the page lists the share as public')
  t.ok(privacy.includes('Numa página, o dono ou um administrador faz a escolha, o serviço de conta a registra no diário da página com a chave da página e fica sabendo quem pediu e quando'), 'privacy: who chooses and what the service learns')
  t.ok(privacy.includes('As escolhas de publicar uma publicação da página na web também ficam no diário da página e são públicas como ele.'), 'privacy: the page diary holds the share')
})

test("legal: version 87 describes a page's parity in public groups", async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 87)
  const terms = TERMS.sections.flatMap((s) => s.paragraphs).join('\n')
  const privacy = PRIVACY.sections.flatMap((s) => s.paragraphs).join('\n')
  t.ok(terms.includes('Num grupo público, a página faz o mesmo que uma pessoa'), 'terms: a page acts as a person in a public group')
  t.ok(terms.includes('uma mensagem de voz'), 'terms: the page sends voice notes')
  t.ok(terms.includes('reage, vota, confirma presença e oculta as próprias publicações'), 'terms: reactions, votes, RSVPs and own hides')
  t.ok(terms.includes('A página nunca oculta a publicação de outra pessoa.'), 'terms: never hides another person\'s post')
  t.ok(terms.includes('o serviço de conta da associação a escreve com a chave de escrita da página e fica sabendo quem pediu e quando'), 'terms: what the service learns')
  t.ok(privacy.includes('Num grupo público, as fotos, mensagens de voz, reações, votos e confirmações de presença da página são públicos como a página'), 'privacy: public as the page')
  t.ok(privacy.includes('fica sabendo qual administrador pediu cada um e quando'), 'privacy: the service learns who asked')
  const kept = 'As mensagens que a página já escreveu em comunidades e grupos, com as fotos e mensagens de voz delas, continuam nesses grupos.'
  t.ok(terms.includes(kept), 'terms: closing a page leaves its group posts')
  t.ok(privacy.includes(kept), 'privacy: closing a page leaves its group posts')
})

test('legal: version 101 describes native device notices', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 101)
  for (const doc of [TERMS, PRIVACY]) {
    const text = doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
    for (const required of [
      'No app instalado, quando você ligar os avisos no aparelho e a associação tiver configurado o serviço',
      'a Apple (iPhone) ou o Google (Android) receberá o token do aparelho, o momento de cada aviso e a frase visível',
      '"Nova mensagem nas Conversas"',
      '"Nova mensagem para uma página que você administra"',
      '"Nova mensagem em", seguida do nome do grupo público',
      '"Nova mensagem num grupo", quando faltar um nome utilizável',
      '"Nova mensagem num grupo privado"',
      'Nunca recebe por esse aviso quem escreveu, o texto da mensagem ou o nome de um grupo privado.',
      'Só esses avisos de Conversas e grupos vão por esse serviço, e só para quem aceitou a versão 101 destes documentos ou uma mais nova.',
      'O serviço de conta da associação, no Brasil, guarda o token do aparelho, uma chave aleatória do aparelho e a data e hora de criação do registro',
      'de no máximo quatro aparelhos por pessoa, até você desligar os avisos, o token deixar de funcionar ou a conta ser excluída',
      'A troca do token com a mesma chave atualiza o registro daquele aparelho.',
      'ela não é enviada à Apple nem ao Google',
      'Esses provedores recebem o tipo do aviso e esse identificador, além da frase visível e do token, e podem tratar esses dados fora do Brasil.',
      'Avisos no app instalado: para entregar os avisos de Conversas e grupos que você escolheu receber, a base legal proposta é consentimento, Art. 7º, I, a confirmar em parecer jurídico.',
      'Você pode desligá-los a qualquer momento.',
      'Nesta versão, está pronto o serviço de envio da associação, desligado enquanto ela não o configurar.',
      'A opção de ligar esses avisos no app instalado virá numa próxima versão',
      'Um aviso perdido não é reenviado.'
    ]) t.ok(text.includes(required), doc.title + ': ' + required)
  }
})

test('legal: version 99 describes group message notices and the membership exposure', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 99)
  const all = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    const text = all(doc)
    for (const required of [
      '"Nova mensagem em"',
      '"Nova mensagem num grupo"',
      '"Nova mensagem num grupo privado"',
      'quais membros pertencem a um grupo com atividade e quando, mesmo que não tenham ligado os avisos',
      'O semeador já conhecia os participantes.',
      'inclusive ao esconder uma mensagem, reagir ou mudar o nome do grupo',
      'no máximo um aviso de grupo a cada 10 minutos por grupo e por pessoa e 60 avisos por pessoa por hora, só para quem aceitou a versão 99 destes documentos ou uma mais nova',
      'Os 10 minutos só começam quando um aviso entra na fila.',
      'um aviso perdido não é reenviado',
      'Avisos de mensagens em grupos: para avisar os membros de que há atividade no grupo, a base legal proposta é execução de contrato, Art. 7º, V, a confirmar em parecer jurídico.'
    ]) t.ok(text.includes(required), doc.title + ': ' + required)
  }
  t.ok(all(TERMS).includes('aparece mesmo com a janela em foco e um toque abre as Conversas'), 'terms: display and tap')
  t.ok(all(TERMS).includes('recebe a chave do grupo e, se ele for público, o nome; nunca recebe por esse aviso quem escreveu nem o conteúdo'), 'terms: group key for both visibilities, public name only, no author or content')
  for (const required of [
    'recebe a chave do grupo e, se ele for público, o nome; nunca recebe por esse aviso quem escreveu nem o conteúdo',
    'O nome do grupo privado nunca vai nesse aviso.',
    'O aviso de grupo privado não leva a chave do grupo.',
    'O serviço de push do navegador vê o momento de cada aviso.',
    'Quando não consegue confirmar a participação, deixa a pessoa de fora ou não manda o aviso.',
    'o histórico da abertura não gera aviso',
    'por grupo e por escritor, podem sair até quatro de uma vez, e depois a capacidade se repõe em um a cada 30 segundos; o excesso é descartado',
    'Cada envio ao serviço de conta leva até 64 destinatários, em vários envios quando há mais membros.',
    'O serviço manda cada aviso no máximo uma vez por destinatário',
    'Avisos de grupos ocupam no máximo metade da fila, esperam de 0 a 60 segundos, por sorteio, e recebem o mesmo enchimento dos outros avisos para manter o tamanho fixo.',
    'Os registros de operação não levam a chave nem o nome do grupo, o identificador do aviso ou os destinatários.',
    'Semeadores antigos não mandam esses avisos'
  ]) t.ok(all(PRIVACY).includes(required), 'privacy: ' + required)
})

test('legal: version 94 describes public group discovery', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 94)
  for (const doc of [TERMS, PRIVACY]) {
    const text = doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
    t.ok(text.includes('Entrar num grupo público é público.'), doc.title + ': public membership')
    t.ok(text.includes('com o nome do grupo e da comunidade. A Geral de cada comunidade, os grupos que pedem aprovação para entrar e os grupos privados ficam fora dessa lista.'), doc.title + ': profile list and exclusions')
    t.ok(text.includes('Você pode desligar a opção "Grupos públicos no perfil" em Ajustes, em Privacidade e segurança. Com a opção desligada, seu perfil não lista esses grupos e você não conta na lista "Grupos de quem você segue" de outras pessoas. Dentro de cada grupo público, a sua participação continua pública.'), doc.title + ': hiding the list keeps membership public')
    t.ok(text.includes('"Mais membros" vai do grupo com mais membros para o com menos.'), doc.title + ': member order')
    t.ok(text.includes('"Criados recentemente" vai do mais novo para o mais antigo, pela data declarada por quem criou, com no máximo 2 grupos por pessoa.'), doc.title + ': creation order and cap')
    t.ok(text.includes('"Em alta" ordena pela quantidade de pessoas diferentes que escreveram no grupo nos últimos 7 dias, contadas nas mensagens recentes que o semeador leu. Cada pessoa conta uma vez, Páginas não contam e só entram grupos de entrada aberta com pelo menos 2 pessoas que escreveram.'), doc.title + ': public group activity order')
    t.ok(text.includes('o semeador não acompanha aprovações nem banimentos dentro dos grupos.'), doc.title + ': approximate counts')
    t.ok(text.includes('ele guarda só na memória a data da mensagem mais recente de cada pessoa em cada grupo. Não lê mensagens de grupos privados.'), doc.title + ': activity data kept in memory')
    t.ok(text.includes('A lista "Grupos de quem você segue" é calculada no seu aparelho. O app consulta os grupos públicos de até 24 pessoas que você segue por vez e mostra primeiro os grupos com mais delas. O semeador recebe essas consultas, mas não monta nem guarda essa lista.'), doc.title + ': local followed groups list')
    t.ok(text.includes('"Assuntos do momento" mostra as hashtags usadas por mais pessoas nas últimas 24 horas, em publicações públicas guardadas pelo semeador. Cada pessoa conta uma vez por hashtag.'), doc.title + ': hashtag order and window')
    t.ok(text.includes('Contam até as 10 primeiras hashtags de cada publicação e as 50 publicações com hashtag mais recentes de cada pessoa. Páginas não contam. Só entram hashtags usadas por pelo menos 3 pessoas, até 10 hashtags na lista, e termos da lista de palavras bloqueadas ficam de fora.'), doc.title + ': hashtag limits and exclusions')
    t.ok(text.includes('Pedir essa lista não envia nenhuma palavra ao semeador. A lista é a mesma para todo mundo.'), doc.title + ': shared list with no search word sent')
    t.ok(text.includes('As listas não têm anúncios. A ordem de cada lista segue as regras descritas acima, sem outras formas de personalização. Chaves bloqueadas ficam fora.'), doc.title + ': no ads or personalized order')
  }
})

test('legal: version 93 describes the Conversas notice sent to the recipient only', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 93)
  const all = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.absent(/pode haver uma mensagem nova/iu.test(all(doc)), doc.title + ': the old anonymous wake is gone')
  }
  t.ok(all(TERMS).includes('um aviso que diz apenas "Nova mensagem nas Conversas", ou, para quem administra uma Página, "Nova mensagem para uma página que você administra"'), 'terms: the two fixed sentences')
  t.ok(all(TERMS).includes('o serviço de conta da associação fica sabendo que a pessoa recebeu uma mensagem e quando, mesmo que ela não tenha ligado os avisos, mas nunca quem enviou nem o conteúdo'), 'terms: what the service learns')
  t.ok(all(PRIVACY).includes('A chave desse lacre vem do próprio serviço de conta, nunca de um semeador.'), 'privacy: wake key source')
  t.ok(all(PRIVACY).includes('o serviço de conta fica sabendo que você recebeu uma mensagem e quando, mesmo que você não tenha ligado os avisos no aparelho, mas nunca quem enviou nem o conteúdo'), 'privacy: what the service learns, also without a subscription')
  t.ok(all(PRIVACY).includes('no máximo um a cada 15 minutos por destinatário e 60 por pessoa por hora, só para quem aceitou a versão 93 destes documentos ou uma mais nova'), 'privacy: limits and terms gate')
  t.ok(all(PRIVACY).includes('o serviço de push do navegador vê o momento de cada aviso'), 'privacy: push service sees timing')
  t.ok(all(PRIVACY).includes('Avisos de mensagem nova: para avisar quem recebe uma mensagem, a base legal proposta é execução de contrato, Art. 7º, V'), 'privacy: proposed legal basis')
})

test('legal: version 92 describes reactions in a page\'s Conversas', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 92)
  const all = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  const pages = (doc) => doc.sections.filter(({ heading }) => heading === 'Páginas').flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.absent(/n[ãa]o t[êe]m rea[çc][õo]es|n[ãa]o a guardam/iu.test(all(doc)), doc.title + ': no sentence says page conversations lack reactions')
    t.ok(pages(doc).includes('O mesmo vale para as reações da página, que o serviço também assina sem vê-las.'), doc.title + ': prepared reactions after removal, signed blind')
  }
  t.ok(all(TERMS).includes('As conversas de uma página também têm reações: você reage às mensagens e aos momentos da página, e a página, pelo dono ou por um administrador, reage às suas mensagens e aos seus momentos.'), 'terms: both directions, messages and momentos')
  t.ok(all(TERMS).includes('Um app anterior a esta versão não mostra as reações da página.'), 'terms: older apps do not show page reactions')
  t.ok(all(PRIVACY).includes('Numa conversa com uma página, a reação da página é assinada pelo serviço de conta sem que ele a veja, como as mensagens da página, e o serviço fica sabendo qual administrador pediu a assinatura e quando.'), 'privacy: what the service learns from a page reaction')
  t.ok(all(PRIVACY).includes('Numa conversa com uma página, a reação vale também para os momentos da página, e a página reage aos seus momentos do mesmo jeito.'), 'privacy: momento reactions with a page')
})

test('legal: version 91 describes a page rating a Feira listing', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 91)
  const terms = TERMS.sections.flatMap((s) => s.paragraphs).join('\n')
  const privacy = PRIVACY.sections.flatMap((s) => s.paragraphs).join('\n')
  t.ok(terms.includes('Uma página também pode avaliar o anúncio de outra pessoa'), 'terms: a page rates')
  t.ok(terms.includes('a grava no diário da página, assinada com a chave da página, e fica sabendo quem pediu e quando'), 'terms: the association signs as the page')
  t.ok(terms.includes('A página não avalia anúncios de quem cuida dela: o dono, os administradores, quem foi convidado ou vai receber a página, e outras páginas dessas pessoas.'), 'terms: no self-rating')
  t.ok(terms.includes('não pode ser mudada, apagada nem refeita para a mesma oferta, e continua no diário público da página depois que a página é encerrada'), 'terms: a page rating is permanent')
  t.ok(privacy.includes('A avaliação que uma página faz de um anúncio fica no diário da página'), 'privacy: where the rating lives')
  t.ok(privacy.includes('fica sabendo qual administrador pediu e quando'), 'privacy: what the service learns')
  t.ok(privacy.includes('Ela não pode ser mudada nem apagada e continua no diário público da página depois que a página é encerrada.'), 'privacy: a page rating outlives the page')
})

test("legal: version 89 describes a page's media, reactions and hides in private groups", async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 89)
  const terms = TERMS.sections.flatMap((s) => s.paragraphs).join('\n')
  const privacy = PRIVACY.sections.flatMap((s) => s.paragraphs).join('\n')
  t.ok(terms.includes('Num grupo privado, a página também publica fotos, GIFs, uma mensagem de voz e um link com prévia, responde, encaminha, reage e oculta as próprias publicações'), 'terms: a page acts as a person in a private group')
  t.ok(terms.includes('o serviço de conta guarda só a versão cifrada, sabe o tamanho dela e para qual grupo foi enviada'), 'terms: what the service stores and learns')
  t.ok(terms.includes('só os aparelhos dos membros conseguem abri-las'), 'terms: only members open them')
  t.ok(privacy.includes('as fotos e mensagens de voz da página são cifradas no aparelho de quem administra'), 'privacy: sealed on the admin device')
  t.ok(privacy.includes('sabe o tamanho, o grupo e qual administrador a enviou e quando, e não consegue abri-la; nada público da página a mostra'), 'privacy: what the service learns, never shown in public')
  t.ok(privacy.includes('As reações da página num grupo privado são cifradas como as publicações, e, quando ela oculta uma publicação, o que vai cifrado é o registro de ocultação.'), 'privacy: reactions and hide records sealed')
  t.ok(terms.includes('Essa versão cifrada fica guardada pelo serviço de conta e é servida pelo semeador junto com as outras mídias da página em grupos.'), 'terms: the service keeps it, the seeder serves it')
  t.ok(terms.includes('Ocultar a publicação ou sair do grupo não a apaga: ao ocultar, o que vai cifrado é o registro de ocultação'), 'terms: hiding or leaving deletes nothing, the hide record is sealed')
  t.ok(privacy.includes('Essa versão cifrada fica guardada pelo serviço de conta e é servida pelo semeador, como as outras mídias da página em grupos, e ocultar a publicação ou sair do grupo não a apaga.'), 'privacy: kept and served, hiding or leaving deletes nothing')
  t.ok(privacy.includes('Essas fotos e mensagens de voz, inclusive as cifradas dos grupos privados, continuam guardadas pelo serviço de conta e servidas pelo semeador.'), 'privacy: closing a page keeps its group media')
})

test('legal: public group and community images stay stored after replacement or removal', async (t) => {
  const { TERMS, PRIVACY } = await load()
  for (const doc of [TERMS, PRIVACY]) {
    const text = doc.sections.flatMap(s => s.paragraphs).join(' ')
    for (const statement of [
      'A imagem de um grupo público ou de uma comunidade é pública como o nome e é escolhida por quem criou o grupo ou a comunidade.',
      'Ela fica guardada no núcleo de mídia de quem criou o grupo ou a comunidade e nos semeadores.',
      'Remover ou substituir a imagem deixa de mostrar a imagem anterior, mas não apaga os bytes guardados nem as cópias já obtidas por outros aparelhos.',
      'Um grupo privado não tem imagem nesta versão.'
    ]) t.ok(text.includes(statement), doc.title + ': ' + statement)
  }
})

// A copy change requires a new acceptance version, including the core's
// independent constant. Pin the serialized contract, not a digest of itself.
test('legal: published text is pinned to its acceptance version', async (t) => {
  const { LEGAL_VERSION, TERMS, PRIVACY } = await load()
  const digest = createHash('sha256').update(JSON.stringify({ LEGAL_VERSION, TERMS, PRIVACY })).digest('hex')
  t.is(digest, 'ccebbeae593963218d31ba5a2ab5d0fc542f3b76af52918fbd0daed0c29e87c0', 'o texto mudou: suba LEGAL_VERSION (e TERMS_VERSION em @varanda/core lib/terms.js) e atualize este digest')
})

test('legal: version 41 describes group and conversation reactions and chat formatting', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(text(doc).includes('o emoji, a mensagem a que se refere, a hora e a sua conta como autora'), doc.title + ': what a reaction carries')
    t.ok(text(doc).includes('Num grupo privado, o emoji e a mensagem a que ele se refere são cifrados como as mensagens'), doc.title + ': private group reactions are sealed')
    t.ok(text(doc).includes('ainda vê qual conta escreveu o registro, quando e de que tamanho ele é'), doc.title + ': private group author, time and size stay visible')
    t.ok(text(doc).includes('o tamanho pode indicar que é uma reação e qual emoji ela leva'), doc.title + ': the size can suggest a reaction')
    t.ok(text(doc).includes('cópias que outras pessoas já receberam podem continuar existindo'), doc.title + ': removal leaves copies')
    t.ok(/(?:mensage(?:m|ns) diretas?, você também pode reag\p{L}*|rea(?:ç|g)\p{L}* numa mensagem direta)/iu.test(text(doc)), doc.title + ': reacting in direct messages')
    t.absent(text(doc).includes('As mensagens diretas ainda não têm reações'), doc.title + ': conversation reactions are no longer planned')
    t.ok(text(doc).includes('só as duas pessoas da conversa'), doc.title + ': a conversation reaction is seen by the two people')
    t.ok(text(doc).includes('no mesmo limite diário de envio'), doc.title + ': a reaction spends the daily sending allowance')
    t.ok(text(doc).includes('até ela chegar, a outra pessoa ainda pode ver a reação, e cópias que ela já recebeu podem continuar existindo'), doc.title + ': conversation removal leaves copies')
    t.absent(/conversas das páginas não têm reações/iu.test(text(doc)), doc.title + ': page conversations have reactions since version 92')
    t.ok(text(doc).includes('sem indicação de leitura, de entrega ou de que alguém está digitando'), doc.title + ': no read, delivery or typing indicator')
    t.ok(text(doc).includes('é só apresentação'), doc.title + ': formatting is presentation only')
  }
  t.ok(text(TERMS).includes('Ela é cifrada de ponta a ponta como as mensagens'), 'conversation reactions are end to end')
  t.ok(text(PRIVACY).includes('a hora e a sua conta como autora vão cifrados de ponta a ponta'), 'every field of a conversation reaction is sealed')
  t.ok(text(PRIVACY).includes('As reações nos grupos são guardadas e removidas como as mensagens do grupo em que foram publicadas'), 'retention of group reactions')
  t.ok(text(PRIVACY).includes('As reações nas mensagens diretas seguem os envelopes das mensagens diretas'), 'retention of conversation reactions')
  t.ok(text(PRIVACY).includes('as reações nos grupos e nas mensagens diretas'), 'legal basis of reactions')
})

test('legal: version 94 describes the weekly list', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 94)
  const audius = (doc) => doc.sections.filter(({ heading }) => heading === 'Música do Audius').flatMap(({ paragraphs }) => paragraphs).join(' ')
  const all = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(audius(TERMS).includes('a escolha de música mostra as faixas em alta no Audius nesta semana. Cada lista em alta é igual para todo mundo. O que muda, a partir das músicas que você escolheu neste aparelho, é qual lista de faixas abre primeiro.'), 'terms: trending lists are the same; which track list opens first follows this device')
  const privacy = audius(PRIVACY)
  t.ok(privacy.includes('o app pede a lista de faixas em alta da semana ao serviço de conta antes de você digitar qualquer coisa'), 'privacy: asked before typing')
  t.ok(privacy.includes('o serviço fica sabendo que a sua conta abriu a escolha'), 'privacy: the service knows the account opened it')
  t.ok(privacy.includes('limite diário próprio, de 200 aberturas por conta por dia'), 'privacy: own daily limit')
  t.ok(privacy.includes('sem texto de busca, gênero, conta, histórico de escuta nem endereço de internet do aparelho'), 'privacy: what Audius does not get')
  t.ok(privacy.includes('reaproveitada para todos os membros por até 10 minutos'), 'privacy: shared for 10 minutes')
  t.ok(privacy.includes('por 1 minuto e responde "indisponível"'), 'privacy: one minute after a failure')
  t.ok(all(PRIVACY).includes('o serviço não guarda qual conta viu qual lista e não registra isso em log. Ele só conta, na memória, quantas vezes cada conta abriu qualquer das listas no dia'), 'privacy: retention does not record who saw it')
  t.ok(all(PRIVACY).includes('Para as listas em alta, de faixas e de playlists, saem do Brasil o período fixo da semana'), 'privacy: leaves Brazil')
  t.ok(all(PRIVACY).includes('vale para mostrar, na escolha de música com o campo de busca vazio, a lista de faixas em alta'), 'privacy: legal basis covers the list')
})

test('legal: version 95 describes trending playlists', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  t.ok(LEGAL_VERSION >= 95)
  const audius = (doc) => doc.sections.filter(({ heading }) => heading === 'Música do Audius').flatMap(({ paragraphs }) => paragraphs).join(' ')
  const all = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(audius(TERMS).includes('Na aba Playlists, com o campo de busca vazio, a escolha de música mostra também playlists em alta no Audius nesta semana. Como a lista de faixas, ela é igual para todo mundo, não é personalizada e pode mudar no provedor.'), 'terms: trending playlists')
  const privacy = audius(PRIVACY)
  t.ok(privacy.includes('Abrir a aba Playlists com o campo de busca vazio pede do mesmo modo a lista de playlists em alta, e o serviço fica sabendo que a sua conta abriu essa aba'), 'privacy: asked when the tab opens, the service knows')
  t.ok(privacy.includes('Os pedidos de lista contam, salvo quando falham, num só limite diário próprio, de 200 aberturas por conta por dia, somados os da lista geral de faixas, os de cada gênero e os da lista de playlists'), 'privacy: one counter for every list')
  t.ok(privacy.includes('Cada lista, de faixas, de cada gênero ou de playlists, segue a mesma regra: uma lista que voltou bem é reaproveitada para todos os membros por até 10 minutos'), 'privacy: each list is shared for 10 minutes')
  t.ok(privacy.includes('por 1 minuto e responde "indisponível"'), 'privacy: one minute after a failure')
  t.ok(all(PRIVACY).includes('As listas em alta, de faixas e de playlists, ficam só na memória do serviço, valem por até 10 minutos cada e somem ao reiniciar'), 'privacy: retention covers both lists')
  t.ok(all(PRIVACY).includes('e, na aba Playlists, a lista de playlists em alta'), 'privacy: legal basis covers the playlists')
  t.absent(all(PRIVACY).includes('no máximo uma vez a cada 10 minutos'), 'privacy: no fixed-interval promise')
  for (const doc of [TERMS, PRIVACY]) t.absent(all(doc).includes('\u2014'), doc.title + ': no em dash')
})

test('legal: version 96 describes genre lists', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  const { MUSIC_GENRES } = require('@varanda/rpc')
  t.ok(LEGAL_VERSION >= 96)
  t.ok(MUSIC_GENRES.includes('Electronic'), 'the English name the privacy text uses is in the allowlist')
  const audius = (doc) => doc.sections.filter(({ heading }) => heading === 'Música do Audius').flatMap(({ paragraphs }) => paragraphs).join(' ')
  const all = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  const terms = audius(TERMS)
  t.ok(terms.includes('Na lista de faixas da escolha de música, com o campo vazio, você pode tocar num gênero para ver as faixas em alta daquele gênero nesta semana.'), 'terms: tap a genre')
  t.ok(terms.includes('Os gêneros são uma lista fixa do app, e a lista de cada gênero é igual para todo mundo. Tocar em Todos volta à lista geral. A aba Playlists não tem gêneros.'), 'terms: fixed list, same for everyone, Todos, no genres for playlists')
  const privacy = audius(PRIVACY)
  t.ok(privacy.includes('Quando você toca num gênero, o app envia ao serviço de conta o nome desse gênero, sempre um dos nomes de uma lista fixa, nunca um texto livre.'), 'privacy: the genre name from a fixed list')
  t.ok(privacy.includes('o gênero Eletrônica, por exemplo, vai como Electronic'), 'privacy: shown in pt-BR, sent in English')
  t.ok(privacy.includes('naquele pedido o serviço vê qual conta pediu qual gênero'), 'privacy: the service sees the pairing in the request')
  t.ok(privacy.includes('Quando precisa montar a lista desse gênero, ele envia ao Audius o nome do gênero'), 'privacy: what Audius gets for a genre list')
  t.ok(privacy.includes('O serviço não grava em disco nem em registros qual gênero cada conta pediu'), 'privacy: the pairing is not recorded')
  t.ok(privacy.includes('a contagem diária de pedidos da conta, que não leva o gênero'), 'privacy: the daily counter carries no genre')
  t.ok(privacy.includes('Cada toque num gênero diferente é um pedido e conta no limite diário das listas, salvo quando falha'), 'privacy: each tap counts')
  t.ok(privacy.includes('A lista fixa não tem gênero religioso, infantil nem categorias que não são música'), 'privacy: what the fixed list excludes')
  t.ok(privacy.includes('Para montar a lista geral de faixas e a de playlists, o serviço envia ao Audius só o período fixo da semana'), 'privacy: the no-genre sentence is scoped to the general lists')
  t.ok(all(PRIVACY).includes('o gênero que você tocou. O Audius'), 'privacy: sent abroad')
  t.ok(all(PRIVACY).includes('ao tocar num gênero, a lista de faixas em alta daquele gênero'), 'privacy: legal basis covers genre lists')
  t.absent(all(PRIVACY).includes('somadas as das duas listas'), 'privacy: the counter is no longer for two lists')
  for (const doc of [TERMS, PRIVACY]) t.absent(all(doc).includes('\u2014'), doc.title + ': no em dash')
})

test('legal: version 97 describes recents and the most used genre', async (t) => {
  const { TERMS, PRIVACY, LEGAL_VERSION } = await load()
  const { MAX_RECENTS, MAX_OWNERS, MUSIC_RECENTS_SHOWN } = await import('../src/musicRecents.js')
  t.ok(LEGAL_VERSION >= 97)
  const audius = (doc) => doc.sections.filter(({ heading }) => heading === 'Música do Audius').flatMap(({ paragraphs }) => paragraphs).join(' ')
  const all = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  const terms = audius(TERMS)
  const privacy = audius(PRIVACY)
  t.ok(terms.includes('Recentes: quando uma música entra no rascunho de uma publicação ou de um momento, depois do seu toque em Concluído'), 'terms: kept after Concluído')
  t.ok(terms.includes('num pequeno arquivo do app no Android e no iPhone e no armazenamento local do navegador (localStorage) na web'), 'terms: on-device file')
  t.ok(terms.includes('O app não a envia a ninguém e não a sincroniza com os seus outros aparelhos.'), 'terms: the app does not send or sync the list')
  t.ok(terms.includes('No celular, a lista pode entrar no backup do próprio aparelho (o iCloud, no iPhone).'), 'terms: a device backup may hold the list')
  t.ok(terms.includes('Limpar apaga a lista da sua conta'), 'terms: Limpar clears this account')
  t.ok(terms.includes('Sair ou Recomeçar apaga a de todas as contas deste aparelho'), 'terms: Sair and Recomeçar clear every account on the device')
  t.ok(terms.includes('bloquear o app não apaga'), 'terms: locking the app does not clear the list')
  t.ok(terms.includes('Guarda até ' + MAX_RECENTS + ' por conta, de até ' + MAX_OWNERS + ' contas usadas neste aparelho'), 'terms: stored caps equal MAX_RECENTS and MAX_OWNERS')
  t.ok(terms.includes('mostra as ' + MUSIC_RECENTS_SHOWN + ' mais recentes de cada aba'), 'terms: shown count equals MUSIC_RECENTS_SHOWN')
  t.ok(terms.includes('ao abrir a escolha de música já pede ao serviço de conta a lista em alta do gênero mais usado, sem esperar um toque'), 'terms: asks for the most used genre on opening')
  t.ok(privacy.includes('sem um toque seu e junto com a sua sessão'), 'privacy: the request goes without a tap, with the session')
  t.ok(privacy.includes('ligada à sua conta naquele pedido'), 'privacy: the session ties the genre to the account')
  t.ok(privacy.includes('Ele não grava o gênero em disco, não o escreve em registros e não o guarda junto da sua conta'), 'privacy: the service does not store or log the genre')
  t.ok(privacy.includes('quando não tem a lista válida na memória'), 'privacy: the shared list can sit in memory')
  t.ok(privacy.includes('O app não envia as contagens de gênero nem a lista de recentes a ninguém.'), 'privacy: the app does not send the counts or the list')
  t.ok(privacy.includes('Limpar não desliga o recurso de vez'), 'privacy: Limpar does not turn the feature off for good')
  t.ok(all(PRIVACY).includes('Para mostrar as recentes e pedir a lista do gênero mais usado, a base legal proposta é a mesma, execução de contrato, Art. 7º, V, ainda sujeita a parecer jurídico; por ser uma inferência enviada sem toque, este ponto está marcado para o parecer.'), 'privacy: proposed basis, marked for counsel, not approved')
  t.ok(all(PRIVACY).includes('No aparelho, a lista de recentes fica até você tocar em Limpar, em Sair ou em Recomeçar, ou até o limite de ' + MAX_RECENTS), 'privacy: kept on the device until Limpar, Sair, Recomeçar or the cap')
  t.ok(all(PRIVACY).includes('O serviço de conta não guarda essa lista nem as contagens de gênero.'), 'privacy: the service keeps nothing of the list or the counts')
  t.ok(all(PRIVACY).includes('O nome do gênero mais usado, que o app calculou no aparelho e pediu sem um toque, pode sair do Brasil como o gênero que você tocou'), 'privacy: the inferred name can leave Brazil as a tapped one does')
  t.ok(privacy.includes('Quando você toca num gênero, o app envia ao serviço de conta o nome desse gênero'), 'privacy: a tap still sends the genre')
  t.absent(all(TERMS).includes('escolhida a partir do que você faz'), 'terms: the track list is no longer said to ignore what the person does')
  t.absent(all(TERMS).includes('não é personalizada nem escolhida'), 'terms: the version 94 sentence is gone')
  t.absent(all(PRIVACY).includes('Nenhum gênero sai sem um toque'), 'privacy: a genre is not sent only on a tap')
  t.absent(all(PRIVACY).includes('nunca saem do aparelho'), 'privacy: a device backup may hold the list')
  t.absent(all(PRIVACY).includes('Limpar desliga o recurso de vez'), 'privacy: Limpar does not turn the feature off for good')
  t.absent(all(PRIVACY).includes('nunca fica na memória') || all(PRIVACY).includes('não fica na memória'), 'privacy: the genre is in the request and in the shared list')
  for (const doc of [TERMS, PRIVACY]) t.absent(all(doc).includes('\u2014'), doc.title + ': no em dash')
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
    t.ok(text(doc).includes('Adicionar uma passkey ou um código de recuperação exige a conta vinculada'), doc.title + ': extra entries need a linked account')
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
    t.ok(pages(doc).includes('Por até 15 dias depois da remoção, ele ainda pode enviar, em nome da página, mensagens que já tinha preparado antes de ser removido'), doc.title + ': prepared messages after removal')
    t.absent(pages(doc).includes('o ponto até onde já leu as mensagens da página'), doc.title + ': no service read cursor')
    t.ok(pages(doc).includes('As mensagens escritas antes da ativação podiam ser lidas pelo serviço'), doc.title + ': before activation')
    t.ok(pages(doc).includes('copiadas para o aparelho do dono e depois apagadas no serviço'), doc.title + ': copied, then deleted')
    t.ok(pages(doc).includes('a associação poderia trocar a chave de mensagens publicada da página por uma chave dela'), doc.title + ': key replacement')
    t.ok(pages(doc).includes('se recusam a enviar em nome da página e mostram um aviso quando alguém tenta enviar'), doc.title + ': the warning')
    t.ok(pages(doc).includes('as mensagens enviadas para a chave trocada poderiam ser lidas pela associação'), doc.title + ': until acted on')
    t.ok(pages(doc).includes('receba em 14 dias se perde'), doc.title + ': 14-day collection')
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
  t.ok(text(TERMS).includes('sob um identificador aleatório, por até 14 dias'))
  t.ok(text(TERMS).includes('envelopes lacrados de tamanho fixo, por até 14 dias'), 'the seeder keeps sealed envelopes 14 days')
  t.ok(text(PRIVACY).includes('os envelopes lacrados no semeador, por até 14 dias; um resumo (hash) de cada selo de envio já usado, por até 14 dias'), 'envelopes and spent stamps 14 days')
  t.absent(text(TERMS).includes('por até sete dias') || text(PRIVACY).includes('por até sete dias'), 'no seven-day seeder retention is left')
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
  t.ok(text(TERMS).includes('Conversas, grupos, Feira e a foto do perfil, de uma pessoa ou de uma página, não aceitam vídeo'))
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
  t.ok(text(PRIVACY).includes('Com outra passkey, dá para criar uma conta nova'))
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
  t.ok(text(TERMS).includes('tocar nele abre o link apenas se a pessoa escolher. O player de YouTube, SoundCloud, Spotify ou Apple Music é a exceção, descrita no parágrafo seguinte.'))
  t.ok(text(PRIVACY).includes('o link só é aberto quando a pessoa toca no cartão. A exceção é o player de YouTube, SoundCloud, Spotify ou Apple Music, que carrega um pouco antes de o cartão aparecer, como descrito em Compartilhamento e cópias fora do Brasil.'))
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

test('Privacidade: Posts salvos diz do pedido ao semeador, do backup e do Sair', async (t) => {
  const { PRIVACY } = await load()
  const p = PRIVACY.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(p.includes('o app pede essas publicações ao semeador'), 'semeador request')
  t.ok(p.includes('o semeador pode associar essas publicações à sua conta'), 'account linkage')
  t.ok(p.includes('o iCloud, no iPhone'), 'backup')
  t.ok(p.includes('continua no aparelho depois de Sair'), 'stays after Sair')
})

test('legal: version 57 describes recados', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const all = (d) => d.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(all(TERMS).includes('Um recado é um texto público que você deixa na página de outra pessoa'))
  t.ok(all(PRIVACY).includes('os recados são públicos: cada um fica no diário de quem o escreveu'))
  t.ok(all(PRIVACY).includes('o semeador pode associar essas leituras à sua conta'))
  t.ok(all(PRIVACY).includes('Tirar um recado da sua página e escolher quem pode deixar recado também são registros publicados no seu diário público, visíveis para qualquer pessoa'), 'hide and wall records are public')
})

test('legal: version 58 describes the rich profile and the Sorte do dia', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const all = (d) => d.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(all(TERMS).includes('Em Editar perfil você pode preencher, se quiser, um Sobre mim'))
  t.ok(all(TERMS).includes('Tudo isso é opcional e público'), 'optional and public')
  t.ok(all(PRIVACY).includes('são opcionais e públicos: cada um é um registro no seu diário, visível para qualquer pessoa'), 'public diary records')
  t.ok(all(PRIVACY).includes('o aniversário (só o dia e o mês, nunca o ano)'), 'birthday has no year')
  t.ok(all(PRIVACY).includes('o semeador vê qual perfil foi aberto e pode associar essa leitura à conta de quem abriu'), 'seeder sees the opened profile')
  t.ok(all(PRIVACY).includes('A Sorte do dia é escolhida no próprio aparelho'), 'sorte on the device')
  t.ok(all(PRIVACY).includes('não é enviada a ninguém, não usa a rede e não fica no seu diário'), 'sorte sends nothing')
  t.ok(all(TERMS).includes('marca como apagadas as versões anteriores'), 'a new version marks the earlier one as deleted')
  t.ok(all(PRIVACY).includes('cópias que outras pessoas ou semeadores já buscaram podem continuar existindo'), 'copies may remain')
})

test('legal: version 59 describes fas and melhores amigos as public records', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const all = (d) => d.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(all(TERMS).includes('Você pode ser fã de uma pessoa, sem precisar segui-la, e escolher até 8 melhores amigos'))
  t.ok(all(TERMS).includes('são registros públicos no seu diário'), 'public records')
  t.ok(all(TERMS).includes('só aparece na lista para os outros quando essa pessoa também segue você'), 'follow-back rule')
  t.ok(all(TERMS).includes('cópias que outras pessoas ou semeadores já buscaram podem continuar existindo'), 'copies may remain')
  t.ok(all(PRIVACY).includes('ser fã de alguém e a lista de melhores amigos são registros públicos no seu diário, visíveis para qualquer pessoa'), 'public diary records')
  t.ok(all(PRIVACY).includes('marca como apagadas as listas anteriores'), 'a new list marks the earlier ones as deleted')
  t.ok(all(PRIVACY).includes('o semeador vê qual perfil ou qual lista de fãs foi aberta e pode associar essa leitura à conta de quem abriu'), 'seeder sees the opened profile and fan list')
  t.ok(all(PRIVACY).includes('com o aviso de que podem estar incompletos'), 'count wording')
  t.ok(all(PRIVACY).includes('o semeador mostra o número de fãs que já conhece'), 'known count kept while indexing')
  t.ok(!all(PRIVACY).includes('4096'), 'no per-diary fan cap claim')
  t.ok(!all(PRIVACY).includes('não aponta fãs nem melhores amigos'), 'old indexing claim is gone')
  t.ok(all(TERMS).includes('grava um novo registro que desfaz o anterior, e os registros anteriores, com as suas datas, continuam públicos no diário'), 'unfan keeps earlier records public')
  t.ok(all(PRIVACY).includes('grava um novo registro que desfaz o anterior, e os registros anteriores, com as suas datas, continuam públicos no diário'), 'unfan keeps earlier records public (privacy)')
})

test('legal: version 60 describes polls as public votes', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const all = (d) => d.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(all(TERMS).includes('Votar numa enquete é público'), 'votes are public')
  t.ok(all(TERMS).includes('qualquer pessoa que leia o seu diário ou o grupo pode ver em quem ou em qual opção você votou'), 'anyone who reads the diary or the group sees the vote')
  t.ok(all(TERMS).includes('O app avisa disso antes do seu primeiro voto'), 'warned before the first vote')
  t.ok(all(TERMS).includes('Em grupos privados não há tópicos nem enquetes'), 'public groups only')
  t.ok(all(PRIVACY).includes('votar numa enquete é público'), 'privacy: public votes')
  t.ok(all(PRIVACY).includes('o semeador vê qual enquete e qual opção foram abertas e pode associar essa leitura à conta de quem abriu'), 'seeder sees the opened poll')
  t.ok(all(PRIVACY).includes('os registros anteriores, com as suas datas, continuam públicos'), 'withdrawn votes stay public')
  t.ok(all(PRIVACY).includes('podem estar incompletos'), 'totals are claims')
  t.absent(all(TERMS).includes('\u2014') || all(PRIVACY).includes('\u2014'), 'no em dash')
})

test('legal: version 61 describes events and presence answers as public', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const all = (d) => d.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(all(TERMS).includes('Eventos são públicos'), 'events are public')
  t.ok(all(TERMS).includes('as respostas de presença, Vou e Talvez'), 'presence answers named')
  t.ok(all(TERMS).includes('Em grupos privados não há eventos'), 'public groups only')
  t.ok(all(TERMS).includes('O lembrete de um evento fica só no seu aparelho'), 'reminders stay on the device')
  t.ok(all(PRIVACY).includes('as respostas de presença, Vou e Talvez, são públicos'), 'privacy: public presence')
  t.ok(all(PRIVACY).includes('Os lembretes de eventos ficam só no aparelho'), 'privacy: reminders on the device')
  t.ok(all(PRIVACY).includes('os registros anteriores, com as suas datas, continuam públicos'), 'withdrawn answers stay public')
  t.absent(all(TERMS).includes('\u2014') || all(PRIVACY).includes('\u2014'), 'no em dash')
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

test('legal: version 37 describes momentos that disappear but are not erased', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('uma foto ou um vídeo curto e até 200 caracteres de texto, que quem segue você vê por 24 horas'))
  t.ok(text(TERMS).includes('Depois de 24 horas, o momento deixa de aparecer no app'))
  t.ok(text(TERMS).includes('A foto ou o vídeo é removido dos servidores da Varanda em até 14 dias'))
  t.ok(text(TERMS).includes('O texto fica no seu diário até você apagar o momento'))
  t.ok(text(TERMS).includes('Sumir não é apagar: cópias que outras pessoas fizeram'))
  t.ok(text(TERMS).includes('não podem ser recolhidas'))
  t.ok(text(PRIVACY).includes('a chave para abrir essa mídia fica no próprio registro, de propósito'))
  t.ok(text(PRIVACY).includes('A foto ou o vídeo é removido dos servidores da Varanda em até 14 dias'))
  t.ok(text(PRIVACY).includes('sumir não é apagar'))
  t.ok(text(PRIVACY).includes('A foto ou o vídeo curto de um momento fica no semeador por até 14 dias, sem renovação'))
  t.ok(text(PRIVACY).includes('perfil, seguidos, depoimentos, momentos, fotos'))
})

test('legal: version 36 says the phone is not identity proof nor a recovery factor', async (t) => {
  const { TERMS, PRIVACY } = await load()
  for (const doc of [TERMS, PRIVACY]) {
    const text = doc.sections.flatMap((sec) => sec.paragraphs).join('\n')
    t.ok(/não (prova|é usado para recuperar)/.test(text) || /nunca serve para recuperar/.test(text))
    t.ok(text.includes('recuperar a conta'))
    t.is(/prova de identidade|comprova (quem|a identidade)/.test(text), false)
  }
})

test('legal: version 36 says what stays after deleting the account, number included', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const terms = TERMS.sections.flatMap((sec) => sec.paragraphs).join('\n')
  const privacy = PRIVACY.sections.flatMap((sec) => sec.paragraphs).join('\n')
  t.ok(terms.includes('O número do celular fica lacrado por até 180 dias e então é apagado.'))
  t.ok(privacy.includes('os @nomes que a conta usou e, por até 180 dias, o número lacrado; numa conta bloqueada, o índice com chave do número fica enquanto o bloqueio durar'))
  t.ok(privacy.includes('só são entregues mediante ordem judicial ou a seu próprio pedido'))
  t.ok(privacy.includes('o app não o grava no aparelho'), 'o número passa pelo app quando digitado')
  t.absent(privacy.includes('nem no navegador'), 'o número é digitado no navegador na web')
})

test('legal: version 37 discloses video scope, preparation and its limits', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const { MAX_VIDEO_MS, MAX_MOMENT_VIDEO_MS } = await import('../src/media/plan.js')
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes(`Vídeos curtos são aceitos nas publicações (até ${MAX_VIDEO_MS / 1000} segundos) e nos momentos (até ${MAX_MOMENT_VIDEO_MS / 1000} segundos), um por publicação ou momento.`))
  t.ok(text(TERMS).includes('A comparação de imagens e vídeos com listas de hashes de mídia ilegal é planejada e ainda não existe.'))
  t.ok(text(TERMS).includes('denúncias e bloqueio da conta são os meios de moderação dessas imagens e vídeos'))
  t.ok(text(TERMS).includes('publicações com fotos ou vídeos também ficam para pessoas'))
  t.ok(text(TERMS).includes('A IA não vê imagens nem vídeos.'))
  t.ok(text(TERMS).includes('No bloqueio, o semeador atualizado que guarda o diário também apaga a foto ou o vídeo dos momentos que o diário bloqueado guarda'))
  t.absent(text(TERMS).includes('O bloqueio não apaga antes do prazo'))
  t.ok(text(PRIVACY).includes('Se a conta for bloqueada, o semeador atualizado que guarda o diário apaga antes do prazo a foto ou o vídeo dos momentos que ainda estão nele'))
  t.ok(text(PRIVACY).includes('A triagem não vê imagens nem vídeos;'))
  t.ok(text(PRIVACY).includes('fotos (inclusive as das mensagens diretas e dos grupos), vídeos, mensagens de voz'))
  for (const required of [
    'Um vídeo em uma publicação ou momento é público como uma foto e leva junto o som que tiver.',
    'No app instalado (Android e iOS), o vídeo é gravado de novo, com resolução limitada e sem dados de localização ou do aparelho.',
    'Na versão web, inclusive instalada na tela inicial, o vídeo não é gravado de novo: o app remove esses dados do arquivo e só o envia se ele já estiver dentro dos limites aceitos.',
    'Isso remove metadados técnicos, não o que a imagem ou o som em si revela.',
    'a referência de uma foto ou um vídeo curto',
    'O texto do momento, com a referência da foto ou do vídeo, fica no diário até a pessoa apagar o momento.'
  ]) t.ok(text(PRIVACY).includes(required), required)
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(text(doc).includes('Deixar de aparecer no app não apaga todas as cópias.'), doc.title + ': copies survive disappearance')
    t.ok(text(doc).includes('fotos ou vídeos salvos'), doc.title + ': saved videos survive')
    t.absent(text(doc).includes('Vídeos não são aceitos'), doc.title + ': no blanket video ban')
  }
})

test('legal: version 48 describes the public page of a post', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const page = (doc) => doc.sections.find((s) => s.heading === 'Página pública de uma publicação').paragraphs.join(' ')
  for (const required of [
    'Onde a instalação ligou essa função',
    'Publicar deixa a publicação pública na web, não só para quem tem o link',
    'até 4 fotos (de um vídeo, só a capa)',
    'não a indexem e não há mapa do site',
    'não podem ser impedidos nem removidos pela associação'
  ]) t.ok(page(TERMS).includes(required), 'terms: ' + required)
  for (const required of [
    'Onde a instalação ligou essa função',
    'Não é só para quem tem o link',
    'até 4 fotos (de um vídeo, só a capa)',
    'até a pessoa retirar a publicação da web ou apagá-la',
    'pode guardar o endereço pedido e o endereço de internet (IP)',
    'ficam fora do controle da associação'
  ]) t.ok(page(PRIVACY).includes(required), 'privacy: ' + required)
})

test('legal: version 55 lets the recipient keep or refuse a depoimento', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const required of [
    'também pode guardá-lo só para si ou recusá-lo: nos dois casos nada é publicado',
    'vê apenas que ele foi enviado, não a escolha de quem recebeu'
  ]) t.ok(text(TERMS).includes(required), 'terms: ' + required)
  for (const required of [
    'Se não escolhe, nada é publicado no diário dela.',
    'também não publica nada e não avisa quem escreveu',
    'fica guardada só nos seus aparelhos e no bloco cifrado descrito no parágrafo sobre o que você viu (vistos)',
    'guardados só para você ou recusados',
    'a chave pública de quem escreveu, o número do registro, a escolha e a hora, até os 64 guardados e os 64 recusados mais recentes',
    'o texto do depoimento nunca vai no bloco'
  ]) t.ok(text(PRIVACY).includes(required), 'privacy: ' + required)
})

test('legal: version 62 describes Visitas as optional, mutual and on the device', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const all = (d) => d.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(all(TERMS).includes('Visitas é opcional e começa desligado'), 'terms: off by default')
  t.ok(all(TERMS).includes('a troca é mútua'), 'terms: mutual')
  t.ok(all(PRIVACY).includes('A lista de visitantes fica só no seu aparelho'), 'privacy: list on the device')
  t.ok(all(PRIVACY).includes('é apagada quando você desliga'), 'privacy: erased when switched off')
  t.ok(all(PRIVACY).includes('nunca acordam ninguém'), 'privacy: never wakes anyone')
  t.absent(all(TERMS).includes('\u2014') || all(PRIVACY).includes('\u2014'), 'no em dash')
})

test('legal: version 63 puts the momentos seen in the seen block', async (t) => {
  const { PRIVACY } = await load()
  const all = PRIVACY.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const required of [
    'os momentos de outras pessoas que você já viu',
    'a chave pública de quem publicou, o número do registro e a hora em que você viu, até os 132 mais recentes',
    'nada do conteúdo do momento vai no bloco, e quem publicou não fica sabendo',
    'essa lista fica só no aparelho e é apagada quando você sai da conta'
  ]) t.ok(all.includes(required), 'privacy: ' + required)
  t.absent(all.includes('\u2014'), 'no em dash')
})

test('legal: version 64 keeps the players off with Prévia de links off and under the keyboard', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(text(doc).includes('o player pode carregar assim que a prévia fica pronta e aparece na tela, antes de você publicar ou enviar; enquanto o teclado cobre a prévia, ele não carrega.'), 'the draft player waits for the keyboard')
    t.ok(text(doc).includes('Com a chave Prévia de links, em Ajustes, desligada, nenhum player carrega e os que estavam carregados fecham: o cartão aparece como os outros, e um toque nele abre o link.'), 'off, no player')
    t.absent(text(doc).includes('o player pode carregar assim que a prévia fica pronta, antes de você publicar ou enviar.'), 'the old draft sentence is gone')
    t.absent(text(doc).includes('\u2014'), 'no em dash')
  }
  t.ok(text(TERMS).includes('desliga a montagem das suas prévias e os players do parágrafo seguinte; os cartões que outras pessoas enviam continuam aparecendo, sem player.'))
  t.ok(text(PRIVACY).includes('desliga a montagem e o player; os cartões que outras pessoas enviam continuam aparecendo, sem player.'))
})

test('legal: version 65 keeps what another app shares on the device until Publicar', async (t) => {
  const { PRIVACY } = await load()
  const all = PRIVACY.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const required of [
    'O que outro app compartilha com a Varanda (fotos, um vídeo, texto ou um link) fica só no seu aparelho até você tocar em Publicar',
    'numa pasta que o app divide com a extensão de compartilhar (o grupo de apps)',
    'essas pastas ficam fora do backup do aparelho',
    'O compartilhamento vale por 1 hora',
    'No Android, a limpeza roda mesmo com o app fechado',
    'o texto que você escrevia no Publicar fica guardado na aba enquanto o compartilhamento recarrega o app, por até 1 hora, só para a mesma conta'
  ]) t.ok(all.includes(required), 'privacy: ' + required)
  t.absent(all.includes('\u2014'), 'no em dash')
})

test('legal: version 66 says the account service checks a new @nome and what a page publishes', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const all = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const required of [
    'O serviço de conta aplica a mesma lista a um @nome novo, de pessoa ou de página',
    'recusa o pedido e não guarda o @nome nem o texto recusado',
    'Um @nome que você já tem não é conferido de novo'
  ]) t.ok(all(TERMS).includes(required), 'terms: ' + required)
  for (const required of [
    'o serviço de conta confere o texto (publicação, resposta, citação,',
    'O texto recusado não é guardado, e o registro da recusa tem só o tipo do pedido e o motivo'
  ]) t.ok(all(PRIVACY).includes(required), 'privacy: ' + required)
  t.absent(all(TERMS).includes('\u2014') || all(PRIVACY).includes('\u2014'), 'no em dash')
})

test('legal: version 67 keeps opened direct message media across a lock and sends redirected links to the account service', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('Ela também fica guardada, cifrada, nos aparelhos que a abriram, mesmo quando o app bloqueia, até você tocar em Sair ou em Recomeçar, ou apagar os dados do app.'), 'kept across a lock')
  t.absent(text(TERMS).includes('até a sessão terminar, você tocar em Sair ou apagar os dados do app'), 'the old wipe on every lock is gone')
  t.ok(text(TERMS).includes('No app nativo, quem monta a prévia é o aparelho de quem envia, que não segue redirecionamentos: quando o link leva a outro endereço (um link encurtado, por exemplo), o app ligado à instalação da associação pede a prévia ao serviço de conta'), 'terms: a redirect goes to the account service')
  t.ok(text(PRIVACY).includes('no app nativo, pelo aparelho de quem envia, que fala direto com o site e não segue redirecionamentos (quando o site responde com um redirecionamento, como o de um link encurtado, e o app está ligado à instalação da associação, o aparelho pede a prévia ao serviço de conta, que lê a página como na versão web hospedada)'), 'privacy: a redirect goes to the account service')
  for (const doc of [TERMS, PRIVACY]) t.absent(text(doc).includes('\u2014'), 'no em dash')
})

test('legal: version 71 shares the Sorte do dia and the acceptance across devices', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(PRIVACY).includes('a partir da data local e da chave pública da sua conta, por isso é a mesma em todos os aparelhos em que você entra com a mesma passkey'), 'same Sorte on every device')
  t.absent(text(PRIVACY).includes('backup do aparelho no iCloud'), 'old per-device number is gone')
  t.ok(text(TERMS).includes('a nova versão é pedida uma vez por conta: quem entra com uma passkey que já existe vê o aceite depois de Entrar'), 'asked once per account, after Entrar')
  t.ok(text(TERMS).includes('quem cria uma conta aceita antes de criá-la, antes de qualquer dado dela ser enviado.'), 'sign-up accepts before anything of the account is sent')
  for (const doc of [TERMS, PRIVACY]) t.absent(text(doc).includes('\u2014'), 'no em dash')
  t.ok(text(PRIVACY).includes('O serviço só responde para conta vinculada, e responde só a versão e a data desse aceite.'), 'signed check answers only version and date')
  t.ok(text(PRIVACY).includes('com um pedido assinado pela chave do seu diário'), 'signed by the diary key')
})

test('legal: version 76 describes connected devices and the periodic key change', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(doc.sections.some(({ heading }) => heading === 'Aparelhos conectados'), 'a section for it')
    t.ok(text(doc).includes('num grupo pequeno, a cada 7 dias ou 1000 mensagens, o que vier antes; num grupo grande, com intervalos maiores'), 'the periodic key change')
    t.ok(text(doc).includes('Um grupo parado não troca a chave.'), 'an idle group does not rotate')
    t.ok(text(doc).includes('"Aparelhos conectados"'), 'names the screen')
    t.absent(text(doc).includes('\u2014'), 'no em dash')
  }
  t.ok(text(PRIVACY).includes('dentro de um registro cifrado com uma chave da sua passkey: só os aparelhos da conta conseguem abri-lo.'), 'the record is encrypted')
  t.ok(text(PRIVACY).includes('não o número, o nome nem os grupos'), 'holders see neither the id, the name nor the groups')
  t.ok(text(PRIVACY).includes('o app não tem como apagá-los, e o corte é definitivo'), 'records and cuts cannot be deleted')
  t.ok(text(TERMS).includes('fica trancado até alguém entrar de novo com a passkey'), 'the disconnected device locks')
})

test('legal: version 78 describes Varandinha', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(text(doc).includes('a Varandinha é opcional e começa desligada') || text(doc).includes('A Varandinha é um jogo opcional e começa desligada'), 'optional and off by default')
    t.ok(text(doc).includes('a pessoa cuja planta você regou vê o seu nome') || text(doc).includes('A pessoa cuja planta você regou vê o seu nome'), 'the watered person sees the name')
    t.ok(text(doc).includes('recompensa sorteada, ranking nem prêmio'), 'no random reward, ranking or prize')
    t.ok(text(doc).includes('nenhuma notificação pede para alguém voltar'), 'nothing asks anyone to come back')
    t.ok(text(doc).includes('cópias que outras pessoas já buscaram podem continuar'), 'fetched copies may remain')
    t.ok(text(doc).includes('Sair apaga só os seus próprios registros: as regas que vizinhos fizeram na sua varanda ficam no diário deles, e só quem regou pode apagá-las.'), 'leaving deletes only the own records')
    t.absent(text(doc).includes('\u2014'), 'no em dash')
  }
  t.ok(text(TERMS).includes('O estado de cada varanda é declarado por quem joga e não é conferido por ninguém.'), 'terms: declared, not verified')
  t.ok(text(PRIVACY).includes('O estado do jogo é declarado por cada pessoa e não é conferido'), 'privacy: declared, not verified')
  t.ok(text(PRIVACY).includes('e fica sabendo qual varanda o seu aparelho abre'), 'privacy: the seeder sees which balcony is opened')
  t.ok(text(PRIVACY).includes('sem guardar planta nem nome'), 'privacy: pointers only')
  t.ok(text(PRIVACY).includes('A cada nova rega, o app marca como apagadas até sete das suas regas com mais de cerca de três dias; as que sobrarem continuam públicas até as regas seguintes ou até você sair.'), 'privacy: each watering prunes at most seven helps older than about three days')
  t.ok(text(TERMS).includes('deixa no seu diário um registro público de que o jogo foi desligado'), 'terms: leaving keeps a public off flag')
  t.ok(text(PRIVACY).includes('deixa no diário o registro público de desligado'), 'privacy: leaving keeps a public off flag')
  t.ok(text(PRIVACY).includes('inclusive as regas que você deu'), 'privacy: leaving deletes the given helps')
  const visitas = text(PRIVACY).indexOf('No app instalado e na versão web hospedada, Visitas é opcional')
  t.ok(visitas >= 0 && text(PRIVACY).indexOf('No app instalado e na versão web hospedada, a Varandinha') > visitas, 'privacy: after the Visitas paragraph')
})

test('legal: version 73 keeps the one-time notes from repeating on another device', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  const marks = 'marcas opacas de que o aviso antes da primeira mensagem a uma Página e o aviso de convite novo já foram mostrados, na mesma janela do Avisos, para que outro aparelho da mesma conta não os mostre de novo; as marcas do bloco são calculadas com uma chave da sua conta, e nem o serviço nem quem lê essas marcas consegue saber a qual Página ou convite elas se referem. O aparelho que mostrou o aviso de uma Página guarda um registro de que já o mostrou (na instalação hospedada, com um nome derivado dessa mesma chave) e o apaga quando você sai da conta.'
  const all = text(PRIVACY)
  t.ok(all.includes(marks), 'opaque marks for the one-time notes, keyed with the account')
  const closing = 'Onde o aplicativo não usa esse bloco, essa lista fica só no aparelho e é apagada quando você sai da conta.'
  const momentos = all.indexOf('Esse mesmo bloco guarda também os momentos de outras pessoas que você já viu')
  t.ok(all.indexOf(marks) < momentos, 'the marks come before the momentos sentence')
  t.ok(all.indexOf(closing) > momentos && all.indexOf(closing) > all.indexOf(marks), 'the closing sentence follows the momentos list, not the marks')
  for (const doc of [TERMS, PRIVACY]) t.absent(text(doc).includes(String.fromCharCode(0x2014)), 'no em dash')
})

test('legal: version 79 describes video and link previews in page posts', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('As publicações de uma página também aceitam um vídeo curto, como as de uma pessoa.'))
  t.ok(text(TERMS).includes('Tudo o que a página publica, como publicações, fotos, vídeos, prévias de links'))
  t.ok(text(PRIVACY).includes('fotos e vídeos das publicações, imagens das prévias de links'))
  t.ok(text(PRIVACY).includes('cópia completa do diário da página (publicações, perfil, fotos, vídeos, imagens das prévias de links'))
})

test('legal: version 81 describes the keys of added passkeys, the recovery floor and the passkey lookup', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('e a de uma passkey adicionada em Ajustes com a confirmação de uma passkey cuja chave ele já tem'))
  t.ok(text(TERMS).includes('uma passkey adicionada sem essa confirmação ou uma passkey criada com o código de recuperação), a exclusão fica agendada por 7 dias'))
  t.ok(text(TERMS).includes('o código de recuperação e as chaves públicas das passkeys, e o app apaga a conta do aparelho'))
  t.absent(text(TERMS).includes('e a chave pública da passkey, e o app'))
  t.ok(text(PRIVACY).includes('ele guarda também a chave pública dela, ligada à entrada de recuperação dessa passkey e apagada quando essa entrada é removida'))
  t.ok(text(PRIVACY).includes('fica, para cada conta, só a chave pública da conta e um número de controle, sem prazo, também depois de Excluir conta'))
  t.ok(text(PRIVACY).includes('e as chaves públicas das passkeys com o pedido agendado'))
  t.ok(text(PRIVACY).includes('um identificador que ele não consegue ligar a uma passkey, salvo quando guarda a chave pública dela, como descrito abaixo.'))
  t.ok(text(PRIVACY).includes('Ao entrar com uma passkey que o app não reconhece, a versão hospedada pergunta ao serviço de conta, só pela chave pública, se ela tem conta.'))
  for (const doc of [TERMS, PRIVACY]) t.absent(text(doc).includes(String.fromCharCode(0x2014)), 'no em dash')
})

test('legal: version 80 describes polls, events, votes and RSVPs of a page', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('Tudo o que a página publica, como publicações, fotos, vídeos, prévias de links, enquetes, eventos, os votos e as respostas de presença dela'))
  t.ok(text(TERMS).includes('Como os de uma pessoa, um voto ou uma resposta de presença da página é um registro no diário dela, e retirá-lo grava um novo registro que deixa os anteriores públicos.'))
  t.ok(text(TERMS).includes('ao que uma página publica por ele (publicações, com as opções de uma enquete e o título e o lugar de um evento, respostas,'))
  t.ok(text(PRIVACY).includes('imagens das prévias de links, enquetes, eventos, os votos e as respostas de presença da página'))
  t.ok(text(PRIVACY).includes('cópia completa do diário da página (publicações, perfil, fotos, vídeos, imagens das prévias de links, votos, respostas de presença'))
  for (const doc of [TERMS, PRIVACY]) t.absent(text(doc).includes(String.fromCharCode(0x2014)), 'no em dash')
})

test('legal: version 83 describes momentos of a page and who the seeder can tie them to', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('Tudo o que a página publica, como publicações, fotos, vídeos, prévias de links, enquetes, eventos, os votos e as respostas de presença dela, os momentos e quem ela segue, é público como a página'))
  t.ok(text(TERMS).includes('Uma página também pode publicar momentos, como uma pessoa, e eles seguem as mesmas regras dos momentos descritas acima'))
  t.ok(text(TERMS).includes('A foto ou o vídeo de um momento da página é enviado ao semeador pelo aparelho de quem o publica, o dono ou um administrador, e pago com os selos de envio da conta dessa pessoa.'))
  t.ok(text(TERMS).includes('o semeador pode ligar aquele momento da página a quem o publicou. A lista do dono e dos administradores já é pública; o que fica exposto nesse caso é qual deles publicou aquele momento.'))
  t.ok(text(TERMS).includes('ao que uma página publica por ele (publicações, com as opções de uma enquete e o título e o lugar de um evento, respostas, citações, momentos, perfil,'))
  t.ok(text(PRIVACY).includes('os votos e as respostas de presença da página, os momentos, com o texto e a referência da foto ou do vídeo, e a lista de quem a página segue'))
  t.ok(text(PRIVACY).includes('votos, respostas de presença, o texto e a referência da mídia dos momentos e quem ela segue)'))
  t.ok(text(PRIVACY).includes('o serviço de conta confere o texto (publicação, resposta, citação, momento, perfil, anúncio e mensagem em grupo público)'))
  for (const doc of [TERMS, PRIVACY]) t.absent(text(doc).includes(String.fromCharCode(0x2014)), 'no em dash')
})

test('legal: version 82 says the moderation data of a deleted account goes 6 months after the deletion', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('As denúncias sobre a conta, os seus recursos, as imagens e os áudios anexados a essas denúncias e o registro de decisões ligado à conta são apagados 6 meses (180 dias) depois da exclusão ou, se um bloqueio ainda espera a publicação da lista, logo depois dela. Uma denúncia sobre a conta que levou ao bloqueio de um grupo inteiro fica enquanto o grupo estiver bloqueado. Uma denúncia que você fez e que levou a um bloqueio que continua (de uma conta ou de um grupo) fica, sem a sua chave, o seu comentário e a sua assinatura, com o trecho e a imagem ou o áudio que você anexou, enquanto o bloqueio durar. As outras denúncias que você fez são apagadas no mesmo prazo, mas de uma denúncia já decidida sobre uma conta que ainda existe fica só um registro, sem nenhum dado seu, de que a denúncia foi analisada e do que foi decidido; é o que fica também quando aquele bloqueio é desfeito.'))
  t.ok(text(PRIVACY).includes('Uma denúncia que ela fez e que levou a um bloqueio que continua (de uma conta ou de um grupo) fica, sem a chave pública, a observação e a assinatura de quem denunciou, enquanto o bloqueio durar. De uma denúncia que ela fez e que já foi decidida sobre uma conta que ainda existe fica só um registro, sem os dados de quem denunciou, de que a denúncia foi analisada e do que foi decidido.'))
  t.ok(text(PRIVACY).includes('são apagados 6 meses (180 dias) depois da exclusão ou, se um bloqueio ainda espera a publicação da lista, logo depois dela (uma denúncia que ela fez e que levou a um bloqueio que continua fica'))
  t.ok(text(PRIVACY).includes('uma denúncia sobre ela que levou ao bloqueio de um grupo inteiro fica enquanto o grupo estiver bloqueado), e as cópias'))
  t.ok(text(PRIVACY).includes('as decisões dos moderadores, para moderação e pedidos legais, por 6 meses (180 dias), como descrito acima;'))
  t.absent(text(PRIVACY).includes('sem prazo definido ainda (issue #38)'), 'the deletion paragraph follows the retention')
  t.ok(text(TERMS).includes('As cópias da triagem automática com o texto das suas publicações, e os precedentes tirados delas, também são apagadas na exclusão (um arquivo corrompido que o serviço separou fica até a operação do servidor apagá-lo).'))
  t.ok(text(PRIVACY).includes('com os precedentes, são apagadas na exclusão (um arquivo corrompido que o serviço separou fica até a operação do servidor apagá-lo).'), 'a set-aside triage file is named in Privacy too')
  t.ok(text(PRIVACY).includes('Seis meses (180 dias) depois da exclusão de uma conta ou, se um bloqueio ainda espera a publicação da lista, logo depois dela, o serviço apaga as denúncias sobre ela e as que ela fez'))
  t.ok(text(PRIVACY).includes('Seis meses (180 dias) depois da exclusão da conta, o recurso e o registro de decisões ligado a ela são apagados.'))
  t.ok(text(PRIVACY).includes('A imagem é apagada com a denúncia, 6 meses (180 dias) depois da exclusão da conta denunciada ou de quem denunciou. Numa denúncia que fica enquanto um bloqueio durar (sem os dados de quem denunciou, ou porque levou ao bloqueio de um grupo inteiro), a imagem fica com ela; um registro sem conteúdo não guarda imagem.'))
  t.ok(text(PRIVACY).includes('de uma que ela fez e que já foi decidida sobre uma conta que ainda existe fica só um registro sem conteúdo;'))
  t.ok(text(PRIVACY).includes('O áudio é apagado com a denúncia, no mesmo prazo da imagem.'))
  t.ok(text(PRIVACY).includes('Para contas ativas, a retenção está em aberto (issue #38).'))
  t.absent(text(PRIVACY).includes('Denúncias, recursos e decisões não são apagados automaticamente.'), 'no longer true for a deleted account')
  for (const doc of [TERMS, PRIVACY]) t.absent(text(doc).includes(String.fromCharCode(0x2014)), 'no em dash')
})

test('legal: version 83 describes the automatic history copy to a new device', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  for (const doc of [TERMS, PRIVACY]) {
    const all = text(doc)
    t.absent(all.includes('Copiar conversas para outro aparelho'), doc.title + ': no option to tap any more')
    t.ok(all.includes('um dos aparelhos da conta que já existiam'), doc.title + ': one existing device copies')
    t.ok(all.includes('em segundo plano') && all.includes('uma vez para cada aparelho novo'), doc.title + ': in the background, once per new device')
    t.ok(all.includes('das mais recentes para as mais antigas, dentro da cota semanal de cópia do semeador'), doc.title + ': photos newest first, within the weekly allowance')
    t.ok(all.includes('Uma cópia interrompida continua na próxima vez que o app abrir.'), doc.title + ': it resumes')
    t.ok(all.includes('Um aparelho desconectado em "Aparelhos conectados" não faz nem recebe cópia.'), doc.title + ': a disconnected device is left out')
    t.ok(all.includes('Qualquer aparelho novo que entrar com a sua passkey recebe assim, dos seus outros aparelhos, o histórico das suas conversas privadas, com texto e fotos, sem nenhum aviso nesses outros aparelhos.'), doc.title + ': the passkey alone gets the history, with no notice')
    t.ok(all.includes('guarde bem a sua passkey e desconecte em "Aparelhos conectados" todo aparelho que você não reconheça: isso também interrompe uma cópia em andamento'), doc.title + ': what to do about it')
    t.ok(all.includes('14 dias'), doc.title + ': retention')
  }
  t.ok(text(PRIVACY).includes('um reserva a cópia, para que só um aparelho a faça'), 'the claim, plainly')
  t.ok(text(TERMS).includes('As fotos das Páginas não vão.'))
})

test('legal: version 84 describes Excluir conta sem a passkey and the e-mail path', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  t.ok(text(TERMS).includes('sem nenhuma passkey e sem o código, toque em Excluir conta sem a passkey na tela de entrada: digite o seu @nome, o número de celular que você confirmou e o código que enviamos por SMS para ele. Isso só registra um pedido: nada acontece antes de você escrever para contato@varanda.app com o seu @nome. Depois que a operação confirmar o pedido com você, a exclusão fica agendada por 7 dias, como acima, contados a partir daí.'))
  t.absent(text(TERMS).includes('para ele, e a exclusão fica agendada'), 'the code alone schedules nothing')
  t.ok(text(PRIVACY).includes('O pedido feito em Excluir conta sem a passkey (a chave pública da conta e a data do pedido) fica guardado por até 30 dias e é apagado quando a conta é excluída.'))
  t.ok(text(TERMS).includes('Sem celular confirmado (contas que entraram com o Google), escreva para contato@varanda.app pelo e-mail da conta; a operação confere o pedido e agenda a mesma exclusão de 7 dias.'))
  t.absent(text(TERMS).includes('ainda não há como pedir a exclusão pelo app'), 'the old sentence is gone')
  t.ok(text(TERMS).includes('a seu pedido (em Ajustes, pela tela de entrada ou por e-mail) ou por decisão da moderação'))
  t.ok(text(PRIVACY).includes('O parceiro de verificação recebe o número só para enviar o código de confirmação ou de exclusão por SMS'))
  t.ok(text(PRIVACY).includes('ou, sem a passkey, em Excluir conta sem a passkey na tela de entrada'))
  t.ok(text(PRIVACY).includes('para você pedir a exclusão da conta sem a passkey'))
  t.ok(text(PRIVACY).includes('Só o operador consegue ler o número, com um comando do servidor, para atender uma ordem judicial ou um pedido seu.'), 'the operator line is unchanged: the service never unseals the number')
  for (const doc of [TERMS, PRIVACY]) t.absent(text(doc).includes(String.fromCharCode(0x2014)), 'no em dash')
})

test('legal: version 90 says the Conversas keys of a core node sit in a file with no passkey', async (t) => {
  const { TERMS, PRIVACY } = await load()
  const text = (doc) => doc.sections.flatMap(({ paragraphs }) => paragraphs).join(' ')
  const sentence = 'Num nó core, as chaves das Conversas, as do próprio nó e as das Páginas que ele administra, ficam guardadas num arquivo naquele aparelho, sem nenhuma passkey que as proteja: quem tiver a pasta de dados desse nó consegue ler essas conversas, e quem perder essa pasta perde essas conversas.'
  for (const doc of [TERMS, PRIVACY]) {
    t.ok(text(doc).includes(sentence), doc.title + ': the core seed file and what losing it means')
    t.absent(text(doc).includes(String.fromCharCode(0x2014)), 'no em dash')
  }
})
