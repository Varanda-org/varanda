# feat/page-actor-box

Parte de #352 (PR 3): a caixa que um administrador delegado (nó core) declara para si, para receber a chave de uma página.

## O que mudou

- `packages/core/lib/page-secrets.js`: `actorBoxBytes`, `signActorBox` e `verifyActorBox`. Bytes: `utf8('varanda-page-actor-box-v1' LF) || sha256(JSON de { actor, at, box, gen } nessa ordem)`, assinados em Ed25519 pela chave de delegado `actor`. `verifyActorBox` nunca lança e recusa caixa fraca, `gen` fora de inteiro seguro >= 1 e `at` não canônico.
- `packages/core/lib/page-proof.js`, `packages/rpc/lib/methods.js`: a ação de página `actor-box`; o método `dm.actorBox` (5.161, não altera estado); `proof { gen, at, sig }` opcional em `dm.pageShare` e em cada destinatário de `dm.pageGenerate` (um destinatário tem 2 chaves, ou 3 só com uma `proof` bem formada).
- `packages/core/lib/session.js` e `packages/web-member/lib/session.js`: os dois nós recusam `dm.actorBox` nesta versão.
- `packages/web-member/lib/page-dm.js`: `dm.pageGenerate` e `dm.pageShare` conferem cada `proof` contra o membro e a caixa antes de selar; uma que não confere recusa a chamada inteira com `assinatura inválida`.
- `apps/cli/lib/account/pages-store.js`, `pages-dm.js`, `pages-routes.js`: a ação `actor-box`, aceita só de um delegado do quadro (dono ou administrador), com a assinatura conferida tendo o delegado como `actor`; `at` mais novo substitui, a mesma declaração não grava nada, `at` igual ou mais velho com outro conteúdo é `expirado`, `at` mais de 10 minutos no futuro é `pedido-invalido`. Uma mudança de quadro que tira o membro esquece a declaração, encerrar apaga todas, mudar de chave as leva para a chave nova. `dm-box-read` devolve `actorBoxes`.
- `apps/app/src/pageSecrets.js` e `apps/app/src/pages.js`: `actorBoxOf`; `planShares` e "Enviar chave" usam a caixa declarada, com a `proof`, só para um membro do quadro em que `dm.lookup` não achou caixa. O convite não usa: quem é convidado ainda não está no quadro, e o serviço só guarda declarações de membros do quadro.
- `apps/app/src/pages.js` `prepare` (remover, mudar de chave, ativar): quando algum membro do quadro não tem chave de mensagens publicada, lê `dm-box-read` de novo e usa os `actorBoxes` dessa leitura, porque o status da tela pode ser mais velho que uma declaração nova. Na mudança de chave a leitura é da página antiga (`boxesFrom`, passado por `PaginaAjustes.js`), porque a chave nova ainda não tem linha no serviço. Uma leitura que falha fica com os `actorBoxes` do status recebido; com todos os membros com chave publicada não há leitura extra. Em "Enviar chave", uma leitura que falha conta como nenhuma declaração e o membro recebe "Essa pessoa ainda não recebe mensagens", como antes.

## Ordem de implantação

Nenhum nó oficial envia `actor-box` nesta versão, mas o serviço de conta aceita a ação de qualquer delegado do quadro com cliente próprio assim que for implantado. Depois da primeira declaração, o `pages.json` passa a ter a chave `actorBoxes` numa linha, e um serviço de conta anterior a esta mudança não abre mais o arquivo: para voltar a versão, remova antes essas chaves à mão.

## Testes

```sh
npx standard <arquivos alterados>
node packages/core/test/page-secrets.test.js
node packages/core/test/page-proof.test.js
node packages/core/test/dm-session-refuse.test.js
node packages/rpc/test/methods.test.js
node packages/web-member/test/page-dm.test.js
node packages/web-member/test/pages.test.js
node apps/cli/test/pages-store.test.js
node apps/cli/test/pages-dm.test.js
node apps/app/test/pageSecrets.test.js
node apps/app/test/pages.test.js
```

`apps/app/test/pages.test.js` tem três testes novos: "a move seals K2 for a core delegate with the box it stated on the old page" (a leitura vem da página antiga e o delegado entra nas partes de K2 com caixa e `proof`), "a remove seals for the newest stated box, not the one in the screen's older read" (a declaração mais nova vence a do status da tela; sem leitura extra quando todos têm chave publicada) e "a failed fresh read keeps the given statements, and Enviar chave answers no box". O teste do convite com caixa declarada saiu, junto com o caminho. Resultados: `pages.test.js` 95/95 testes, 785/785 asserções; `pageSecrets.test.js` 16/16, 124/124; `pages-store.test.js` 46/46, 389/389; `pages-dm.test.js` 26/26, 427/427; `packages/web-member/test/page-dm.test.js` 21/21, 242/242.

## Falha sem a correção

Sem a conferência da `proof` em `packages/web-member/lib/page-dm.js` (as chamadas a `checkProof` em `generate` e `share` retiradas), `node packages/web-member/test/page-dm.test.js` falha no primeiro teste, na linha 199 (`a forged proof is refused`): o `dm.pageShare` com uma `proof` forjada selou em vez de recusar, e o arquivo para ali. Restaurada, passa (21/21 testes, 242/242 asserções).

Com `prepare` em `apps/app/src/pages.js` voltando a passar o status recebido para `planShares` (sem os `actorBoxes` da leitura nova), `node apps/app/test/pages.test.js` falha em 2 testes (93/95, 782/785 asserções): na mudança de chave as partes de K2 saem só para o dono e o administrador com chave publicada, e o delegado fica em `missing`; na remoção o delegado recebe a parte selada para a caixa velha (`c0...`, gen 1) em vez da nova. Restaurada, passa (95/95, 785/785).

## Não conferido

Nenhum nó oficial envia `actor-box` ainda, então não há caminho de ponta a ponta com um nó core real; a conferência em aparelho fica para o PR que liga `dm.actorBox` no nó core.
