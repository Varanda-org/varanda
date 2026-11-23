# Avisos de grupos sem comunidade no semeador (branch feat/standalone-group-notices)

O semeador deixava de fora dos avisos de nova mensagem todo grupo cuja raiz não nomeia comunidade. Agora ele monta a dica de membros desses grupos com `community: null` (`createGroupHint`, `packages/core/lib/group-notice.js`), lendo só os núcleos do próprio grupo. Sem mudança de Termos nem de formato de mensagem.

## O que muda

- `packages/core/lib/seeder.js`: `_queueGroupNotices` e `_scanGroupNotices` pegam a configuração da comunidade em `_noticeCommunity`. Um grupo que nomeia comunidade segue como antes, inclusive esperando o cabeçalho da comunidade. Um grupo sem comunidade só ganha dica depois que o bloco 0 da própria raiz, lido do núcleo local (`_checkStandalone`), passa em `isStandaloneHeader`; o resumo do cabeçalho guardado no índice não basta, e um grupo cuja comunidade falta nunca conta como sem comunidade. O resultado fica na entrada da raiz (`standalone`), porque o bloco 0 não muda. Uma leitura que falha ou um bloco 0 que não está no núcleo local deixam a resposta em aberto, e a próxima passagem natural lê de novo (nunca num laço); só um bloco lido que não é cabeçalho sem comunidade fecha a resposta como não. `_groupNoticeCores` e a varredura usam só o grupo como escopo quando não há comunidade. Um comentário em `_groupNoticeCores` registra que a falta de linha no índice (`!row`) também protege a criação: a dica confia em `header.diary` como criador, e a raiz só ganha linha quando a entrada da própria pessoa criadora a liga, então uma raiz sem essa ligação fica em silêncio. O tratamento de erro da fila e o comentário de `onGroupNotice` também passam a considerar o grupo sem comunidade. Cursores, pisos de aviso, baldes de fichas e reconstrução não mudam.
- `docs/protocol.md`, "Group message notices": item novo "Standalone group", com a releitura depois de uma falha e a regra de que a pessoa criadora só conta numa raiz ligada pela própria entrada. Em "Standalone groups", o item "Notices." deixa de dizer que não há aviso e aponta para esse item.

## Comandos e resultados

Da raiz, um arquivo por vez (`node <arquivo>`), em 23/11/2026:

- `apps/cli/test/seeder-notices-standalone.test.js` (novo): 7/7 testes, 58/58 asserções, cerca de 2 s. Grupo público com aprovação e grupo privado, os dois sem comunidade, num semeador e numa DHT locais (127.0.0.1). Confere que a dica lê só os núcleos do grupo; que o histórico admitido não avisa; que o post de um membro avisa só o outro membro, com o nome do grupo público; que posts de quem espera aprovação e de quem foi banido não avisam ninguém, e que nem eles nem quem está fora recebe aviso; que uma reconstrução da dica não repete aviso e que o post seguinte avisa uma vez; e que o envelope selado do grupo privado avisa sem nome. O segundo teste faz a primeira leitura local do bloco 0 da raiz falhar uma vez e confere que uma passagem seguinte lê de novo, monta a dica e o aviso chega. O terceiro, também em rede local, tem uma raiz que nomeia A como criadora sem que A a ligue; B e D entram com escritores, postam, e ninguém recebe aviso, A em nenhuma lista. Quatro testes em memória (semeador com núcleos montados à mão, no estilo de `seeder-groups.test.js`) conferem: um grupo cuja comunidade falta não ganha estado de aviso nem lê o bloco 0; um índice sem comunidade sobre um bloco 0 que é cabeçalho de grupo de comunidade, ou que nem decodifica, fecha a resposta como não depois de uma leitura e não lê de novo; um bloco 0 ausente no núcleo local fica em aberto e é lido de novo na passagem seguinte, e o aviso chega; e um membro que sai deixa de receber, enquanto a saída da pessoa criadora silencia o grupo.
- `packages/core/test/seeder-standalone.test.js`: 2/2, 70/70, em três rodadas seguidas, cada uma sozinha (de 2 a 4 s). Numa rodada feita ao mesmo tempo que `seeder-notices.test.js`, o segundo teste falhou em 3 asserções ("writer kept" duas vezes e "a group without a header record is never complete"); esse teste não liga `onGroupNotice`, então o código de avisos não roda nele, e sozinho ele passou todas as vezes. O primeiro teste passa a esperar o novo comportamento: S e V ganham estado de aviso, o histórico admitido não avisa, o post "novidade" de B no grupo aberto S avisa só A, uma vez, com o nome "Roda livre", e depois do reinício o histórico guardado não avisa e nada novo chega. As outras asserções e o segundo teste não mudam.
- `packages/core/test/group-notice.test.js`: 63/63, 946/946. Um bloco da raiz entregue sob outro diário, em qualquer posição, deixa a dica incompleta (mutação: sem isso, 3 asserções falham).
- `packages/core/test/seeder-groups.test.js` (avisos de grupos de comunidade): 70/70, 575/575.
- `apps/cli/test/seeder-notices.test.js`: 7/7, 89/89.
- `npx standard packages/core/lib/seeder.js apps/cli/test/seeder-notices-standalone.test.js packages/core/test/seeder-standalone.test.js`: sem apontamentos.

## Falha sem a correção

Com o pulo antigo de volta em `_queueGroupNotices` (`if (C === null) continue`), o teste novo para em "tempo esgotado: dica de S completa", porque nenhum grupo sem comunidade ganha dica. Com `false` de volta no lugar de `null` para uma leitura rejeitada em `_checkStandalone`, o segundo teste para em "tempo esgotado: bloco 0 lido de novo". Outras mutações, uma por vez, cada uma desfeita em seguida:

- Sem a guarda `!row` (com a conferência seguinte da linha protegida contra linha ausente): o teste da raiz não ligada falha em "no notice at all" e "A is in no recipients list".
- Um bloco 0 ausente (`raw === null`) gravado como `false`: o teste do bloco ausente falha em "still unknown", "a later pass read block 0 again" e "the hint is set up".
- Uma comunidade sem cabeçalho no índice tratada como possível grupo sem comunidade: o teste da comunidade ausente falha em "never judged standalone" e "block 0 is never read".
- Um bloco 0 recusado deixado em aberto (`isStandaloneHeader(header) || null`): o teste do bloco recusado falha nos dois casos, em "settled as not standalone" e "never read again".

Com as correções de volta, todos passam.

## O que não foi conferido

- Nenhuma conferência em aparelho: a mudança é só do semeador.
