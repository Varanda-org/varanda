// Info sheets stay pure so Node tests can load their texts.
// Keys match tab and setup-step ids so callers can use those ids directly.
import { PEEK_RULE_TEXT } from './peek.js'
import { SEARCH_HINT, SEARCH_MEMORY } from './topics.js'

export const HELP = Object.freeze({
  rua: Object.freeze({
    title: 'Como funciona A Rua',
    paragraphs: Object.freeze([
      'Aqui aparecem as publicações de quem você segue, da mais nova para a mais antiga.',
      'Quem você não segue aparece na Espiadinha.',
      'Os números de curtidas e respostas podem chegar incompletos. Eles não mudam o que foi publicado.'
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
      'Aqui aparece quem começou a seguir você e que você ainda não segue. Toque no aviso para ver o perfil da pessoa e, se quiser, seguir de volta.',
      'Quantas pessoas seguem alguém, e quem são, aparece no Diário e no perfil de cada pessoa. Os Avisos continuam só seus.',
      'Os Avisos abrem pelo sino no canto superior direito. Quando há algo novo, o sino ganha um ponto, nunca um número.',
      'Os Avisos funcionam no site da associação e no app ligado à instalação da associação. Não funcionam com uma configuração manual.'
    ])
  }),
  diario: Object.freeze({
    title: 'Como funciona o Diário',
    paragraphs: Object.freeze([
      'O Diário é o seu perfil e as suas publicações.',
      'O número ao lado de seguindo é quantas pessoas você segue. O número ao lado de seguidores é quantas pessoas seguem você. Qualquer pessoa pode ver os dois números e as duas listas; toque num número para abrir a lista. O campo da lista só filtra quem já está nela.',
      'Uma publicação que ainda aguarda envio leva a data do momento em que sai.',
      'Você pode apagar as suas publicações e versões do perfil. Elas somem do app, mas quem já copiou pode ter guardado.'
    ])
  }),
  conversas: Object.freeze({
    title: 'Como funcionam as Conversas',
    paragraphs: Object.freeze([
      'Conversas e grupos de comunidades ficam numa lista só, a mais recente primeiro. Todas mostra a lista inteira; Não lidas e Grupos mostram só parte dela.',
      'Mensagens são textos privados entre duas pessoas, cifrados de ponta a ponta.',
      'A associação guarda só envelopes lacrados por sete dias e não consegue ver quem escreve para quem.',
      'Quem você segue aparece na lista. Qualquer outra pessoa aparece em Pedidos de mensagem, e a mensagem é enviada antes de você aceitar.',
      'Aceitar ou recusar não avisa a outra pessoa.',
      'Não há confirmação de leitura.',
      'Bloquear interrompe as mensagens nos seus aparelhos.',
      'Apagar remove a conversa só nos seus aparelhos.',
      'Uma denúncia envia só a mensagem que você escolheu e a conta de quem enviou, nunca o resto da conversa.',
      'A linha Comunidades serve para achar e criar comunidades.'
    ])
  }),
  entrar: Object.freeze({
    title: 'Como funciona a entrada',
    paragraphs: Object.freeze([
      'Você entra com uma passkey: sem senha e sem e-mail.',
      'Ela fica no gerenciador de senhas do aparelho e abre com biometria ou PIN.',
      'Guarde-a no Gerenciador de Senhas do Google para entrar no celular e no computador.',
      'Se perder a passkey, perde a conta. Outra passkey é outra conta.'
    ])
  }),
  vinculo: Object.freeze({
    title: 'Por que confirmar com o Google',
    paragraphs: Object.freeze([
      'Para entrar na rede, confirme uma conta Google e escolha seu @nome.',
      'A associação guarda o vínculo entre a conta Google e a sua conta Varanda para liberar sua conta e seu @nome, atender uma ordem judicial ou bloquear a conta.',
      'O e-mail nunca vai para o seu diário, para o seu perfil nem para este navegador. A idade não é verificada.',
      'O que é guardado está na Política de Privacidade (Ajustes → Termos e privacidade).',
      'Vamos abrir o Google e, na volta, pedir sua passkey de novo.',
      'O @nome tem de 3 a 20 letras minúsculas, números ou _, começando por letra. Você pode trocá-lo depois, uma vez a cada 7 dias.',
      'Se a rede estiver por convite, a entrada é pelo link que alguém que já está na Varanda te enviou.'
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
      'Dá para pular agora e preencher depois, em Ajustes → Editar perfil.'
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
      'Quando a associação liga os convites de surpresa, cada convite chega num dia e hora ao acaso, com um aviso. Escolha com carinho quem você quer chamar.'
    ])
  }),
  termosAparelho: Object.freeze({
    title: 'Sobre o registro do aceite',
    paragraphs: Object.freeze([
      'Esta conta não tem vínculo com uma conta Google, então o aceite fica registrado só neste aparelho.',
      'Para registrar também na conta, vincule uma conta Google em Ajustes → Conta e @nome.'
    ])
  })
})

export const SHORT = Object.freeze({
  link: 'A associação guarda o vínculo com sua conta Google; o e-mail nunca vai para o seu perfil nem para o seu diário.',
  passkeyLoss: 'Se perder a passkey, perde a conta.',
  followsPublic: 'Quem você segue e quem segue você é público.',
  install: 'Abra o menu do navegador e escolha instalar o app. No iPhone: Compartilhar e depois Adicionar à Tela de Início.',
  reportPrivacy: 'A pessoa denunciada não vê quem denunciou.',
  termsDeviceOnly: 'Aceite registrado só neste aparelho.',
  search: 'A pesquisa ignora maiúsculas e acentos.'
})
