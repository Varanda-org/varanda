// Bundled copy: Metro cannot import core. Keep the version in step with
// @varanda/core lib/terms.js; the test digest makes text changes explicit.
// Sources: docs/design.md (LGPD, moderation, identity), docs/app.md and
// SECURITY.md. Planned flows must not read as features already available.

export const LEGAL_VERSION = 1
export const LEGAL_DATE = '27/10/2026'
export const REVIEW_NOTE = 'Versão 1, sujeita a revisão jurídica. Não é parecer jurídico.'

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
        'Na web hospedada, o vínculo com a conta Google dá o certificado de membro e o @nome. Esse vínculo não verifica sua idade. A idade não é verificada nesta versão.',
        'A verificação de idade que o ECA Digital exige ainda não existe nesta versão. A regra para menores de idade ainda está sendo definida, com revisão jurídica.',
        'O guardião e a recuperação por e-mail são planejados. O serviço de verificação de idade e o uso de imagem do rosto para essa verificação também são planejados.'
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
        'A mídia aceita nesta etapa é só imagem: fotos e GIFs, pela web hospedada. Vídeos não são aceitos. A comparação com listas de hashes de mídia ilegal é planejada e ainda não existe. Hoje, denúncias e bloqueio da conta são os meios de moderação dessas imagens.',
        'Mensagens diretas e notificações push são planejadas. Os avisos atuais aparecem dentro do app aberto, sem push.'
      ]
    },
    {
      heading: 'Limites da exclusão',
      paragraphs: [
        'Nesta etapa, o app ainda não permite apagar uma publicação nem excluir a conta por conta própria. O pedido de exclusão assinado descrito no desenho é planejado. Limpar os dados do site só apaga os dados locais; não apaga as cópias que já chegaram a outros aparelhos ou semeadores.',
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
        'Publicações, perfil, lista de quem você segue e fotos ficam no seu aparelho, nos aparelhos de quem segue você e nos semeadores no Brasil. A lista de quem você segue e as fotos são públicas para quem tem o diário.',
        'Na Espiadinha, os diários espiados ficam só na memória do navegador. Recarregar descarta essas cópias. No nó, a cópia guardada vale por até 5 minutos.',
        'Seu nome e seu @nome podem aparecer na busca do semeador. O índice guarda só tokens dobrados, ou seja, partes dos nomes normalizadas para a busca, em memória. O índice some ao reiniciar o semeador. Ainda não há opção de sair dessa busca.'
      ]
    },
    {
      heading: 'Vínculo com o Google',
      paragraphs: [
        'O serviço de conta, no Brasil, guarda o identificador interno da conta Google (chamado de sub), o e-mail, a chave pública do membro, o @nome atual e os @nomes já usados, as datas e o certificado. Os nomes passados ficam associados ao membro para nunca serem dados a outra pessoa.',
        'Esses dados servem para dar o certificado e o @nome, atender ordens judiciais e bloquear contas. O e-mail nunca entra no diário, no certificado nem no navegador.',
        'A idade não é verificada. O vínculo com o Google e o certificado atual não afirmam a idade. A verificação de idade que o ECA Digital exige ainda não existe nesta versão, e a regra para menores de idade ainda está sendo definida, com revisão jurídica. O serviço de idade e o uso de imagem do rosto são planejados. O guardião e o e-mail de recuperação também são planejados.'
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
        'Denúncias, decisões e dados de triagem servem à moderação e ao atendimento de pedidos legais. A base legal para esse tratamento ainda precisa de parecer jurídico.',
        'Registros de acesso, com IP, data e hora, ficam nos semeadores e serviços, se aplicável. A proposta é obrigação legal caso o Art. 15 do Marco Civil se aplique.'
      ]
    },
    {
      heading: 'Por quanto tempo',
      paragraphs: [
        'A retenção está em aberto (issue #38). Isso inclui os dados do vínculo Google, as denúncias, as decisões e os precedentes de triagem. Denúncias e decisões não são apagadas automaticamente. Não há um prazo de retenção definido aqui para os registros de aceite.',
        'O desenho propõe guardar publicações, perfil, seguidos e fotos até a pessoa apagar. Porém, apagar publicações ainda não está disponível no app. A retenção das cópias também depende dos limites da rede P2P.',
        'As cópias da Espiadinha e o índice de nomes têm os limites de memória descritos acima. Esses limites não apagam as réplicas normais dos diários no semeador. Para registros de acesso, o prazo proposto é de 6 meses, se aplicável.'
      ]
    },
    {
      heading: 'Compartilhamento e cópias fora do Brasil',
      paragraphs: [
        'A rede compartilha cópias dos diários com os aparelhos de quem segue você e com semeadores no Brasil. A Espiadinha permite a leitura de outros diários só em memória. O Google é usado no vínculo de entrada com a conta Google e no login dos moderadores no painel de moderação.',
        'Cópias podem sair do Brasil quando ficam nos celulares de membros que estejam no exterior. Esse é um limite do armazenamento distribuído em P2P. Avisos por Apple e Google (push) são só planejados e hoje não existem. O mecanismo para essa transferência internacional, conforme a Resolução CD/ANPD nº 19/2024, ainda será confirmado por parecer jurídico.',
        'A associação pode atender pedidos legais com os dados que seus serviços guardam. Ela não tem como entregar conteúdo que só existe nos aparelhos dos membros. Mensagens diretas e push são planejados e não fazem parte dos fluxos atuais descritos aqui.'
      ]
    },
    {
      heading: 'Seus direitos e os limites do P2P',
      paragraphs: [
        'O Art. 18 trata de direitos sobre seus dados, como acesso, portabilidade, correção e eliminação. Seu diário já fica no seu aparelho. A exclusão e a portabilidade dos dados do vínculo Google dependem do serviço de conta, não só do diário.',
        'Você pode mudar o nome e a bio do perfil. Para o @nome, vale o intervalo de 7 dias, e um nome usado nunca vai para outra pessoa. O fluxo de corrigir uma publicação e o pedido assinado para apagá-la são planejados; apagar publicações ainda não está disponível no app.',
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
