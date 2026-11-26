// Info sheets stay pure so Node tests can load their texts.
// Keys match tab and setup-step ids so callers can use those ids directly.
import { PEEK_RULE_TEXT } from './peek.js'
import { SEARCH_HINT, SEARCH_MEMORY } from './topics.js'
import { LIST_NOTE, LOSS_TEXT, UPDATED_APP_TEXT } from './recovery.js'
import { DEVICES_NOTE } from './devices.js'
import { BLOCK_TEXTS } from './memberBlocks.js'
import { WALL_NOTE, WALL_PUBLIC } from './recadosView.js'
import { TEXTS as EXTRA_TEXTS } from './profileExtraView.js'

export const QR_HINT = 'Aponte a câmera do celular para o código.'

export const HELP = Object.freeze({
  rua: Object.freeze({
    title: 'Como funciona A Rua',
    paragraphs: Object.freeze([
      'Aqui aparecem as publicações de quem você segue, da mais nova para a mais antiga.',
      'Quem você não segue aparece na Espiadinha.',
      'Os números de curtidas e comentários podem chegar incompletos. Eles não mudam o que foi publicado.'
    ])
  }),
  espiadinha: Object.freeze({
    title: 'Como funciona a Espiadinha',
    paragraphs: Object.freeze([
      PEEK_RULE_TEXT,
      'Essas publicações não ficam guardadas neste aparelho: ficam só enquanto a aba está aberta.',
      'A Espiadinha funciona no site da associação e no app ligado à instalação da associação. Não funciona com uma configuração manual.'
    ])
  }),
  feira: Object.freeze({
    title: 'Como funciona a Feira',
    paragraphs: Object.freeze([
      'Os anúncios da Feira são públicos na web e podem aparecer em buscadores. Qualquer pessoa pode abrir o link, mesmo sem conta na Varanda.',
      'A primeira versão do anúncio fica no diário até você apagar o anúncio, mesmo depois de editar. Quem já copiou pode ter guardado.',
      'O pagamento é combinado e feito fora do app. Fazer ou aceitar uma oferta não é pagar nem comprovar pagamento.',
      'Os estados Reservado, Vendido e Encontrado ficam visíveis para todo mundo.',
      'Avaliações precisam do consentimento de quem anuncia e não são prova de pagamento.',
      'Nas conversas com uma Página, só quem administra a página lê as mensagens.'
    ])
  }),
  varandinha: Object.freeze({
    title: 'Como funciona a Varandinha',
    paragraphs: Object.freeze([
      'As plantas crescem em horas de verdade, no relógio de quem olha. Nada acontece enquanto ninguém joga, mas o tempo passa igual.',
      'Regar a própria planta e receber a rega de um vizinho adiantam a colheita.',
      'Cada pessoa rega a varanda de quem segue, uma vez por dia por varanda.',
      'Tudo no jogo fica público no diário e é declarado por cada pessoa: participar, o que está plantado, as datas de plantio, rega e colheita, e de quem você regou. Quem recebe a rega vê o nome de quem regou.',
      'Não tem compra, ranking nem prêmio. Sair da Varandinha marca os seus registros do jogo como apagados, mas cópias que outras pessoas já buscaram podem continuar. As regas que vizinhos fizeram na sua varanda ficam no diário deles.',
      'A barraquinha abre aos sábados. Um vaso pronto pode ser dado, como mimo, para alguém que você segue. O mimo só aparece na prateleira de quem recebe depois que a pessoa aceita, e fica até o sábado seguinte.',
      'Os enfeites são opcionais e vêm de uma lista fixa. Ficam públicos no diário, servem só para a aparência da varanda e não são um prêmio.'
    ])
  }),
  seguindo: Object.freeze({
    title: 'Como funciona Seguindo',
    paragraphs: Object.freeze([
      'Seguindo é a lista de pessoas que você segue. Abra a lista tocando no número ao lado de seguindo, no Diário. Ela funciona em qualquer instalação.',
      'Siga pessoas para ver as publicações delas na Rua. Para encontrar alguém, use a Busca.',
      'Quem você segue é público: no site da associação e no app ligado à instalação, qualquer pessoa vê essa lista. Ela aparece igual em todos os seus aparelhos.',
      'O campo no topo só filtra quem já está nesta lista. Para encontrar outra conta, use a Busca. Para deixar de seguir, toque em Seguindo e confirme. Para denunciar uma conta, toque na bandeira.'
    ])
  }),
  avisos: Object.freeze({
    title: 'Como funcionam os Avisos',
    paragraphs: Object.freeze([
      'Aqui aparece quem começou a seguir você. Toque no aviso para ver o perfil da pessoa e, se quiser, seguir de volta: o aviso continua na lista e só o botão Seguir de volta some.',
      'Quantas pessoas seguem alguém, e quem são, aparece no Diário e no perfil de cada pessoa. Os Avisos continuam só seus.',
      'Os Avisos abrem pelo sino no canto superior direito. Quando há algo novo, o sino ganha um ponto, nunca um número.',
      'Os Avisos funcionam no site da associação e no app ligado à instalação da associação. Não funcionam com uma configuração manual.'
    ])
  }),
  meuQr: Object.freeze({
    title: 'Como funciona o Meu QR',
    paragraphs: Object.freeze([
      'O QR leva ao link do seu perfil nesta associação. Quem lê o código com a câmera do celular abre o seu perfil no app, ou no site se não tiver o app, e só passa a seguir você depois de confirmar ali.',
      'O código não carrega nenhum segredo nem dá permissão: é só o endereço do perfil, o mesmo do botão de compartilhar.',
      'Ler um QR que não é um perfil desta associação não segue ninguém.'
    ])
  }),
  diario: Object.freeze({
    title: 'Como funciona o Diário',
    paragraphs: Object.freeze([
      'O Diário é o seu perfil e as suas publicações.',
      'O número ao lado de seguindo é quantas pessoas você segue. O número ao lado de seguidores é quantas pessoas seguem você. Qualquer pessoa pode ver os dois números e as duas listas; toque num número para abrir a lista. O campo da lista só filtra quem já está nela.',
      'Uma publicação que ainda aguarda envio leva a data do momento em que sai.',
      'No menu da sua publicação, Editar permite corrigir o texto e deixa a marca editado.',
      'Você pode apagar as suas publicações e versões do perfil. Elas somem do app, mas quem já copiou pode ter guardado.'
    ])
  }),
  postEdit: Object.freeze({
    title: 'Como funciona a edição',
    paragraphs: Object.freeze([
      'A correção substitui o texto que as pessoas veem e marca a publicação como editado. O texto anterior fica no histórico do diário e versões antigas do app continuam mostrando ele. Fotos, respostas e citações não mudam. Para remover a publicação, apague.'
    ])
  }),
  conversas: Object.freeze({
    title: 'Como funcionam as Conversas',
    paragraphs: Object.freeze([
      'Conversas e grupos, de comunidade ou não, ficam numa lista só, a mais recente primeiro. Todas mostra a lista inteira; Não lidas e Grupos mostram só parte dela.',
      'Mensagens são textos privados entre duas pessoas, cifrados de ponta a ponta.',
      'A associação guarda só envelopes lacrados por 14 dias e não consegue ver quem escreve para quem.',
      'Quem você segue aparece na lista. Qualquer outra pessoa aparece em Pedidos de mensagem, e a mensagem é enviada antes de você aceitar.',
      'Aceitar ou recusar não avisa a outra pessoa.',
      'Não há confirmação de leitura.',
      'Bloquear interrompe as mensagens nos seus aparelhos.',
      'Apagar tira a conversa dos seus aparelhos. As fotos saem da memória deles na hora e o texto 15 dias depois, na próxima vez que o app abrir.',
      'Num aparelho novo com a mesma passkey, as conversas chegam sozinhas, copiadas de outro aparelho seu: primeiro o texto, depois as fotos. Só você consegue abrir a cópia.',
      'Uma denúncia envia só a mensagem que você escolheu e a conta de quem enviou, nunca o resto da conversa.',
      'A linha Comunidades serve para achar comunidades e grupos e criar comunidades.',
      'Qualquer pessoa cria um grupo sem comunidade. Um grupo público sem comunidade aparece em Descobrir, em Grupos.'
    ])
  }),
  entrar: Object.freeze({
    title: 'Como funciona a entrada',
    paragraphs: Object.freeze([
      'Na Varanda não existe senha para decorar nem e-mail para confirmar. Sua conta abre com o rosto, a digital ou o bloqueio de tela do aparelho. Por baixo, isso se chama passkey.',
      'No celular, a passkey costuma ficar salva na conta Google (Android) ou na conta Apple (iPhone), que sincroniza entre os seus aparelhos: num celular novo, entrar nessa mesma conta traz a passkey de volta. Outros gerenciadores de senhas que sincronizam, como o 1Password ou o Bitwarden, também servem.',
      'Num computador, use o celular: para criar a conta, toque em Outras formas de entrar e em criar com o celular; para entrar, toque em Entrar ou Já tenho conta e escolha usar outro aparelho na janela do sistema. Nos dois casos, leia com a câmera do celular o QR code que aparece na tela do computador.',
      'Em Ajustes → Passkeys e recuperação, cadastre outra passkey ou um código de recuperação: eles abrem a mesma conta. Uma passkey criada fora desse lugar abre outra conta.',
      LOSS_TEXT,
      'Em Outras formas de entrar ficam os outros jeitos de entrar, para quem já tem conta em outro aparelho ou guardou um código de recuperação: entrar com outra passkey, usar o celular pelo QR code (no navegador) e entrar com o código de recuperação.',
      'Sem passkey e sem código, Excluir conta sem a passkey, abaixo dos botões, registra um pedido de exclusão com o seu @nome, o celular que você confirmou e um código por SMS. Depois, ainda falta escrever para contato@varanda.app: nada acontece antes disso.'
    ])
  }),
  vinculo: Object.freeze({
    title: 'Por que confirmar o celular',
    paragraphs: Object.freeze([
      'Para entrar na rede, confirme um celular brasileiro e escolha seu @nome.',
      'A associação guarda o número lacrado para liberar sua conta e seu @nome, atender uma ordem judicial ou bloquear a conta. Cada número fica em uma conta só. Enquanto durar um bloqueio, o mesmo número não pode ser usado em outra conta.',
      'O número nunca vai para o seu diário nem para o seu perfil, e não fica guardado neste aparelho. Ele não serve para recuperar a conta.',
      'O que é guardado está na Política de Privacidade (Ajustes → Termos e privacidade).',
      'O @nome tem de 3 a 20 letras minúsculas, números ou _, começando por letra. Você pode trocá-lo depois, uma vez a cada 7 dias.',
      'Se a rede estiver por convite, a entrada é pelo link que alguém que já está na Varanda te enviou.'
    ])
  }),
  idade: Object.freeze({
    title: 'Como funciona a confirmação de idade',
    paragraphs: Object.freeze([
      'A Varanda é para quem tem 16 anos ou mais. A verificação é feita por um serviço parceiro, a Didit, em geral com uma selfie e às vezes com um documento.',
      'A foto e o documento não chegam à Varanda. Só a sua faixa de idade fica guardada.',
      'Se não der para confirmar só pelo rosto, dá para tentar de novo com um documento.',
      'Se você saiu antes de terminar, a mesma verificação pode ser retomada por cerca de uma hora.',
      'No app, a verificação abre no navegador. Ao terminar, volte para a Varanda: o resultado é conferido de novo. Na web, a verificação abre nesta aba. Na volta, confirme de novo com o rosto, a digital ou o bloqueio de tela.',
      'O que é guardado está na Política de Privacidade (Ajustes → Termos e privacidade).'
    ])
  }),
  telefone: Object.freeze({
    title: 'Como funciona a confirmação do celular',
    paragraphs: Object.freeze([
      'A Varanda pede um celular brasileiro para confirmar a conta. O código chega por SMS e dá para pedir um novo depois de um minuto.',
      'Só vale celular do Brasil: números virtuais e de telefone fixo são recusados.',
      'Cada número fica em uma conta só. O número não é usado para recuperar a conta.',
      'O que é guardado está na Política de Privacidade (Ajustes → Termos e privacidade).'
    ])
  }),
  identidade: Object.freeze({
    title: 'Como funciona a conta',
    paragraphs: Object.freeze([
      'Sua conta é criada neste aparelho, sem e-mail e sem senha.',
      'Depois, a associação libera a conta para você publicar.'
    ])
  }),
  certificado: Object.freeze({
    title: 'Como liberar sua conta',
    paragraphs: Object.freeze([
      'O código mostrado é o da sua conta. Ele não é segredo.',
      'Envie o código à associação. Ela devolve um texto de liberação: cole esse texto no campo e toque em gravar e continuar.',
      'Sem a liberação, este aparelho não publica nem recebe atualizações.'
    ])
  }),
  perfil: Object.freeze({
    title: 'Como funciona o perfil',
    paragraphs: Object.freeze([
      'Seu nome aparece em cada publicação e no seu perfil. A bio é opcional.',
      'O perfil é público: aparece para todo mundo assim que é publicado.',
      'Dá para pular agora e preencher depois, em Ajustes → Editar perfil.',
      'A foto do perfil é pública. Ela é recortada em quadrado e enviada sem dados de localização. Tirar a foto deixa de mostrá-la no app, mas a cópia enviada continua na rede.'
    ])
  }),
  busca: Object.freeze({
    title: 'Como funciona a Busca',
    paragraphs: Object.freeze([
      SEARCH_HINT,
      SEARCH_MEMORY,
      'A Busca tem duas partes. Em Contas, você encontra pessoas pelo nome ou @nome no site da associação e no app ligado à instalação; em qualquer versão, você pode colar o código de 64 letras e números de alguém para seguir. Em Publicações, você procura palavras nas publicações públicas.',
      'Cada resultado é conferido antes de aparecer. O que não pôde ser conferido conta como indisponível e não é mostrado.'
    ])
  }),
  ausentes: Object.freeze({
    title: 'Por que alguns diários não aparecem',
    paragraphs: Object.freeze([
      'Um diário fica de fora quando a conta não está liberada pela associação, foi bloqueada ou teve a liberação cancelada; quando o histórico dele não confere; quando o diário ficou grande demais; quando uma publicação dele é grande demais para ler; quando não respondeu a tempo; ou quando não há publicação no trecho lido.',
      'Se o diário não respondeu a tempo, puxe a lista para baixo para tentar de novo.'
    ])
  }),
  bloqueio: Object.freeze({
    title: 'Por que alguém não aparece',
    paragraphs: Object.freeze([
      'A conta pode ter sido bloqueada pela moderação da associação, ou a liberação dela deixou de valer.',
      'Nesses casos, as publicações deixam de aparecer no app, mesmo para quem segue. Você continua seguindo a pessoa.'
    ])
  }),
  wifiOnly: Object.freeze({
    title: 'Sincronizar só no Wi-Fi',
    paragraphs: Object.freeze([
      'Ligada, o app não baixa nem envia publicações sozinho enquanto o aparelho usa dados móveis (ou uma conexão que o sistema marca como cara). Ela vem ligada.',
      'Ao sair do Wi-Fi, a sincronização pausa e guarda o que já chegou. Ao voltar ao Wi-Fi, continua de onde parou.',
      'Puxar para atualizar sincroniza mesmo com dados móveis, até a conexão mudar.',
      'Publicar, curtir e ler o que já está no aparelho continuam funcionando.'
    ])
  }),
  instalar: Object.freeze({
    title: 'Como instalar o app',
    paragraphs: Object.freeze([
      'No iPhone: Compartilhar e depois Adicionar à Tela de Início.',
      'No Android, instale pelo Chrome. No Samsung Internet a instalação fica desligada, porque o Android bloqueia o app que esse navegador cria. No Chrome, entre com a mesma passkey.',
      'Depois de instalado, o app abre mesmo sem internet e mostra o que já está neste aparelho.',
      'Apagar os dados do site apaga o que está guardado aqui.',
      'Outra aba deste navegador fica bloqueada enquanto esta estiver aberta.'
    ])
  }),
  moderacao: Object.freeze({
    title: 'Como funciona a lista de moderação',
    paragraphs: Object.freeze([
      'A moderação da associação assina uma lista das contas bloqueadas. O app recebe a lista quando sincroniza e esconde essas contas, mesmo para quem segue.',
      'A data é a da lista que este aparelho segue agora. Uma lista mais antiga nunca desfaz um bloqueio de uma mais nova.',
      'Enquanto nenhuma lista chegou, a moderação ainda não escondeu nenhuma conta neste aparelho.'
    ])
  }),
  denuncia: Object.freeze({
    title: 'Como funciona a denúncia',
    paragraphs: Object.freeze([
      'A denúncia vai para a moderação da associação. A pessoa denunciada não vê quem denunciou.',
      'Se a moderação bloquear, a conta inteira deixa de aparecer para quem usa o app oficial.'
    ])
  }),
  convites: Object.freeze({
    title: 'Como funcionam os convites',
    paragraphs: Object.freeze([
      'Quem já está na Varanda pode criar alguns links de convite por semana e mandar como quiser.',
      'Cada link serve para uma pessoa só e vale 7 dias. Os convites renovam toda segunda-feira, no horário de Brasília, e os que sobram não acumulam.',
      'A associação guarda só quem criou o convite e se ele foi usado; nunca o nome, o e-mail ou a conta de quem recebeu o link.',
      'Quando a associação liga os convites de surpresa, cada convite chega num dia e hora ao acaso, com um aviso. Escolha com carinho quem você quer chamar.',
      'Se você escrever um cartão, ele vai dentro do próprio link, e o app de quem recebe confere que foi você quem escreveu. A associação não recebe o nome nem a mensagem.'
    ])
  }),
  termosAparelho: Object.freeze({
    title: 'Sobre o registro do aceite',
    paragraphs: Object.freeze([
      'Esta conta ainda não terminou o cadastro. Termine o cadastro em Ajustes → Conta e @nome.'
    ])
  }),
  enquadramento: Object.freeze({
    title: 'Como funciona o formato das fotos',
    paragraphs: Object.freeze([
      'Todas as fotos de uma publicação aparecem no mesmo formato: Retrato, Quadrado ou Paisagem.',
      'A Varanda escolhe o formato mais parecido com a primeira foto. Você pode trocar.',
      'Arraste a foto para escolher a parte que aparece. A parte que fica fora do formato não é enviada.',
      'Vídeo e GIF não são cortados: aparecem inteiros dentro do formato.',
      'Se a primeira foto for um GIF, o formato segue o GIF.'
    ])
  }),
  passkeys: Object.freeze({
    title: 'Passkeys e recuperação',
    paragraphs: Object.freeze([LOSS_TEXT, LIST_NOTE, UPDATED_APP_TEXT])
  }),
  recadosAjuste: Object.freeze({
    title: 'Quem pode deixar recado',
    paragraphs: Object.freeze([WALL_NOTE, WALL_PUBLIC])
  }),
  aparelhos: Object.freeze({
    title: 'Aparelhos conectados',
    paragraphs: Object.freeze([DEVICES_NOTE])
  }),
  bloqueados: Object.freeze({
    title: 'Pessoas bloqueadas',
    paragraphs: Object.freeze([BLOCK_TEXTS.listNote])
  }),
  perfilFoto: Object.freeze({
    title: 'A foto do perfil',
    paragraphs: Object.freeze(['A foto do perfil é pública. Ela é recortada em quadrado e enviada sem dados de localização. Tirar a foto deixa de mostrá-la no app, mas a cópia enviada continua na rede.'])
  }),
  perfilSobre: Object.freeze({
    title: 'Bio e Sobre mim',
    paragraphs: Object.freeze([EXTRA_TEXTS.aboutHint])
  }),
  perfilHumor: Object.freeze({
    title: 'Humor do dia',
    paragraphs: Object.freeze([EXTRA_TEXTS.moodHint])
  }),
  gruposPublicos: Object.freeze({
    title: 'Grupos públicos no perfil',
    paragraphs: Object.freeze(['Desligado, o seu perfil não lista esses grupos e você não entra na conta de Grupos de quem você segue de outras pessoas. Dentro de cada grupo público a sua participação continua pública.'])
  }),
  aparecerNaBusca: Object.freeze({
    title: 'Aparecer na busca',
    paragraphs: Object.freeze([
      'Desligado, você deixa de aparecer na busca de contas por nome e por parte do @nome. A mudança pode levar alguns instantes para valer.',
      'Quem já sabe o seu @nome exato ou recebeu o seu link continua podendo seguir você. Quem já segue você continua seguindo.',
      'A escolha fica num registro público do seu diário, como o seu nome e a sua foto: qualquer pessoa que leia o diário vê se ela está ligada ou desligada.'
    ])
  }),
  descricaoMidia: Object.freeze({
    title: 'Descrição de fotos e vídeos',
    paragraphs: Object.freeze([
      'A descrição é lida pelo leitor de tela para quem não vê a foto ou o vídeo.',
      'Conte em poucas palavras o que aparece. Cabem até 140 caracteres em cada item.',
      'Ela é opcional e pública como a publicação, e não muda depois de publicar. Apagar a publicação apaga a descrição.',
      'Quem usa uma versão antiga do aplicativo vê a publicação normalmente, sem a descrição.'
    ])
  })
})

export const SHORT = Object.freeze({
  link: 'A associação guarda o vínculo com o seu celular; o número nunca vai para o seu perfil nem para o seu diário.',
  followsPublic: 'Quem você segue e quem segue você é público.',
  wifiOnly: 'Com dados móveis, a sincronização automática espera o Wi-Fi.',
  install: 'Abra o menu do navegador e escolha instalar o app. No iPhone: Compartilhar e depois Adicionar à Tela de Início.',
  reportPrivacy: 'A pessoa denunciada não vê quem denunciou.',
  termsDeviceOnly: 'Aceite registrado só neste aparelho.',
  search: 'A pesquisa ignora maiúsculas e acentos.'
})
