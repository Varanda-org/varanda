# Varandinha fase 2, Enfeites e Barraquinha no nó do navegador (PR feat/varandinha-mimos-node)

Este PR liga ao nó do navegador os cinco métodos da fase 2 (`docs/rpc.md` 5.161 a 5.165): o contrato em `packages/rpc/lib/methods.js` e em `docs/rpc.md`, as recusas no nó do core (`packages/core/lib/session.js`), as leituras e escritas em `packages/web-member/lib/member-ops.js` e os handlers em `packages/web-member/lib/session.js`.

Nos handlers (`packages/web-member/lib/session.js`):

- `garden.decor`: como `garden.play` (sessão fechada, identidade, portão de escrita, bandeira dentro de `gardenDecor`), nunca repetido.
- `garden.stall`: leitura do próprio diário (`gardenStallOwn`), sem rede.
- `garden.give`: como `garden.help`. Na cadeia, a própria chave e uma chave bloqueada são recusadas, depois `gardenGiveCheck` com o limite generoso de regas recebidas que `garden.play` usa. Fora da cadeia, sob UM prazo, `/index/garden/<para>` e um `peekBefore` de `gardenTargetSeqs`, julgados por `gardenOpenVerdict`: página -> `'páginas não têm Varandinha'`, desligada -> `'esta pessoa não está na Varandinha'`, qualquer coisa não lida, ainda indexando ou malformada -> `'semeador indisponível'`, sem escrever. De volta à cadeia, as recusas outra vez, o portão de escrita e uma escrita. `gardenTarget` e `gardenEvidence` passaram a receber o julgamento como função: `garden.help` continua com o seu, e o comentário de risco residual diz o que um ponteiro velho custa numa doação.
- `garden.take`: como `testimonial.show`, sem chamada ao índice do semeador e sem as chaves das conversas (`serial` e `requireUnlocked`). Na cadeia, a própria chave (`'este mimo não está mais disponível'`), um doador bloqueado e a bandeira. Fora dela, um `diary.peek` do bloco do doador: um peek que falha responde `'semeador indisponível'` e não escreve nada; só um peek respondido sem o bloco (ausente ou apagado) vira `'este mimo não está mais disponível'`. De volta à cadeia, `gardenTake` confere e escreve; `changed: false` não escreve nada.
- `garden.drop`: só na cadeia, `gardenDrop`, sem a bandeira (veja "O contrato e os handlers").

## Testes direcionados

Rodado no Node 24.22.1, sobre 80e17e9d (feat/varandinha-mimos-node) com as mudanças deste PR ainda fora de commit:

- `npx standard packages/web-member/lib/session.js packages/web-member/test/garden-e2e.test.js`
  resultado: passou.
- `npm test -w packages/web-member -- test/garden-e2e.test.js`
  resultado: passou, 2/2 testes, 118/118 asserções. O primeiro teste (fase 1) não mudou.
- `node packages/web-member/test/garden.test.js`: 24/24 testes, 174/174 asserções.
- `node packages/web-member/test/garden-stall.test.js`: 30/30 testes, 191/191 asserções.

O teste novo de `garden-e2e.test.js` usa o semeador real atrás de `startSeedWs` e três nós do navegador na DHT local (127.0.0.1). O relógio é trocado antes de criar o semeador e os nós, para o próximo sábado de Brasília às 00:30 (03:30Z) a partir do relógio real, e anda 7 h para a frente uma vez só, para o manjericão ficar pronto (6 h). Ele não volta durante o teste: um prazo ou uma sondagem iniciados depois do passo esperariam horas se o relógio voltasse. O relógio real volta no último teardown, depois de 2,5 s, quando acabou a sondagem do roster de `packages/core/lib/deletion.js` (`ROSTER_PROBE_MS`, 2 s), que seria esperada até o prazo deslocado.

O que o teste cobre:

- `garden.stall` antes de tudo: aberto no sábado, sem enfeite, sem mimos. `garden.decor` sem a Varandinha ligada: `'ligue a Varandinha para jogar'`, nada escrito.
- A planta, segue B, C (que nunca entrou) e uma página P (roster no bloco 1, servida pelo semeador). Antes de ficar pronto: `'este vaso ainda não está pronto'`.
- Na cadeia, antes de ler o índice: a própria chave (`'não dá para dar um mimo para si'`), uma chave bloqueada (`'você bloqueou esta pessoa'`, antes de "não segue"), uma chave não seguida (`'você só dá mimos para quem você segue'`) e um vaso vazio.
- Fora da cadeia: P -> `'páginas não têm Varandinha'`; C -> `'esta pessoa não está na Varandinha'`; índice morto e índice ainda indexando -> `'semeador indisponível'`. Cada recusa não muda o tamanho do diário.
- Enfeites: dois `garden.decor`, o segundo vale (`garden.stall` e a rota `/mimos` de A apontam para ele).
- A doação: `{ seq, ref, state }`, com o estado logo antes do mimo, o vaso vazio e um salvamento gasto; `garden.state` mostra o vaso vazio; o registro `garden-gift` tem `to` e `item`; `garden.stall` de A lista o mimo. Uma segunda doação para B no mesmo dia: `'você já deu um mimo para esta pessoa hoje'`.
- `GET /index/garden/<B>/mimos` lista o mimo em `pending`, não em `shelf`.
- Aceite: a própria chave e um bloco que não é mimo -> `'este mimo não está mais disponível'`; doador bloqueado -> `'você bloqueou esta pessoa'`. B aceita com `index.mode = 'dead'` (toda leitura de `/index/garden/` falha) e a sincronização de B ligada: escreve. Um segundo aceite responde o primeiro com `changed: false` e não escreve. Com a rota de volta, o mimo está em `shelf` e não em `pending`; `garden.stall` de B lista o aceite.
- `garden.drop` de um aceite como `kind: 'gift'`: `'este registro não é um mimo seu'`. B larga o aceite: o mimo volta para `pending`. B aceita de novo: volta para `shelf`. A larga o mimo: some de `shelf` e de `pending`, e de `garden.stall` de A.
- Por último, B larga o aceite, o semeador para, e o teste espera o `diary.peek` de B falhar: `garden.take` responde `'semeador indisponível'` e o diário de B não muda de tamanho.

Conferido que o teste falha sem cada checagem (com `packages/web-member/lib/session.js` restaurado depois, `cmp` igual):

- Sem a leitura do alvo (`gardenTarget`) em `garden.give`: falharam "a page", "C never opted in", "index dead" e "index indexing", com o mimo escrito.
- Com o erro do peek de `garden.take` engolido (registro nulo, como em `testimonial.show`): falhou "seeder stopped" (117/118).
- Sem a recusa do doador bloqueado em `garden.take`: falharam "a blocked giver" e o aceite escrito (115/118).
- Sem a recusa da chave bloqueada em `garden.give`: falhou "blocked" (117/118).
- Sem a recusa da própria chave em `garden.take`, o teste passa: `takeAllowed` de member-ops recusa `self` com a mesma frase. A checagem na sessão só evita um peek.

`uncertain: true` em falha depois do envio e o "nunca reenviar" vêm do cliente (`packages/rpc/lib/client.js` com `mutating: true` nas specs de `packages/rpc/lib/methods.js`); os handlers novos não repetem nenhum pedido. A recusa "só na versão web" do nó do core é do arquivo `packages/core/lib/session.js`.

Ainda falta, para o orquestrador: `npm test -- --affected=origin/main`, `npm run lint` e `npm run demo` na ponta da pilha.

## O contrato e os handlers

`docs/rpc.md` (5.157 e 5.161 a 5.165) e os handlers de `packages/web-member/lib/session.js` e de `member-ops.js` dizem agora a mesma coisa. Os pontos que foram acertados no documento, que antes divergia:

- 5.163 e 5.164: o portão de escrita (seção 11) roda só na volta à cadeia, antes da escrita, como em `garden.help` (5.160), e não na primeira passagem. Com o semeador parado, `garden.take` responde `'semeador indisponível'` e não escreve nada.
- 5.163: a ordem é a própria chave, o bloqueio, a bandeira, `giveAllowed` (não segue, não é sábado, mesmo dia, limite do dia), `saveOrdinal`, `applyGive`; o resto que as regras recusam (relógio ou estado ilegível) é `'jogada inválida'`. O peek fora da cadeia lê os blocos 1, 2, a bandeira apontada e o estado apontado (`gardenTargetSeqs`); o estado é lido, mas só `gardenOpenVerdict` julga.
- 5.164: a ordem é a própria chave, o doador bloqueado, a bandeira, um `diary.peek` do bloco do doador sem rota `/index`, e na volta `gardenTake`: bandeira, resposta idempotente (`changed: false`, o menor `seq` quando vários citam o mimo), `takeAllowed`. `taken` não é alcançável (a resposta idempotente vem antes) e saiu das razões. Qualquer outra recusa das regras é `'jogada inválida'`.
- 5.165: `garden.drop` não confere a bandeira; o documento deixou de recusar com ela desligada. O handler faz identidade e portão de escrita, e `gardenDrop` confere só o diário próprio.
- 5.157: a saída (`on: false`) apaga os cinco tipos (`garden-state`, `garden-help`, `garden-decor`, `garden-gift`, `garden-take`) e não escreve nada só quando a bandeira já está desligada e nenhum deles está vivo. Também ficou dito que o recomeço zera `giftsToday` e `takesToday`.
- 5.162: `gave` lista o que `offerListable` mantém mais todo mimo vivo que conta em `giftsToday`; `takes` só os datados nos últimos 691200000 ms (8 dias), sem limite superior; com a bandeira desligada ou um relógio ilegível as duas listas vêm vazias.
- 5.157, introdução: o aplicativo relê `garden.state` ou `garden.stall` antes de oferecer a ação de novo.

## Verificação da correção (documento, `gave` e testes de método)

Rodado no mesmo Node, sobre 80e17e9d com as mudanças ainda fora de commit:

- `npx standard packages/rpc/test/methods.test.js packages/web-member/lib/member-ops.js packages/web-member/test/garden-stall.test.js`: passou.
- `node packages/rpc/test/methods.test.js`: 164/164 testes, 7655/7655 asserções. Casos novos em `garden phase 2`: `garden.give` com `to` `'zz'` e em maiúsculas, `garden.take` com `from` em maiúsculas e `'zz'`, e `seq` `Number.MAX_SAFE_INTEGER + 1`.
- `node packages/web-member/test/garden-stall.test.js`: 30/30 testes, 191/191 asserções.
- `node packages/web-member/test/garden.test.js`: 24/24 testes, 174/174 asserções.

Mutações, cada uma desfeita depois (`cmp` igual ao original):

- `to` de `garden.give` sem `isKey` (só `typeof v === 'string'`): falharam "bad to" e "uppercase to".
- `from` de `garden.take` sem `isKey`: falharam "bad from" e "short from".
- `seq` de `garden.take` com `Number.isInteger(v) && v >= 1` no lugar de `int(1, Number.MAX_SAFE_INTEGER)`: falhou "seq too large". Trocar só o limite superior por `Infinity` não falha, e é esperado: `Number.isSafeInteger` já recusa `MAX_SAFE_INTEGER + 1`.
- `gave` sem a cláusula `|| (!blind && e.ms >= today)` em `gardenStallOwn`: falhou "both listed, newest seq first" no teste novo "a gift dated too far ahead spends today and is listed, so it can be dropped" (um mimo vivo datado no sábado seguinte gasta o dia, aparece em `gave` com o seu `seq`, `garden.drop` o larga e `giftsToday` volta a 0).
