'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')

const load = () => import('../src/legal.js')

test('legal: version, date and review note', async (t) => {
  const { LEGAL_VERSION, LEGAL_DATE, REVIEW_NOTE } = await load()
  t.is(LEGAL_VERSION, 65)
  t.is(LEGAL_DATE, '16/11/2026')
  t.is(REVIEW_NOTE, 'Versão 65, sujeita a revisão jurídica. Não é parecer jurídico.')
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
    'Um app que não foi atualizado não a mostra, e as conversas das páginas não a guardam.'
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
  t.is(digest, 'd3bbb66a40edd8e6f740b9a0a4bca7f75c940ec2c1c468499366eecd5b6b18a2', 'o texto mudou: suba LEGAL_VERSION (e TERMS_VERSION em @varanda/core lib/terms.js) e atualize este digest')
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
    t.ok(/conversas das páginas não têm reações/iu.test(text(doc)), doc.title + ': no reactions in page conversations')
    t.ok(text(doc).includes('sem indicação de leitura, de entrega ou de que alguém está digitando'), doc.title + ': no read, delivery or typing indicator')
    t.ok(text(doc).includes('é só apresentação'), doc.title + ': formatting is presentation only')
  }
  t.ok(text(TERMS).includes('Ela é cifrada de ponta a ponta como as mensagens'), 'conversation reactions are end to end')
  t.ok(text(PRIVACY).includes('a hora e a sua conta como autora vão cifrados de ponta a ponta'), 'every field of a conversation reaction is sealed')
  t.ok(text(PRIVACY).includes('As reações nos grupos são guardadas e removidas como as mensagens do grupo em que foram publicadas'), 'retention of group reactions')
  t.ok(text(PRIVACY).includes('As reações nas mensagens diretas seguem os envelopes das mensagens diretas'), 'retention of conversation reactions')
  t.ok(text(PRIVACY).includes('as reações nos grupos e nas mensagens diretas'), 'legal basis of reactions')
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
  t.ok(text(TERMS).includes('Conversas, grupos, Feira, Páginas e a foto do perfil não aceitam vídeo'))
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
  t.ok(text(TERMS).includes('A foto ou o vídeo é removido dos servidores da Varanda em até 7 dias'))
  t.ok(text(TERMS).includes('O texto fica no seu diário até você apagar o momento'))
  t.ok(text(TERMS).includes('Sumir não é apagar: cópias que outras pessoas fizeram'))
  t.ok(text(TERMS).includes('não podem ser recolhidas'))
  t.ok(text(PRIVACY).includes('a chave para abrir essa mídia fica no próprio registro, de propósito'))
  t.ok(text(PRIVACY).includes('A foto ou o vídeo é removido dos servidores da Varanda em até 7 dias'))
  t.ok(text(PRIVACY).includes('sumir não é apagar'))
  t.ok(text(PRIVACY).includes('A foto ou o vídeo curto de um momento fica no semeador por até 7 dias, sem renovação'))
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
  t.ok(text(TERMS).includes('O bloqueio não apaga antes do prazo a foto ou o vídeo de um momento'))
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

test('legal: version 65 shares the Sorte do dia and the acceptance across devices', async (t) => {
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
