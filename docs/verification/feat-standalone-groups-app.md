# Grupos sem comunidade no app

Branch `feat/standalone-groups-app`. O app cria um grupo sem comunidade, lista os grupos sem comunidade em Conversas, no ponto de não lidas e no encaminhamento, e a Vitrine responde `group.standalone`.

## Testes automáticos

De `apps/app`, com `node ../../scripts/run-tests.js <arquivos>`:

- Vitrine (T15): 4 arquivos, 69 testes, 4938 asserções.
- Módulos puros (T16), 8 arquivos; entre eles `groups.test.js` 43 testes / 624 asserções, `group-flow.test.js` 95 / 791, `screenSnapshot.test.js` 18 / 164, `forward.test.js` 23 / 220, `conversasDotWiring.test.js` 22 / 73. O mock de `forwardSheet.test.js` responde `group.standalone`.
- Criação e Conversas (T19): `newGroup.test.js` 16 / 74, `conversas.test.js` 45 / 294, `conversasList.test.js` 25 / 143, `groupImageCreate.test.js` 6 / 103. Os quatro passam juntos.
- `npx standard` nos arquivos alterados passa.

O leitor de `group.standalone` (`readStandalone`) agora existe uma vez só, em `apps/app/src/groups.js`, usado por `newGroup.js`, `groupsUnreadRead.js` e `forward.js`. Depois da junção: `groups.test.js` 43 / 624, `conversasDotWiring.test.js` 22 / 73, `conversasDot.test.js` 6 / 45, `forward.test.js` 23 / 221, `forwardSheet.test.js` 22 / 139, e os quatro acima sem mudança.

Conferências de mutação (cada uma desfeita depois):

- `readStandalone` em `groups.js` tratando USAGE 'método desconhecido' como leitura parcial: falha um teste em `newGroup.test.js`, um em `conversasDotWiring.test.js` e um em `forward.test.js`.
- `reconcile` sem a regra da linha nova de quem criou com nome diferente (nome null de um grupo privado): o teste da criação incerta falha.
- `Conversas.js` sem `failed = true` numa leitura incompleta de `group.standalone`: o teste de Conversas falha.
- `withStandaloneRows` sem a deduplicação por chave: 1 teste falha.
- `standaloneCreateView` ignorando uma leitura anterior incompleta: 1 teste falha.

Tela do grupo e entrada (T20): `groupScreen.test.js` 40 testes, `group-flow.test.js` 95, `chatSurfaces.test.js` 13, `comunidadesRow.test.js` 39, `platformGate.test.js` 6, todos juntos.

- O cartão de quem está fora segue `joinOffer`. Num grupo de comunidade, com a raiz guardada ou não, só quem é membro da comunidade vê **Entrar no grupo**; saiu, pediu ou foi banido vê só **Entrar na comunidade**; papel desconhecido não vê nenhum dos dois. Um papel lido para outra comunidade conta como desconhecido, e uma dica do índice não vence o cabeçalho de uma raiz guardada.
- Um grupo sem comunidade, guardado ou indicado pelo índice, mostra **Entrar no grupo** e nunca **Entrar na comunidade**.
- O pedido de entrada: raiz guardada `{ group }`; raiz não guardada indicada como sem comunidade `{ group, standalone: true }`; raiz não guardada de comunidade `{ group, community }`. Nada é enviado sem a oferta de grupo.
- Painel da Página: a entrada no grupo aparece só quando a Página é membro da comunidade do grupo (lido do estado do serviço); senão aparece **Entrar na comunidade**. Num grupo sem comunidade a Página não vê nenhuma oferta.
- **Comunidade**: a linha de um grupo do catálogo mostra **Entrar** só para membros da comunidade.

Conferências de mutação de T20 (cada uma desfeita depois): mostrar **Entrar no grupo** enquanto o papel é desconhecido (21 asserções falham), contar papel desconhecido como membro (17), ignorar o grupo sem comunidade (21), dica do índice vencendo a raiz guardada (3), Página com oferta num grupo sem comunidade (5), Página sem a conferência da comunidade (13), raiz guardada enviando `community` (2), **Entrar** na Comunidade para quem não é membro (3).
- `apps/app/test/gruposSnapshot.test.js`: a foto guardada de **Conversas** inclui os grupos sem comunidade, e uma lista sem comunidade incompleta mantém as linhas guardadas sem comunidade até uma leitura completa (tirar `missed.add(null)` faz o teste falhar).

## Nó do navegador: dica conferida no bloco 0

- `group.join` num grupo cuja raiz o nó do navegador ainda não tem, com `standalone: true` ou `community`: antes de qualquer escrita, o nó lê o bloco 0 da raiz no semeador (link curto próprio, chave efêmera, semeador verificado, um prazo), e o Hypercore confere a assinatura contra G. Conferido em `packages/web-member/test/group-standalone-ops.test.js` (casos "block 0 check", 25 testes, 163 asserções) e em `packages/web-member/test/root-peek.test.js` com um Seeder real em loopback (1 teste, 12 asserções).
- A dica que o cabeçalho contradiz é recusada sem escrever nada (nenhum escritor pendente, nenhum `group-join` no diário, nenhuma vaga gasta): `standalone: true` numa raiz de comunidade dá 'parâmetro inválido: standalone'; `community` numa raiz sem comunidade dá 'parâmetro inválido: community'; `community` de outra comunidade dá 'o grupo não é dessa comunidade'; um bloco 0 que não é raiz de grupo dá 'grupo não encontrado'.
- Sem resposta do semeador (raiz que nenhum semeador guarda, prazo esgotado, sem semeador, núcleo bifurcado), a recusa é 'aguarde a sincronização do grupo para entrar', sem `uncertain` e sem escrita.
- Uma dica confirmada pelo cabeçalho segue o caminho pendente de antes; repetir o `group.join` com o escritor já gravado responde sem nova leitura. O nó do core continua confiando na dica (o app só consulta o índice num nó hospedado).
- Mutações conferidas: tirar a checagem de `standalone`, tirar a de `community` ou tratar leitura falha como aprovada faz um teste falhar em cada caso.
- Os testes existentes que fazem uma entrada pendente com dica (`device-upkeep-ops`, `group-ops`, `group-seen`, `private-ops`, `session-private-gate`, `session-upkeep`, `standalone-e2e`, `sync-groups-3`) ganharam só um leitor da raiz (`test/helpers/root-reader.js`); nenhuma asserção mudou. `standalone-e2e` lê pelo semeador real.

## Tela do grupo: correções da revisão

- Uma Página num nó do core que abre um grupo cuja raiz o nó não guarda recebe a oferta de entrar e manda `group-join { group }`: o serviço decide. Uma Página que o estado do serviço põe fora da comunidade, ou qualquer grupo sem comunidade, nunca recebe a oferta (`apps/app/test/groupScreen.test.js`, 48 testes).
- Uma leitura falha do estado da Página ou do papel mostra **Tentar de novo**, e puxar para atualizar também serve para a Página. A recusa 'entre na comunidade primeiro' se desfaz só quando a tela volta ao topo ou quando uma leitura passa a dizer membro: uma mensagem nova no grupo não traz de volta **Entrar no grupo**, e o cartão continua com **Entrar na comunidade** (renderizações seguidas com refs persistentes; a condição antiga é detectada por mutação).
- Uma dica que a raiz contradiz mostra "Os dados deste grupo mudaram. Puxe para atualizar antes de tentar de novo.", e o pedido nunca é reenviado. A resposta do índice é descartada, e só puxar para atualizar consulta o índice de novo.
- A recusa 'aguarde a sincronização do grupo para entrar' do nó do navegador vira "Não deu para ler este grupo agora. Tente de novo em instantes.", enviada uma vez; as outras mensagens 'aguarde a sincronização' passam sem mudança.
- Os efeitos da tela (consulta ao índice com a dica de grupo sem comunidade, papel guardado, estado da Página) rodam de verdade nos testes; cada correção tem uma mutação que faz o teste falhar.

## Conferências manuais pendentes

Primeiro no build de debug do Android e no simulador iOS, depois na web, no PWA e na Vitrine:

- R1: uma pessoa sem nenhuma comunidade toca **+** > **Novo grupo** > **Grupo sem comunidade**, cria um grupo público e um privado; cada um abre direto e aparece em **Conversas** (filtros **Todas** e **Grupos**).
- R2: o ⓘ ao lado de **Grupo sem comunidade** abre a folha "Qualquer pessoa pode criar.".
- R4: agindo como uma Página, **Novo grupo** abre **Comunidades**; o seletor e o formulário nunca aparecem.
- R5: uma criação incerta (cortar a rede durante o pedido) mostra **Conferir**; com a rede de volta, **Conferir** encontra o grupo e o abre, ou diz que não foi criado, sem reenviar sozinho.
- Nó antigo: com um nó ou serviço que responde `group.standalone` com 'método desconhecido', **Conversas** lista os grupos das comunidades sem aviso de lista incompleta.
- Entrada pela tela do grupo: abrir um link /g/ de um grupo de comunidade sem ser membro (raiz guardada e não guardada), de um grupo sem comunidade (guardado e não guardado) e agindo como Página; conferir que só a oferta certa aparece. Conferir a pílula **Tentar de novo** depois de uma leitura do papel que falha, e a nova leitura do estado da Página depois de entrar na comunidade e voltar à tela.
- Página no app nativo (nó do core): abrir um link /g/ de um grupo de comunidade cuja raiz o aparelho não guarda; **Entrar no grupo** aparece e o serviço decide.
- Segundo aparelho de um membro: a entrada no grupo recusada com 'entre na comunidade primeiro'; entrar na comunidade nesse aparelho e voltar; **Entrar no grupo** volta a aparecer.
- Web: com o semeador fora do ar, **Entrar no grupo** num grupo sem comunidade ainda não guardado mostra a mensagem de sincronização e não grava nada no diário.
- Fora da comunidade: depois de uma entrada recusada, receber uma mensagem nova no grupo; o cartão continua com **Entrar na comunidade**. Provocar uma recusa de dica e puxar para atualizar: o índice é lido de novo e nada é reenviado.
