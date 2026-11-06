// Bundled copy: Metro cannot import core. Keep the version in step with
// @varanda/core lib/terms.js; the test digest makes text changes explicit.
// Sources: docs/design.md (LGPD, moderation, identity), docs/app.md and
// SECURITY.md. Planned flows must not read as features already available.

export const LEGAL_VERSION = 23
export const LEGAL_DATE = '06/11/2026'
export const REVIEW_NOTE = 'Versão 23, sujeita a revisão jurídica. Não é parecer jurídico.'

export const TERMS = {
  title: 'Termos de Uso',
  sections: [
    {
      heading: 'O que é o Varanda',
      paragraphs: [
        'O Varanda é uma rede social P2P, ainda em fase de protótipo. P2P significa que os aparelhos trocam cópias dos diários entre si. Os semeadores são serviços que também guardam e distribuem essas cópias.',
        'Quem responde pelo app e pelos serviços compartilhados (semeadores e serviço de conta) é a associação que publica o Varanda. A proposta é que ela seja a controladora dos dados desses serviços. Esse papel numa rede P2P ainda depende de parecer jurídico.'
      ]
    },
    {
      heading: 'Aceite e novas versões',
      paragraphs: [
        'Antes de usar o Varanda, você precisa aceitar estes Termos de Uso e a Política de Privacidade. Cada nova versão será apresentada para um novo aceite antes do uso.',
        'O registro do aceite guarda a versão, a data e a chave pública da conta. A Política de Privacidade explica o que fica no aparelho e no serviço de conta.'
      ]
    },
    {
      heading: 'Sua conta e sua passkey',
      paragraphs: [
        'Na versão web, sua conta vem de uma passkey, que fica no gerenciador de senhas do seu aparelho. A passkey com que a conta foi criada continua abrindo a conta, também sem internet, em qualquer aparelho. Não há exportação da chave.',
        'Em Ajustes, na tela Passkeys e recuperação, você pode adicionar até quatro outras passkeys e um código de recuperação para a mesma conta. Adicionar uma passkey ou um código de recuperação exige a conta vinculada ao Google. Uma passkey adicionada ou o código precisa de internet e do serviço de conta toda vez que você entra de novo com ela ou com ele; uma sessão que continua aberta no aparelho não precisa. Entrar com o código de recuperação termina com a criação de uma passkey nova naquele aparelho. Sem nenhuma passkey e sem o código, a conta não pode ser recuperada. Remover ou trocar o código ou uma passkey adicionada impede novas entradas com ele ou com ela, mas não tira o acesso de quem já entrou, porque a chave da conta não pode ser trocada; se um deles vazar, o caminho seguro é criar uma conta nova.',
        'O Varanda não consegue invalidar a passkey com que a conta foi criada. Para deixar de usá-la, apague essa passkey no gerenciador de senhas.',
        'Na web hospedada, o vínculo com a conta Google dá o certificado de membro e o @nome.',
        'Para que o que você viu em Avisos, Conversas e grupos valha em todos os aparelhos da mesma passkey, o serviço de conta guarda, cifradas, as suas marcações mais recentes de visto. O serviço não consegue ler esse registro. A Política de Privacidade explica o que ele guarda e como pedir que seja apagado.',
        'Você pode excluir a conta em Ajustes, na tela Excluir conta, no app e na web hospedada. Para confirmar, você digita o seu @nome e confirma com a passkey. Se o serviço de conta tem a chave pública dessa passkey, guardada quando a conta foi criada e vinculada ao Google, ele confere a confirmação e a exclusão acontece na hora. Se não tem (contas criadas antes desse registro, ou outra passkey), a exclusão fica agendada por 7 dias: todos os aparelhos em que você entrou mostram o pedido, chega um aviso se os avisos estiverem ligados, e você pode cancelar de qualquer um deles; depois desse prazo, ela segue como uma exclusão na hora. Na exclusão, o serviço de conta apaga o vínculo com o Google, o registro de idade, os aceites destes Termos, os avisos no aparelho, as marcações de visto guardadas para os seus aparelhos, os convites, as passkeys extras, o código de recuperação e a chave pública da passkey, e o app apaga a conta do aparelho. O diário sai dos semeadores da associação em até 7 dias, quando a associação publica a lista de moderação assinada; o app avisa quando isso acontecer. O seu @nome fica reservado e nunca vai para outra pessoa, e a mesma chave não pode voltar a ser usada. Quem ainda é dono de uma página precisa encerrá-la ou transferi-la antes. Se você perdeu o aparelho, entre em outro com a passkey sincronizada ou com o código de recuperação e peça a exclusão por lá; sem nenhuma passkey e sem o código, ainda não há como pedir a exclusão pelo app.',
        'O Varanda é para pessoas com 16 anos ou mais. Esse limite é uma regra adotada pelo Varanda com base no ECA Digital. Na web hospedada, antes de a conta ser liberada, a idade é confirmada por um serviço parceiro de verificação, a Didit. Isso vale para todos os membros da web hospedada, inclusive quem entrou antes, e o app fica bloqueado até a verificação dar certo.',
        'A verificação costuma estimar a idade por uma selfie e pode pedir um documento. O serviço de conta guarda só a faixa de idade (16 a 17 anos ou 18 anos ou mais), nunca a foto, o documento ou a data de nascimento. Se o resultado não for conclusivo, você pode tentar de novo com um documento.',
        'No app nativo, com certificado dado pela associação, essa verificação ainda não é feita nesta versão.',
        'O guardião e a recuperação por e-mail continuam planejados.'
      ]
    },
    {
      heading: 'Seu @nome',
      paragraphs: [
        'O @nome tem de 3 a 20 caracteres. Você pode mudar o @nome no máximo uma vez a cada 7 dias. Um nome usado nunca é dado a outra pessoa.',
        'Quem ainda não sincronizou, ou usa um nó antigo, pode continuar vendo seu nome anterior por algum tempo.'
      ]
    },
    {
      heading: 'Convivência e denúncias',
      paragraphs: [
        'Você pode denunciar uma publicação ou uma conta por um destes motivos: spam, assédio, conteúdo ilegal ou outro. São esses os motivos sobre os quais a moderação atua. Estes Termos não criam outras obrigações de conduta além delas.',
        'As denúncias funcionam na versão web hospedada, com a passkey desbloqueada e a conta Google vinculada. A denúncia é assinada com a chave pública de quem denuncia. Você pode incluir uma observação. A denúncia também leva um trecho da publicação, do jeito que você o enviou. A moderação não confere esse trecho.',
        'A pessoa denunciada não tem tela nem rota para ver a denúncia contra ela.'
      ]
    },
    {
      heading: 'Como funciona a moderação',
      paragraphs: [
        'Moderadores humanos analisam denúncias e podem decidir bloquear ou descartar. Um bloqueio vale para a chave pública inteira da conta, não só para uma publicação. Ele passa a valer na rede por uma lista assinada pela moderação. Descartar vale na hora. Bloquear só chega à lista quando o operador do serviço aplica a decisão e a assina.',
        'A triagem automática só roda quando o operador a liga. Ela vem desligada por padrão. Há também um modo de observação, em que ela apenas mostra sugestões aos moderadores. Quando ligada para decidir, ela compara o texto verificado da publicação com casos já decididos por pessoas e só age em casos quase idênticos, sem nenhum caso divergente parecido. Ela pode pedir bloqueio por spam e descartar denúncias de spam ou outro. Nos demais casos, a decisão fica para uma pessoa.',
        'Denúncias por conteúdo ilegal sempre são decididas por uma pessoa. Assédio, denúncias de conta e publicações com fotos também ficam para pessoas. A IA não vê imagens. Um descarte feito pela IA vale na hora. Um bloqueio pedido pela IA só chega à lista depois que o operador o revisa e confirma num terminal. A IA não assina a lista nem desbloqueia contas.',
        'Os nós atualizados que obedecem à lista apagam e recusam o diário bloqueado. A lista não alcança aparelhos que a ignoram nem nós antigos que não a aplicam. Apps modificados podem trocar o diário diretamente entre si. O app da própria pessoa bloqueada mantém o diário local e pode servi-lo a quem já conhece a chave pública desse diário.',
        'Na web instalada, sem rede, vale a lista que está guardada no aparelho. Uma lista mais nova chega pelo semeador. A lista contém chaves públicas, sequência e datas, sem motivo, nome, e-mail ou conta Google. Ordens judiciais de bloqueio são cumpridas pela mesma lista.'
      ]
    },
    {
      heading: 'Fotos e recursos planejados',
      paragraphs: [
        'A mídia aceita nesta etapa é imagem e, só nas conversas, mensagem de voz: fotos e GIFs nas publicações e a foto do perfil, pela web hospedada, e fotos, GIFs e mensagens de voz nas mensagens diretas e nos grupos, como descrito abaixo. A foto do perfil é sempre uma imagem parada e quadrada; um GIF escolhido para ela vira imagem parada. Vídeos não são aceitos. A comparação com listas de hashes de mídia ilegal é planejada e ainda não existe. Hoje, denúncias e bloqueio da conta são os meios de moderação dessas imagens. Uma foto de perfil imprópria se denuncia pela conta toda, e essa denúncia sempre é decidida por uma pessoa.',
        'Na versão web hospedada, você pode ligar em Ajustes os avisos no aparelho (notificações push) de novo seguidor, resposta, curtida e republicação e o aviso de que chegou um convite para você chamar alguém para a Varanda. São opcionais e vêm desligados por padrão. Cada aviso leva o nome de quem agiu e a ação, nunca o texto da publicação, exceto o aviso de convite, que mostra sempre a mesma frase, sem nome de ninguém e sem texto de publicação. Aceitar estes documentos não liga os avisos: isso depende de uma escolha separada.',
        'Na versão web hospedada e no app instalado, você pode trocar mensagens diretas com outros membros. Elas levam texto e, se você quiser, fotos e GIFs, e são cifradas de ponta a ponta entre os aparelhos de quem conversa. Os semeadores da associação guardam apenas envelopes lacrados de tamanho fixo, por até sete dias, num só conjunto comum; eles não conseguem ler os envelopes nem saber, pelo que guardam, quem escreveu para quem. Um semeador alterado ainda poderia tentar cruzar horários e endereços de rede; por isso o aparelho pega selos de envio com antecedência, o que dificulta esse cruzamento sem eliminá-lo. O serviço nunca sabe se uma mensagem foi lida. Mensagens de quem você não segue esperam em Pedidos de mensagem até você aceitar. Bloquear e apagar acontecem nos seus aparelhos. Ao denunciar, vão para os moderadores a mensagem que você escolheu, a conta de quem a enviou, o motivo e o comentário que você escrever, junto com a sua conta, como em qualquer denúncia; o resto da conversa nunca sai do aparelho. Na versão web hospedada, se você ligar os avisos no aparelho (push), o aviso de mensagem diz apenas que pode haver uma mensagem nova, sem nome nem texto. O app instalado ainda não tem avisos push.',
        'Nas mensagens diretas e nos grupos, você pode enviar fotos e GIFs escolhidos da galeria do aparelho, até 4 por mensagem, com legenda opcional. A foto de uma mensagem direta é cifrada no seu aparelho antes de sair dele e fica no semeador da associação sob um identificador aleatório, por até sete dias; o semeador não consegue ver a imagem nem saber para quem ela é. Ela também fica guardada, cifrada, nos aparelhos que a abriram, até a sessão terminar, você tocar em Sair ou apagar os dados do app. A foto de um grupo público é pública como o texto do grupo. A foto de um grupo privado é cifrada no aparelho de quem envia: o semeador guarda só a versão cifrada, e a chave vai dentro da publicação lacrada do grupo, então só os aparelhos dos membros conseguem abri-la. Ao denunciar uma mensagem direta ou uma mensagem de grupo privado com foto, a primeira imagem vai junto, aberta, numa cópia reduzida que aparece na tela da denúncia antes de você enviar; se você não enviar, nada sai do aparelho. Os moderadores a recebem marcada como não conferida, e uma denúncia com imagem sempre é decidida por uma pessoa.',
        'Nas mensagens diretas e nos grupos, você também pode gravar no app uma mensagem de voz de até dois minutos, uma por mensagem e sem foto junto. O app só pede acesso ao microfone quando você começa a gravar e não grava em segundo plano. Onde o aparelho ou o navegador não consegue gravar no formato aceito, o botão de gravar não aparece. A mensagem de voz é guardada e protegida como as fotos das conversas: numa mensagem direta, é cifrada no seu aparelho, fica no semeador sob um identificador aleatório por até sete dias e fica nos aparelhos que a abriram; num grupo público, é pública como o texto do grupo; num grupo privado, é cifrada e só os aparelhos dos membros conseguem ouvi-la. Ao denunciar uma mensagem direta ou uma mensagem de grupo privado com mensagem de voz, o áudio vai junto, aberto, se tiver até 700 KB; a tela da denúncia deixa você ouvi-lo antes de enviar e avisa quando ele não coube. Se você não enviar, nada sai do aparelho. Os moderadores recebem o áudio marcado como não conferido, e uma denúncia com áudio sempre é decidida por uma pessoa.',
        'Quando a associação liga a busca de GIFs, você pode procurar GIFs no campo de mensagem das conversas. O texto que você busca vai do app para o serviço de conta da associação, que pergunta ao provedor de GIFs escolhido pela associação, a partir do endereço e com a chave da própria associação. O provedor recebe só o texto da busca: nunca o seu endereço de rede, a sua conta nem quem você é. As miniaturas também chegam pelo serviço de conta. O GIF que você escolhe é copiado para o armazenamento do Varanda e enviado como uma foto da conversa, com a mesma proteção; quem recebe nunca fala com o provedor. Para limitar o uso, o serviço conta por dia quantas buscas e quantos GIFs cada membro pediu, até 120 buscas e 60 GIFs por dia, e não guarda o texto das buscas. Quando a associação não liga a busca, o botão não aparece.'
      ]
    },
    {
      heading: 'Páginas',
      paragraphs: [
        'Uma página é o diário de um negócio ou projeto, com @nome próprio. Quem a cria é o dono. O serviço de conta da associação escreve no diário da página em nome do dono e dos administradores, com uma chave de assinatura da página que fica com o serviço, não no seu aparelho. Esse desenho ainda depende de parecer jurídico.',
        'O dono e os administradores que aceitaram o convite formam uma lista pública de @nomes na página. Qualquer pessoa que tenha o diário da página vê essa lista. O @nome de uma página vem do mesmo conjunto dos @nomes de pessoas, e um nome já usado nunca é dado a outra conta ou página. Uma página renomeada pode retomar o próprio nome anterior depois do período de espera, e o nome de uma página encerrada fica queimado para sempre.',
        'Só o dono convida e remove administradores. Passar a página para outra pessoa só vale se ela aceitar. O dono anterior continua administrador até ser removido.',
        'Tudo o que a página publica, como publicações, fotos e quem ela segue, é público como a página, e os limites da exclusão abaixo valem do mesmo jeito.',
        'Uma página também pode ter Conversas. Ao contrário das suas Conversas pessoais, a chave de mensagens da página fica com o serviço de conta da associação, que pode ler as mensagens enviadas para a página e as enviadas por ela. Quem administra a página lê e envia pelo serviço. Um administrador removido perde o acesso a essas mensagens no momento da remoção. As Conversas de uma página não acompanham uma troca de chave da página: a nova chave começa uma caixa nova.',
        'Uma página pode entrar em comunidades e grupos. O que ela segue, as fotos que publica e o que escreve em comunidades e grupos públicos é público como a página. As chaves que a página usa nas comunidades, a caixa dos grupos privados e as chaves de escrita, ficam com o serviço de conta da associação, que por isso pode ler as publicações da página em grupos privados.',
        'O serviço de conta também lê os avisos enviados para a página, em nome de quem a administra, para mostrá-los a eles.',
        'Encerrar uma página é definitivo. As publicações deixam de aparecer para quem está com o aplicativo em dia, mas as cópias que alguém já guardou continuam existindo, e o @nome nunca mais é dado a ninguém.',
        'O dono pode mudar a chave da página. A página nova publica que sucede a antiga, e o histórico da chave antiga continua legível. Se a chave antiga tiver vazado, ela ainda pode aparecer até que quem lê tenha o aviso de mudança assinado ou até que a associação a bloqueie. Os aparelhos de quem segue a página passam a seguir a chave nova sozinhos, depois de conferirem eles mesmos o aviso de mudança.',
        'Quem administra uma página a partir de um nó core usa uma chave guardada naquele aparelho. Ela aparece junto com o diário daquele aparelho, e não com um @nome.'
      ]
    },
    {
      heading: 'Limites da exclusão',
      paragraphs: [
        'Você pode apagar uma publicação (resposta e citação incluídas) e uma versão do perfil. Os semeadores e apps oficiais e atualizados deixam de mostrar o item e descartam os bytes dele nas suas cópias, inclusive as imagens que só ele usava. Isso não é um apagamento garantido em qualquer lugar: um aparelho que acabou de seguir você pode guardar o conteúdo por pouco tempo, até receber a exclusão. Apps e semeadores antigos ou modificados não obedecem, e cópias que já chegaram a outros aparelhos, fotos já baixadas, capturas de tela, imagens guardadas em cache e as citações guardadas pelo serviço de conta numa denúncia podem manter o conteúdo. Um diário que já atingiu o limite de blocos não aceita mais nem o registro de exclusão. Limpar os dados do site só apaga os dados locais; não apaga as cópias que já chegaram a outros aparelhos ou semeadores.',
        'Excluir a conta, a seu pedido em Ajustes ou por decisão da moderação, bloqueia a chave pública da conta na lista de moderação. Depois disso, os semeadores e apps atualizados apagam e recusam o diário. Mesmo assim, não é possível garantir a exclusão de cópias em apps modificados, em aparelhos que não obedecem à lista, em mensagens já entregues nem em capturas de tela. As comunidades e os grupos criados pela conta deixam de existir para todos os participantes. A exclusão a seu pedido apaga a conta do seu aparelho; o bloqueio pela moderação não apaga o diário do aparelho do autor.'
      ]
    },
    {
      heading: 'Contato provisório',
      paragraphs: [
        'O encarregado de proteção de dados previsto no Art. 41 ainda não foi nomeado. Um canal privado para pedidos sobre seus dados será publicado com o encarregado.',
        'O contato provisório para perguntas gerais é pelas issues do GitHub. Nunca coloque dados pessoais em uma issue pública. Endereço: https://github.com/Varanda-org/varanda/issues',
        'Para problemas de segurança, use o formulário privado de vulnerabilidades. Esse formulário é somente para segurança, não para pedidos sobre seus dados. Não publique vulnerabilidades em issues públicas. Endereço: https://github.com/Varanda-org/varanda/security/advisories/new'
      ]
    }
  ]
}

export const PRIVACY = {
  title: 'Política de Privacidade',
  sections: [
    {
      heading: 'Quem trata os dados',
      paragraphs: [
        'A proposta é que a controladora seja a associação que publica o Varanda e mantém os serviços compartilhados. A definição desse papel numa rede P2P ainda depende de parecer jurídico.',
        'Encarregado de proteção de dados do Art. 41: ainda não nomeado. Um canal privado para pedidos sobre seus dados será publicado com o encarregado.'
      ]
    },
    {
      heading: 'Diário, perfil e fotos',
      paragraphs: [
        'Publicações, perfil, lista de quem você segue e fotos ficam no seu aparelho, nos aparelhos de quem segue você e nos semeadores no Brasil. A lista de quem você segue e as fotos são públicas para quem tem o diário. Além disso, no site da associação e no app ligado à instalação da associação, qualquer pessoa vê o número e a lista de quem cada pessoa segue e de quem segue cada pessoa, montados a partir desses registros públicos. A foto do perfil é pública, como o nome e a bio. Antes do envio, o app recorta a foto em quadrado, reduz para 512 por 512 pixels e grava de novo, o que remove dados como a localização (GPS) e o modelo da câmera.',
        'Na Espiadinha, os diários espiados ficam só na memória do navegador. Recarregar descarta essas cópias. No nó, a cópia guardada vale por até 5 minutos. As fotos de perfil de quem você não segue também ficam só na memória do navegador, sem cópia guardada.',
        'Seu nome e seu @nome podem aparecer na busca do semeador. O índice guarda só tokens dobrados, ou seja, partes dos nomes normalizadas para a busca, em memória. O índice some ao reiniciar o semeador. Ainda não há opção de sair dessa busca.',
        'Fotos e GIFs enviados em mensagens diretas são cifrados no aparelho de quem envia. O semeador guarda só a versão cifrada, sob um identificador aleatório, por até sete dias, e não consegue ver a imagem nem saber quem a enviou ou para quem. Os aparelhos que abrem a foto guardam uma cópia cifrada, apagada quando a sessão termina, quando você toca em Sair ou quando os dados do app são apagados. Fotos de grupos públicos são públicas como o texto do grupo e ficam nos mesmos lugares que as fotos das publicações. Fotos de grupos privados ficam cifradas no semeador; a chave só existe dentro da publicação lacrada do grupo, nos aparelhos dos membros.',
        'As mensagens de voz das mensagens diretas e dos grupos seguem as regras das fotos da mesma conversa: cifradas no semeador por até sete dias nas mensagens diretas, públicas nos grupos públicos e cifradas, com a chave só nos aparelhos dos membros, nos grupos privados. O microfone só é usado enquanto você grava. As conversas não aceitam vídeo.',
        'Na busca de GIFs, quando a associação a liga, o texto que você digita vai para o serviço de conta da associação, que repassa só esse texto ao provedor de GIFs, a partir do endereço da associação. O provedor não recebe o seu endereço de rede, a sua conta nem nada que identifique você. O serviço não guarda o texto das buscas nem o grava em registros; guarda só, por membro, a contagem de buscas e de GIFs pedidos no dia, para aplicar o limite diário, e a descarta quando o dia acaba. O GIF escolhido vira uma foto da conversa, guardada no armazenamento do Varanda como as outras fotos da mesma conversa.'
      ]
    },
    {
      heading: 'Vínculo com o Google',
      paragraphs: [
        'O serviço de conta, no Brasil, guarda o identificador interno da conta Google (chamado de sub), o e-mail, a chave pública do membro, o @nome atual e os @nomes já usados, as datas e o certificado. Os nomes passados ficam associados ao membro para nunca serem dados a outra pessoa.',
        'Esses dados servem para dar o certificado e o @nome, atender ordens judiciais e bloquear contas. O e-mail nunca entra no diário, no certificado nem no navegador.',
        'Para que o que você viu em Avisos, Conversas e grupos valha em todos os aparelhos da mesma passkey, o serviço de conta, no Brasil, guarda um bloco de tamanho fixo por conta, criado na primeira vez que um aparelho grava as suas marcações. O bloco tem as marcações de visto mais recentes: quando ele enche, as mais antigas saem, e um aviso antigo pode voltar a aparecer como novo em outro aparelho. O bloco é cifrado com uma chave que só os seus aparelhos conseguem gerar. O serviço não consegue ler o bloco: vê só que ele existe e quando mudou e, como em qualquer pedido autenticado, qual conta fez o pedido. Cada gravação substitui a anterior. Recomeçar num aparelho não o apaga, porque os outros aparelhos da passkey continuam a usá-lo. Para apagá-lo, peça à associação, como os demais dados (veja Seus direitos e os limites do P2P); a exclusão da conta continua sem fluxo por conta própria.',
        'Quando você exclui a conta em Ajustes, o serviço de conta apaga o sub, o e-mail, o certificado e os registros do @nome. Ficam só a chave pública, a data da exclusão e os @nomes que a conta usou, sem ligação com a conta Google, para que a mesma chave não volte e esses nomes nunca sejam dados a outra pessoa. A mesma conta Google pode criar uma conta nova, com outra passkey.',
        'O Varanda é para pessoas com 16 anos ou mais, um limite adotado pelo Varanda com base no ECA Digital. Na web hospedada, antes de a conta ser liberada, a idade é confirmada por um serviço parceiro de verificação, a Didit. Isso vale para todos os membros da web hospedada, inclusive quem entrou antes, e o app fica bloqueado até a verificação dar certo. No app nativo, com certificado dado pela associação, essa verificação ainda não é feita nesta versão.',
        'A verificação costuma estimar a idade por uma selfie e pode pedir um documento. A selfie e o documento são tratados pelo parceiro e nunca chegam ao Varanda. O serviço de conta guarda só a faixa de idade (16 a 17 anos ou 18 anos ou mais), a forma de verificação e a data, nunca a foto, o documento ou a data de nascimento. Se o resultado não for conclusivo, você pode tentar de novo com um documento.',
        'O Varanda pede ao parceiro que apague a sessão de verificação logo depois da decisão, e as configurações de retenção do parceiro ficam no mínimo. A imagem do rosto é um dado sensível; a base legal para esse tratamento ainda será confirmada por parecer jurídico. O vínculo com o Google e o certificado atual não afirmam a idade. O guardião e o e-mail de recuperação são planejados.'
      ]
    },
    {
      heading: 'Páginas',
      paragraphs: [
        'O diário de uma página (publicações, perfil, foto do perfil, fotos das publicações e a lista de quem a página segue) é público, como o de uma pessoa, e fica nos mesmos lugares: aparelhos de quem segue a página e semeadores no Brasil. O serviço de conta da associação também guarda uma cópia completa do diário da página (publicações, perfil, fotos e quem ela segue) no próprio armazenamento, porque escreve e replica a página para o semeador. Como o de qualquer diário, ele pode ficar na memória do navegador de quem espia pela Espiadinha. A lista de administradores, com o @nome do dono e dos administradores que aceitaram, também é pública.',
        'A chave que assina o diário da página fica no serviço de conta, no Brasil, e não no aparelho de quem a administra. A proposta é execução de contrato, Art. 7º, V, ainda sem parecer jurídico.',
        'As mensagens enviadas para uma página e as enviadas por ela podem ser lidas pelo serviço de conta, porque a chave de mensagens da página fica com ele; o serviço guarda as mensagens da página cifradas, e quem administra a página as lê por ele. Esse desenho ainda depende de parecer jurídico.',
        'O serviço de conta guarda as chaves que a página usa em comunidades e grupos (a caixa dos grupos privados e as chaves de escrita) e pode ler as publicações da página em grupos privados. Ele lê os avisos enviados para a página em nome de quem a administra. Num nó core, a chave de quem administra fica guardada no próprio aparelho, e o serviço guarda só o ponto até onde já leu as mensagens da página.',
        'Encerrar uma página é definitivo: os dados que o serviço guarda dela são apagados, o @nome fica queimado, e as cópias que já estão em outros aparelhos e semeadores continuam existindo.'
      ]
    },
    {
      heading: 'Registro do aceite',
      paragraphs: [
        'No aparelho ficam a versão, a data e a chave pública de cada conta que aceitou neste aparelho.',
        'Para membros com conta Google vinculada, o serviço de conta também guarda a chave pública do membro, a versão, a data do servidor, o nonce e a assinatura. O nonce é o desafio usado para assinar o aceite. Esse registro nunca inclui o e-mail.'
      ]
    },
    {
      heading: 'Denúncias e decisões',
      paragraphs: [
        'O serviço de conta, no Brasil, guarda as denúncias. Cada denúncia inclui a chave pública de quem denuncia, a chave pública denunciada, o número da publicação quando há, o motivo, a observação opcional, um trecho da publicação, a data e a assinatura. O trecho é o que quem denunciou enviou, e a moderação não o confere.',
        'O registro de decisões guarda a decisão, a data e o e-mail do moderador. Os e-mails dos moderadores também ficam na configuração do servidor. Uma decisão automática é identificada como feita pela IA.',
        'O e-mail do vínculo Google de quem denuncia e de quem é denunciado não aparece no painel nem no registro de decisões. A operação do servidor pode obtê-lo para atender um pedido legal. A pessoa denunciada não tem acesso à denúncia por tela ou rota do serviço.',
        'Ao denunciar uma mensagem direta ou uma mensagem de grupo privado com foto, a primeira imagem vai junto com a denúncia, aberta, numa cópia reduzida em JPEG de até 700 KB que quem denuncia vê antes de enviar. A denúncia de uma mensagem de grupo público aponta para a mensagem, sem imagem anexada. O serviço de conta guarda essa imagem junto com a denúncia, com acesso restrito, inclusive depois da decisão, como prova. A moderação a vê marcada como não conferida, e uma denúncia com imagem sempre é decidida por uma pessoa.',
        'Ao denunciar uma mensagem direta ou uma mensagem de grupo privado com mensagem de voz, o áudio vai junto com a denúncia, aberto, como foi gravado, se tiver até 700 KB; quem denuncia pode ouvi-lo antes de enviar. O serviço de conta guarda esse áudio como guarda a imagem de uma denúncia, com acesso restrito, inclusive depois da decisão. A moderação o ouve marcado como não conferido, e uma denúncia com áudio sempre é decidida por uma pessoa.'
      ]
    },
    {
      heading: 'Dados da triagem automática',
      paragraphs: [
        'A triagem automática só roda quando o operador a liga; por padrão ela está desligada. Quando ligada, ela lê e confere o texto da publicação no semeador. Ela roda no serviço de conta, no Brasil. Nenhum texto é enviado a uma API externa de IA. A triagem não vê imagens; a comparação com listas de hashes de mídia ilegal é planejada.',
        'O serviço guarda até 4000 precedentes humanos: texto verificado, motivo, decisão, hash e vetor quantizado, uma representação numérica usada na comparação. Ele também guarda marcas da triagem e até 2000 leituras verificadas em cache.',
        'Esses arquivos têm acesso restrito ao usuário do serviço no sistema. Se o arquivo de precedentes tiver uma linha inválida, ele fica indisponível e não é regravado. Se o arquivo de marcas e leituras estiver corrompido, é renomeado como arquivo corrompido e recriado.'
      ]
    },
    {
      heading: 'Finalidades e bases legais propostas',
      paragraphs: [
        'As bases legais descritas aqui são uma proposta, ainda sem parecer jurídico.',
        'Para publicações, perfil, seguidos, fotos (inclusive as das mensagens diretas e dos grupos), mensagens de voz, a busca de GIFs e o vínculo Google que dá o certificado e o @nome, a proposta é execução de contrato, Art. 7º, V.',
        'Registro do aceite: a finalidade é registrar qual versão cada conta aceitou. A base legal é uma proposta, ainda sem parecer jurídico.',
        'Faixa de idade: a finalidade é cumprir a regra de idade mínima. A base legal proposta é obrigação legal (ECA Digital), a confirmar em parecer jurídico.',
        'Denúncias, decisões e dados de triagem servem à moderação e ao atendimento de pedidos legais. A base legal para esse tratamento ainda precisa de parecer jurídico.',
        'Registros de acesso, com IP, data e hora, ficam nos semeadores e serviços, se aplicável. A proposta é obrigação legal caso o Art. 15 do Marco Civil se aplique.'
      ]
    },
    {
      heading: 'Por quanto tempo',
      paragraphs: [
        'A retenção está em aberto (issue #38). Isso inclui os dados do vínculo Google, as denúncias, as decisões e os precedentes de triagem. Denúncias e decisões não são apagadas automaticamente. Não há um prazo de retenção definido aqui para os registros de aceite.',
        'Ao excluir a conta, o serviço de conta apaga o vínculo com o Google, o registro de idade, os aceites dos Termos, as inscrições de aviso no aparelho, o bloco cifrado das marcações de visto, os convites que você criou, as marcas dos convites de surpresa, as entradas de recuperação (de cada entrada fica por 30 dias só a chave pública e a data da remoção) e a chave pública da passkey com o pedido agendado, se houver (fica por 30 dias só a chave pública da conta e a data). Isso acontece na hora do pedido confirmado com a passkey registrada, ou na data de um pedido agendado; até essa data, tudo continua guardado como antes, e cancelar o pedido apaga só a data. Ficam a chave pública, a data da exclusão e os @nomes já usados; as denúncias feitas por você ou contra você e as decisões dos moderadores, para moderação e pedidos legais, sem prazo definido ainda (issue #38); e os registros de acesso, se o Marco Civil se aplicar. O diário sai dos semeadores da associação em até 7 dias.',
        'O desenho propõe guardar publicações, perfil, seguidos e fotos até a pessoa apagar. Apagar publicações e versões do perfil já está disponível: as cópias oficiais atualizadas deixam de mostrá-las e descartam os bytes, mas cópias antigas, apps modificados, caches de imagem e as citações guardadas pelo serviço de conta podem guardar o conteúdo. A retenção das cópias também depende dos limites da rede P2P. Tirar a foto do perfil só deixa de mostrá-la; a foto já enviada continua gravada na rede.',
        'As cópias da Espiadinha e o índice de nomes têm os limites de memória descritos acima. Esses limites não apagam as réplicas normais dos diários no semeador. Para registros de acesso, o prazo proposto é de 6 meses, se aplicável.',
        'As fotos cifradas das mensagens diretas ficam no semeador por até sete dias. As fotos dos grupos seguem as fotos das publicações. As mensagens de voz seguem as fotos da mesma conversa. O texto da busca de GIFs não é guardado; a contagem diária de buscas fica só até o fim do dia. A imagem ou o áudio enviado numa denúncia segue a denúncia, que ainda não tem prazo de retenção.'
      ]
    },
    {
      heading: 'Compartilhamento e cópias fora do Brasil',
      paragraphs: [
        'A rede compartilha cópias dos diários com os aparelhos de quem segue você e com semeadores no Brasil. A Espiadinha permite a leitura de outros diários só em memória. O Google é usado no vínculo de entrada com a conta Google e no login dos moderadores no painel de moderação. A Didit é o serviço parceiro que faz a verificação de idade na web hospedada. Quando a associação liga a busca de GIFs, o provedor de GIFs escolhido por ela recebe o texto das buscas, enviado pelo serviço de conta a partir do endereço da associação, sem o seu endereço de rede nem a sua conta; esse provedor pode estar fora do Brasil.',
        'Cópias podem sair do Brasil quando ficam nos celulares de membros que estejam no exterior. Esse é um limite do armazenamento distribuído em P2P. O serviço de push do navegador (Google, Mozilla, Apple ou Microsoft), que pode estar fora do Brasil, recebe apenas o endereço do aparelho e um texto cifrado que só esse aparelho pode ler. O serviço de conta da associação, no Brasil, guarda a inscrição (endereço e chaves, em push.json) até você desligar os avisos ou o serviço de push informar que a inscrição deixou de existir. Quando os convites de surpresa estão ligados, o mesmo serviço guarda também, em invite-drops.json, a sua chave pública, a semana e quais convites daquela semana já foram avisados, sem horário; esse registro é apagado quando a semana termina. O tratamento da verificação de idade pela Didit também pode acontecer fora do Brasil. O mecanismo para essa transferência internacional, conforme a Resolução CD/ANPD nº 19/2024, ainda será confirmado por parecer jurídico.',
        'A associação pode atender pedidos legais com os dados que seus serviços guardam. Ela não tem como entregar conteúdo que só existe nos aparelhos dos membros. A associação não tem como ler mensagens diretas. O que ela pode guardar é: os envelopes lacrados no semeador, por até sete dias; um resumo (hash) de cada selo de envio já usado, por até 14 dias, que não diz quem o usou; um contador diário de selos de envio por membro (a chave do membro e uma contagem do dia atual e do anterior, nunca o destinatário); as fotos e mensagens de voz cifradas das mensagens diretas, por até sete dias, sem saber de quem são; a mensagem que um membro escolheu denunciar, com a conta de quem a enviou, o motivo, o comentário, a imagem ou o áudio que foi junto e a conta de quem denunciou; a inscrição de aviso push que ela já guarda; e, no serviço de conta, o bloco cifrado com as suas marcações de visto, que ela não consegue ler.'
      ]
    },
    {
      heading: 'Seus direitos e os limites do P2P',
      paragraphs: [
        'O Art. 18 trata de direitos sobre seus dados, como acesso, portabilidade, correção e eliminação. Seu diário já fica no seu aparelho. A exclusão e a portabilidade dos dados do vínculo Google dependem do serviço de conta, não só do diário.',
        'Você pode mudar o nome, a bio e a foto do perfil, e tirar a foto quando quiser. Tirar a foto faz o app deixar de mostrá-la, mas a foto já enviada continua gravada na rede, como as fotos das publicações, e quem já tem uma cópia pode mantê-la. Para o @nome, vale o intervalo de 7 dias, e um nome usado nunca vai para outra pessoa. Você também pode apagar uma publicação ou uma versão do perfil: as cópias oficiais atualizadas deixam de mostrá-la e descartam os bytes, mas apps antigos ou modificados, caches de imagem e cópias já obtidas não obedecem. O fluxo de corrigir uma publicação e o pedido assinado para apagá-la são planejados.',
        'O bloqueio da chave faz os semeadores e apps atualizados que obedecem à lista apagarem e recusarem o diário. Não revoga o certificado individual e não apaga o diário do aparelho do autor. Não é possível garantir a eliminação de cópias em apps modificados ou aparelhos que ignoram a lista.',
        'Você pode excluir a conta em Ajustes, na tela Excluir conta (veja os Termos e "Por quanto tempo"). A exclusão apaga os dados do serviço de conta e bloqueia a chave na lista de moderação; cópias em apps modificados não podem ser garantidas. Fora isso, ainda não há um canal para pedidos sobre seus dados além do que o app já faz. O canal privado para exercer seus direitos será publicado com o encarregado. Nunca envie dados pessoais por uma issue pública.'
      ]
    },
    {
      heading: 'Segurança e sessão no navegador',
      paragraphs: [
        'Na web, a chave da conta vem da passkey com que a conta foi criada, e essa passkey continua abrindo a conta, também sem internet, em qualquer aparelho. Você pode adicionar até quatro outras passkeys e um código de recuperação para a mesma conta. Adicionar uma passkey ou um código de recuperação exige a conta vinculada ao Google. Para cada uma, o serviço de conta guarda só um texto cifrado que ele não consegue abrir, o tipo, a data, a chave pública da conta e um identificador que ele não consegue ligar a uma passkey. Da passkey com que a conta foi criada, quando ela é criada e vinculada ao Google, o serviço de conta guarda o identificador, a chave pública, um contador do autenticador e a data, para conferir a confirmação com a passkey ao excluir a conta; isso não abre a conta, e o serviço não guarda nenhum segredo da passkey. Uma passkey adicionada ou o código precisa do serviço de conta toda vez que você entra de novo com ela ou com ele (uma sessão que continua aberta no aparelho não precisa), e entrar com o código termina com a criação de uma passkey nova naquele aparelho. Sem nenhuma passkey e sem o código, a conta não pode ser recuperada. Remover ou trocar o código ou uma passkey adicionada impede novas entradas com ele ou com ela, mas não tira o acesso de quem já entrou, porque a chave da conta não pode ser trocada; se um deles vazar, o caminho seguro é criar uma conta nova. O Varanda não consegue invalidar a passkey original: para deixar de usá-la, apague-a no gerenciador de senhas. O guardião e a recuperação por e-mail continuam planejados.',
        'Para manter você conectado, o navegador guarda o resultado da passkey cifrado, preso ao endereço do app e à identidade. A sessão dura até você tocar em Sair ou ficar 30 dias sem abrir o app. Cada abertura renova esse prazo.',
        'A chave que cifra a sessão fica no mesmo perfil do navegador. Uma cópia desse perfil ou um script que rode no endereço do app pode permitir agir como você. Quem usa seu aparelho desbloqueado também pode publicar em seu nome.',
        'A chave secreta da moderação fica fora do servidor. A lista de bloqueio é assinada e não contém nome, e-mail, conta Google nem motivo da decisão.'
      ]
    },
    {
      heading: 'Mudanças e contato provisório',
      paragraphs: [
        'Cada nova versão destes documentos será apresentada para um novo aceite antes do uso. As definições jurídicas ainda estão em revisão.',
        'Para perguntas gerais, o contato provisório é pelas issues do GitHub. Nunca coloque dados pessoais em uma issue pública. Endereço: https://github.com/Varanda-org/varanda/issues',
        'O formulário privado de vulnerabilidades serve somente para problemas de segurança. Não é o canal de pedidos sobre seus dados. Não publique vulnerabilidades em issues públicas. Endereço: https://github.com/Varanda-org/varanda/security/advisories/new',
        'O encarregado ainda não foi nomeado. O canal privado para pedidos sobre seus dados será publicado com sua nomeação.'
      ]
    }
  ]
}
