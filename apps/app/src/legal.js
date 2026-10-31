// Bundled copy: Metro cannot import core. Keep the version in step with
// @varanda/core lib/terms.js; the test digest makes text changes explicit.
// Sources: docs/design.md (LGPD, moderation, identity), docs/app.md and
// SECURITY.md. Planned flows must not read as features already available.

export const LEGAL_VERSION = 9
export const LEGAL_DATE = '31/10/2026'
export const REVIEW_NOTE = 'Versão 9, sujeita a revisão jurídica. Não é parecer jurídico.'

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
        'Na versão web, sua conta vem de uma passkey. Perder a passkey é perder a conta. Outra passkey cria outra conta. A passkey fica no gerenciador de senhas do seu aparelho. Não há arquivo de recuperação nem exportação da chave.',
        'Na web hospedada, o vínculo com a conta Google dá o certificado de membro e o @nome.',
        'O Varanda é para pessoas com 16 anos ou mais. Esse limite é uma regra adotada pelo Varanda com base no ECA Digital. Na web hospedada, antes de a conta ser liberada, a idade é confirmada por um serviço parceiro de verificação, a Didit. Isso vale para todos os membros da web hospedada, inclusive quem entrou antes, e o app fica bloqueado até a verificação dar certo.',
        'A verificação costuma estimar a idade por uma selfie e pode pedir um documento. O serviço de conta guarda só a faixa de idade (16 a 17 anos ou 18 anos ou mais), nunca a foto, o documento ou a data de nascimento. Se o resultado não for conclusivo, você pode tentar de novo com um documento.',
        'No app nativo, com certificado dado pela associação, essa verificação ainda não é feita nesta versão.',
        'O guardião e a recuperação por e-mail são planejados.'
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
        'Se a sua conta foi bloqueada, você pode pedir uma revisão, o recurso, na versão web hospedada, com a conta Google vinculada. Outra pessoa da moderação, que não decidiu o bloqueio, lê o pedido e pode aceitar ou negar. Aceitar pede o desbloqueio, que só vale quando o operador aplica e assina a lista. Negado o recurso, só dá para recorrer de novo depois de 30 dias.',
        'Na web instalada, sem rede, vale a lista que está guardada no aparelho. Uma lista mais nova chega pelo semeador. A lista contém chaves públicas, sequência e datas, sem motivo, nome, e-mail ou conta Google. Ordens judiciais de bloqueio são cumpridas pela mesma lista.'
      ]
    },
    {
      heading: 'Conta de pagamentos (opcional)',
      paragraphs: [
        'A conta de pagamentos é opcional e existe só na web hospedada. O Varanda funciona por inteiro sem ela. Para abri-la, você passa por uma verificação de identidade feita pela Hodle, uma empresa de software. Parceiros regulados movimentam o dinheiro. O BRLA é um real digital emitido pela Avenia. A associação que publica o Varanda não é banco nem instituição de pagamento. A conta de pagamentos é só para pessoas com 18 anos ou mais; a rede social continua a partir dos 16. Para abrir a conta, você declara ter 18 anos ou mais antes de qualquer coisa ser criada no parceiro, e a data de nascimento enviada na verificação precisa confirmar isso (a idade é contada pelo calendário de Brasília).',
        'A carteira só é liberada quando o parceiro confirma que o PIN é escolhido pela pessoa e só ela o conhece. Você escolhe um PIN de 6 dígitos que o Varanda não guarda e não consegue recuperar, e três erros bloqueiam a carteira por 24 horas no parceiro. A subconta aberta na Hodle não pode ser apagada no parceiro. O saldo não tem remuneração.',
        'Quando o operador liga o Pix, você pode ver o saldo, receber por Pix, sem PIN, e pagar por Pix, que você sempre confirma com o PIN, como qualquer envio de dinheiro. O Pix pode ser feito para o CPF de outra pessoa, e quem faz isso responde por conferir a chave e o valor. Quando o Pix é para outra pessoa ou vem de outra pessoa, o CPF dela vai para a Hodle só para essa operação, e o Varanda não o guarda. A Hodle cobra a taxa dela, que aparece na cotação como foi calculada, somada ao valor. O Varanda pode cobrar uma taxa própria, desligada até o operador definir. Antes de você confirmar, o app mostra em reais o valor, a taxa do parceiro, a taxa do Varanda e o total, e a taxa do Varanda consta no extrato. Nesta versão não há taxa do Varanda para receber.',
        'A taxa do Varanda sobre um Pix enviado só é cobrada depois que a Hodle informa que esse Pix foi concluído. Como isso costuma levar de 30 a 90 segundos, ela normalmente é cobrada no seu próximo envio confirmado com o PIN, no máximo uma taxa antiga por envio. Se o Pix falhar ou voltar antes de ser concluído, a taxa dele nunca é cobrada. Nada é cobrado sozinho. Para enviar, o saldo precisa cobrir o valor, a taxa da Hodle, a nova taxa do Varanda e todas as taxas pendentes; esse dinheiro fica na sua carteira até um envio posterior cobrá-lo. Um Pix já concluído e depois devolvido pelo banco de quem recebeu não devolve automaticamente uma taxa do Varanda já cobrada.'
      ]
    },
    {
      heading: 'Fotos e recursos planejados',
      paragraphs: [
        'A mídia aceita nesta etapa é só imagem, pela web hospedada: fotos e GIFs nas publicações e a foto do perfil. A foto do perfil é sempre uma imagem parada e quadrada; um GIF escolhido para ela vira imagem parada. Vídeos não são aceitos. A comparação com listas de hashes de mídia ilegal é planejada e ainda não existe. Hoje, denúncias e bloqueio da conta são os meios de moderação dessas imagens. Uma foto de perfil imprópria se denuncia pela conta toda, e essa denúncia sempre é decidida por uma pessoa.',
        'Na versão web hospedada, você pode ligar em Ajustes os avisos no aparelho (notificações push) de novo seguidor, resposta, curtida e republicação. São opcionais e vêm desligados por padrão. Cada aviso leva o nome de quem agiu e a ação, nunca o texto da publicação. Aceitar estes documentos não liga os avisos: isso depende de uma escolha separada. Mensagens diretas continuam planejadas.'
      ]
    },
    {
      heading: 'Limites da exclusão',
      paragraphs: [
        'Você pode apagar uma publicação (resposta e citação incluídas) e uma versão do perfil. Os semeadores e apps oficiais e atualizados deixam de mostrar o item e descartam os bytes dele nas suas cópias, inclusive as imagens que só ele usava. Isso não é um apagamento garantido em qualquer lugar: um aparelho que acabou de seguir você pode guardar o conteúdo por pouco tempo, até receber a exclusão. Apps e semeadores antigos ou modificados não obedecem, e cópias que já chegaram a outros aparelhos, fotos já baixadas, capturas de tela, imagens guardadas em cache e as citações guardadas pelo serviço de conta numa denúncia podem manter o conteúdo. Um diário que já atingiu o limite de blocos não aceita mais nem o registro de exclusão. O app ainda não permite excluir a conta por conta própria, e o pedido de exclusão assinado descrito no desenho é planejado. Limpar os dados do site só apaga os dados locais; não apaga as cópias que já chegaram a outros aparelhos ou semeadores.',
        'Hoje, excluir uma conta é bloquear sua chave pública na lista de moderação. Depois disso, os semeadores e apps atualizados apagam e recusam o diário. Mesmo assim, não é possível garantir a exclusão de cópias em apps modificados ou aparelhos que não obedecem à lista. Bloquear a conta não apaga o diário do aparelho do autor.'
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
        'Publicações, perfil, lista de quem você segue e fotos ficam no seu aparelho, nos aparelhos de quem segue você e nos semeadores no Brasil. A lista de quem você segue e as fotos são públicas para quem tem o diário. A foto do perfil é pública, como o nome e a bio. Antes do envio, o app recorta a foto em quadrado, reduz para 512 por 512 pixels e grava de novo, o que remove dados como a localização (GPS) e o modelo da câmera.',
        'Na Espiadinha, os diários espiados ficam só na memória do navegador. Recarregar descarta essas cópias. No nó, a cópia guardada vale por até 5 minutos. As fotos de perfil de quem você não segue também ficam só na memória do navegador, sem cópia guardada.',
        'Seu nome e seu @nome podem aparecer na busca do semeador. O índice guarda só tokens dobrados, ou seja, partes dos nomes normalizadas para a busca, em memória. O índice some ao reiniciar o semeador. Ainda não há opção de sair dessa busca.'
      ]
    },
    {
      heading: 'Vínculo com o Google',
      paragraphs: [
        'O serviço de conta, no Brasil, guarda o identificador interno da conta Google (chamado de sub), o e-mail, a chave pública do membro, o @nome atual e os @nomes já usados, as datas e o certificado. Os nomes passados ficam associados ao membro para nunca serem dados a outra pessoa.',
        'Esses dados servem para dar o certificado e o @nome, atender ordens judiciais e bloquear contas. O e-mail nunca entra no diário, no certificado nem no navegador.',
        'O Varanda é para pessoas com 16 anos ou mais, um limite adotado pelo Varanda com base no ECA Digital. Na web hospedada, antes de a conta ser liberada, a idade é confirmada por um serviço parceiro de verificação, a Didit. Isso vale para todos os membros da web hospedada, inclusive quem entrou antes, e o app fica bloqueado até a verificação dar certo. No app nativo, com certificado dado pela associação, essa verificação ainda não é feita nesta versão.',
        'A verificação costuma estimar a idade por uma selfie e pode pedir um documento. A selfie e o documento são tratados pelo parceiro e nunca chegam ao Varanda. O serviço de conta guarda só a faixa de idade (16 a 17 anos ou 18 anos ou mais), a forma de verificação e a data, nunca a foto, o documento ou a data de nascimento. Se o resultado não for conclusivo, você pode tentar de novo com um documento.',
        'O Varanda pede ao parceiro que apague a sessão de verificação logo depois da decisão, e as configurações de retenção do parceiro ficam no mínimo. A imagem do rosto é um dado sensível; a base legal para esse tratamento ainda será confirmada por parecer jurídico. O vínculo com o Google e o certificado atual não afirmam a idade. O guardião e o e-mail de recuperação são planejados.'
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
        'Quando uma conta bloqueada recorre, o serviço de conta guarda o recurso: a chave pública da conta, o texto opcional que a pessoa escreveu, a assinatura, a data, o estado do recurso, a decisão com a data e a observação de quem julgou. O e-mail do moderador que julgou fica no registro de decisões. O texto é o que a pessoa enviou, e a moderação não o confere. Só moderadores que não decidiram o bloqueio daquela conta leem o recurso, e a própria pessoa nunca o vê no painel. O recurso não vai para o diário nem para a lista de bloqueio.',
        'O e-mail do vínculo Google de quem denuncia e de quem é denunciado não aparece no painel nem no registro de decisões. A operação do servidor pode obtê-lo para atender um pedido legal. A pessoa denunciada não tem acesso à denúncia por tela ou rota do serviço.'
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
        'Para publicações, perfil, seguidos, fotos e o vínculo Google que dá o certificado e o @nome, a proposta é execução de contrato, Art. 7º, V.',
        'Registro do aceite: a finalidade é registrar qual versão cada conta aceitou. A base legal é uma proposta, ainda sem parecer jurídico.',
        'Faixa de idade: a finalidade é cumprir a regra de idade mínima. A base legal proposta é obrigação legal (ECA Digital), a confirmar em parecer jurídico.',
        'Denúncias, recursos, decisões e dados de triagem servem à moderação e ao atendimento de pedidos legais. A base legal para esse tratamento ainda precisa de parecer jurídico.',
        'Conta de pagamentos: os identificadores da conta e da carteira e o estado da verificação servem para operar a conta. A proposta é execução de contrato, a confirmar. A foto do documento e a selfie com prova de vida são dados biométricos sensíveis, tratados pelo parceiro. A base do Art. 11 ainda aguarda parecer jurídico, como a selfie da Didit. As operações e taxas (tipo, estado, valor, taxas, identificador do parceiro, destino mascarado e marca de contestação) ficam no serviço de conta, sem a chave Pix inteira nem o CPF, e as finalizadas são apagadas depois de 90 dias, exceto enquanto uma taxa da Varanda ainda puder ser cobrada, uma contestação estiver aberta ou uma revisão de suporte estiver aberta. Um Pix de entrada que falhou e ainda está sendo devolvido não conta como finalizado. O registro guarda no máximo 20000 operações: acima disso, as finalizadas mais antigas são apagadas antes dos 90 dias, com as mesmas exceções. Quando o Pix é para outra pessoa ou vem de outra pessoa, o CPF dela vai para a Hodle só para essa operação, e o Varanda não o guarda.',
        'Registros de acesso, com IP, data e hora, ficam nos semeadores e serviços, se aplicável. A proposta é obrigação legal caso o Art. 15 do Marco Civil se aplique.'
      ]
    },
    {
      heading: 'Por quanto tempo',
      paragraphs: [
        'A retenção está em aberto (issue #38). Isso inclui os dados do vínculo Google, as denúncias, os recursos, as decisões e os precedentes de triagem. Denúncias, recursos e decisões não são apagados automaticamente. Não há um prazo de retenção definido aqui para os registros de aceite. Os identificadores da conta de pagamentos ficam enquanto a conta existir (issue #38); a subconta no parceiro é permanente.',
        'O desenho propõe guardar publicações, perfil, seguidos e fotos até a pessoa apagar. Apagar publicações e versões do perfil já está disponível: as cópias oficiais atualizadas deixam de mostrá-las e descartam os bytes, mas cópias antigas, apps modificados, caches de imagem e as citações guardadas pelo serviço de conta podem guardar o conteúdo. A retenção das cópias também depende dos limites da rede P2P. Tirar a foto do perfil só deixa de mostrá-la; a foto já enviada continua gravada na rede.',
        'As cópias da Espiadinha e o índice de nomes têm os limites de memória descritos acima. Esses limites não apagam as réplicas normais dos diários no semeador. Para registros de acesso, o prazo proposto é de 6 meses, se aplicável.'
      ]
    },
    {
      heading: 'Compartilhamento e cópias fora do Brasil',
      paragraphs: [
        'A rede compartilha cópias dos diários com os aparelhos de quem segue você e com semeadores no Brasil. A Espiadinha permite a leitura de outros diários só em memória. O Google é usado no vínculo de entrada com a conta Google e no login dos moderadores no painel de moderação. A Didit é o serviço parceiro que faz a verificação de idade na web hospedada. A Hodle e os parceiros dela são outro caminho, separado da Didit: só entram se você abrir a conta de pagamentos. Nesse caso, nome completo, CPF, data de nascimento, e-mail, endereço, a imagem do documento e a selfie vão para a Hodle. As fotos saem do navegador direto para a Hodle. Os dados em texto (nome, CPF, data de nascimento, e-mail e endereço) passam pelo serviço de conta do Varanda nesse pedido, que os repassa à Hodle e não os guarda nem os registra. O Varanda guarda apenas, em wallet.json, os identificadores da conta e da carteira, o estado da verificação, os identificadores que o parceiro dá à tentativa de verificação, ao documento e à selfie enviados (são identificadores, não as imagens), o endereço público da carteira na rede (0x...) depois que ela existir e uma chave embrulhada que, quando a carteira for liberada, não a abre sem o PIN. Nunca guarda o PIN, o CPF, as fotos nem o endereço residencial.',
        'Cópias podem sair do Brasil quando ficam nos celulares de membros que estejam no exterior. Esse é um limite do armazenamento distribuído em P2P. O serviço de push do navegador (Google, Mozilla, Apple ou Microsoft), que pode estar fora do Brasil, recebe apenas o endereço do aparelho e um texto cifrado que só esse aparelho pode ler. O serviço de conta da associação, no Brasil, guarda a inscrição (endereço e chaves, em push.json) até você desligar os avisos ou o serviço de push informar que a inscrição deixou de existir. O tratamento da verificação de idade pela Didit também pode acontecer fora do Brasil. A Hodle e os parceiros dela também podem tratar os dados e as fotos da verificação de identidade fora do Brasil. O mecanismo para essa transferência internacional, conforme a Resolução CD/ANPD nº 19/2024, ainda será confirmado por parecer jurídico.',
        'A associação pode atender pedidos legais com os dados que seus serviços guardam. Ela não tem como entregar conteúdo que só existe nos aparelhos dos membros. Mensagens diretas são planejadas e não fazem parte dos fluxos atuais descritos aqui.'
      ]
    },
    {
      heading: 'Seus direitos e os limites do P2P',
      paragraphs: [
        'O Art. 18 trata de direitos sobre seus dados, como acesso, portabilidade, correção e eliminação. Seu diário já fica no seu aparelho. A exclusão e a portabilidade dos dados do vínculo Google dependem do serviço de conta, não só do diário.',
        'Você pode mudar o nome, a bio e a foto do perfil, e tirar a foto quando quiser. Tirar a foto faz o app deixar de mostrá-la, mas a foto já enviada continua gravada na rede, como as fotos das publicações, e quem já tem uma cópia pode mantê-la. Para o @nome, vale o intervalo de 7 dias, e um nome usado nunca vai para outra pessoa. Você também pode apagar uma publicação ou uma versão do perfil: as cópias oficiais atualizadas deixam de mostrá-la e descartam os bytes, mas apps antigos ou modificados, caches de imagem e cópias já obtidas não obedecem. O fluxo de corrigir uma publicação e o pedido assinado para apagá-la são planejados.',
        'O bloqueio da chave faz os semeadores e apps atualizados que obedecem à lista apagarem e recusarem o diário. Não revoga o certificado individual e não apaga o diário do aparelho do autor. Não é possível garantir a eliminação de cópias em apps modificados ou aparelhos que ignoram a lista.',
        'Hoje não há um canal para pedidos sobre seus dados além do que o app já faz. Não existe exclusão de conta por conta própria: a conta é excluída bloqueando a chave pública na lista de moderação, e cópias em apps modificados não podem ser garantidas. O canal privado para exercer seus direitos será publicado com o encarregado. Nunca envie dados pessoais por uma issue pública.'
      ]
    },
    {
      heading: 'Segurança e sessão no navegador',
      paragraphs: [
        'Na web, a chave da conta vem da passkey. Perder a passkey é perder a conta. Outra passkey corresponde a outra conta.',
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
