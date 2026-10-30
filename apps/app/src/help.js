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
      'Em pesquisar por assunto, você procura palavras nas publicações públicas, inclusive de quem você segue.',
      'A Espiadinha só funciona na versão web, no site da associação.'
    ])
  }),
  seguindo: Object.freeze({
    title: 'Como funciona Seguindo',
    paragraphs: Object.freeze([
      'Siga pessoas para ver as publicações delas na Rua. Na versão web, dá para encontrar alguém pelo nome ou pelo @nome.',
      'No lugar do @nome também vale o código da pessoa, com 64 letras e números.',
      'Quem você segue é público: quem tem o seu diário vê essa lista. Ela aparece igual em todos os seus aparelhos.',
      'No topo, um só campo encontra pessoas: digite um nome ou @nome para buscar, ou cole o código da pessoa para seguir direto. Para deixar de seguir, toque em Seguindo e confirme. Para denunciar uma conta, toque na bandeira.'
    ])
  }),
  avisos: Object.freeze({
    title: 'Como funcionam os Avisos',
    paragraphs: Object.freeze([
      'Aqui aparece quem começou a seguir você e que você ainda não segue. Toque no aviso para ver o perfil da pessoa e, se quiser, seguir de volta.',
      'O Varanda não mostra contagem nem lista de seguidores.',
      'Quando há algo novo, a aba ganha um ponto, nunca um número.',
      'Os Avisos só funcionam na versão web, no site da associação.'
    ])
  }),
  diario: Object.freeze({
    title: 'Como funciona o Diário',
    paragraphs: Object.freeze([
      'O Diário é o seu perfil e as suas publicações.',
      'O número ao lado de seguindo é quantas pessoas você segue. Não há lista de quem segue você.',
      'Uma publicação que ainda aguarda envio leva a data do momento em que sai.',
      'Você pode apagar as suas publicações e versões do perfil. Elas somem do app, mas quem já copiou pode ter guardado.'
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
    title: 'Como funciona a pesquisa',
    paragraphs: Object.freeze([
      SEARCH_HINT,
      SEARCH_MEMORY,
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
      'A associação guarda só quem criou o convite e se ele foi usado; nunca o nome, o e-mail ou a conta de quem recebeu o link.'
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
  followsPublic: 'Quem você segue é público.',
  install: 'Abra o menu do navegador e escolha instalar o app. No iPhone: Compartilhar e depois Adicionar à Tela de Início.',
  reportPrivacy: 'A pessoa denunciada não vê quem denunciou.',
  termsDeviceOnly: 'Aceite registrado só neste aparelho.',
  search: 'A pesquisa ignora maiúsculas e acentos.'
})
