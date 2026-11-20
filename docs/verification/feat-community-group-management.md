# Criação e ajustes de grupos

## Verificação automatizada

- `node apps/app/test/newGroup.test.js` passou com 8 testes. Cobre o filtro do seletor, as permissões de criação, o limite de 32 grupos e a troca de perfil em Conversas. Confere no código a condição de criação, o botão no cabeçalho, a contagem, a linha de motivo e a retirada do botão antigo.
- `node apps/app/test/groupEdit.test.js` passou com 9 testes. Cobre a permissão por aparelho, as opções de entrada dos grupos públicos, a ausência da escolha no Geral ou enquanto seu identificador é desconhecido e a passagem desse identificador aos ajustes. Confere também o toque na opção já selecionada, a preservação do rascunho de nome e a exibição do aviso de raiz uma única vez.
- `node apps/app/test/comunidadesRow.test.js` passou com 38 testes. Cobre os avisos de foto em Conversas e os botões para abrir a comunidade ou o grupo criado.
- `node apps/app/test/conversas.test.js` passou com 45 testes.
- `node apps/app/test/conversasList.test.js` passou com 25 testes.
- `node apps/app/test/chatSurfaces.test.js` passou com 13 testes.
- `node apps/app/test/group-flow.test.js` passou com 94 testes.
- `node apps/app/test/groupImage.test.js` passou com 6 testes.
- `node apps/app/test/communityRows.test.js` passou com 6 testes.
- `node apps/app/test/escapeLayer.test.js` passou com 6 testes.
- `node apps/app/test/vitrine.test.js` passou com 67 testes.
- `node apps/app/test/groups.test.js` passou com 38 testes.
- `node apps/cli/test/changelog.test.js` passou com 9 testes.

Standard passou nos arquivos alterados.

## Roteiro de verificação manual

### Criação pelo perfil pessoal em Conversas

1. Em **Conversas**, toque em **Nova conversa** e em **Novo grupo** usando o perfil pessoal. Confira que só aparecem comunidades que você criou e que já carregaram. Escolha uma comunidade disponível e confira que o seletor fecha e o formulário **Novo grupo** abre para ela. Crie um grupo e confira que ele abre.
2. No perfil sem comunidades próprias, confira que **Nova comunidade** abre o formulário de comunidade. Em caso de falha ao carregar a lista, confira que **Tentar de novo** refaz a leitura.
3. Em outro aparelho da pessoa criadora, confira que o seletor explica que só o aparelho original cria grupos. Numa comunidade sem autoridade na raiz ou com 32 vagas já ocupadas, confira a mensagem correspondente sob a comunidade. Remover um grupo não libera uma vaga.
4. Feche o seletor durante a leitura da lista ou a conferência de uma comunidade. Confira que uma resposta atrasada não abre o formulário. Troque para uma Página com o seletor aberto e repita com o formulário **Novo grupo** aberto. Confira que ambos ficam ocultos na Página. Em **Nova conversa** de uma Página, **Novo grupo** continua abrindo **Comunidades**.
5. Se a criação do grupo terminar com aviso de falha ou incerteza na foto, confira que **Conversas** mostra o aviso. Toque em **Abrir grupo** e confira que o aviso some e o grupo abre.

### Entrada em Ajustes do grupo

1. No aparelho em que você criou um grupo público que não seja o Geral, abra **Ajustes do grupo**. Em **Entrada**, troque de **Aberta** para **Com aprovação**, feche os ajustes e abra de novo para conferir a seleção. Repita no sentido inverso.
2. No mesmo aparelho, abra **Ajustes do grupo** do Geral e confira que **Entrada** não aparece durante o carregamento nem depois.
3. Num grupo privado, confira que a entrada continua com aprovação. Abra os ajustes também como administrador ou membro e confira que a opção de alterar a entrada é reservada a quem criou o grupo.
4. Em outro aparelho de quem criou o grupo, confira que o aviso "Nome, entrada e foto não podem ser mudados neste aparelho." ocupa o lugar dos controles de edição.

### Criação pelo cabeçalho Grupos

1. No aparelho em que você criou uma comunidade que só tem o Geral, confira **Grupos · 1 de 32** e **Novo grupo** no cabeçalho. Em uma tela estreita, confira a disposição do título e do botão e a área de toque de pelo menos 44 pt. Confira que a lista tem um só botão **Novo grupo**.
2. Crie o segundo e o terceiro grupo pelo botão. Confira que cada grupo abre ao ser criado e volte à lista depois de cada criação para conferir a contagem. Sem internet, confira que o botão fica desativado.
3. Abra a comunidade como administrador e, depois, em outro aparelho de quem a criou. Em cada caso, confira uma única explicação logo abaixo de **Grupos**, sobre a permissão de quem criou ou sobre o aparelho original.
4. Se a raiz perdeu autoridade, confira "Esta comunidade não recebe mais grupos novos.". Numa comunidade com 32 vagas ocupadas e autoridade para criar, confira **Grupos · 32 de 32** e "A comunidade chegou ao limite de 32 grupos.". A contagem inclui o Geral e os grupos tirados da lista.
5. Confira que o cabeçalho mostra apenas **Grupos** quando faltam dados para a contagem, ao abrir como membro, ao agir como Página e na tela da comunidade carregada pelo índice.

O roteiro manual ficou pendente no Android, iOS, web e PWA.
