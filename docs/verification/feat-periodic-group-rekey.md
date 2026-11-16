# Troca periódica da chave dos grupos privados (branch feat/periodic-group-rekey)

Parte da #350.

## Decisão

Desenho A, decidido pela manutenção em 2026-11-16: troca periódica da chave da época dos grupos privados, sem catraca e sem mudança de formato. A regra está em `docs/protocol.md`, "Private groups", parágrafo "Rotation" ("Periodic rotation").

## O que mudou

- `packages/core/lib/group-rekey.js` (novo): as constantes (7 dias, 1000 envelopes, fator `s = min(8, max(1, ceil(entitled/64)))`, espera de 48 h mais até 6 h para os outros distribuidores, uma checagem por grupo por hora, reserva de 10% do diário), a decisão pura `rekeyDue` com relógio e sorteio injetados, `epochFacts` (idade e envelopes da época, fora das regras da dobra) e o portão por hora `createRekeyGate`.
- Nó do navegador (`packages/web-member/lib/member-ops.js`, `periodicRekeyPlan` e `periodicRekey`; `packages/web-member/lib/session.js`, `periodicRekeyStep`): a checagem roda dentro das passagens de manutenção que já existem, só desbloqueado. Um grupo que cresce (no máximo uma vez por hora por grupo; o crescimento dentro da hora dispara uma passagem quando ela acaba, num temporizador só) e um temporizador na próxima data devida (nunca antes de 1 h) disparam uma passagem só de troca, na mesma fila: ela planeja nos núcleos que a sincronização empresta, pula quando a sincronização não os empresta e só interrompe a sincronização para gravar, sem mexer nos limites nem no desarme das passagens de manutenção. A troca usa o caminho de `group.rekey` (entrega de histórico, depois `rotateGroup` com a sonda de elegibilidade e o teste de espaço); como no `group.rekey`, uma falha na entrega de histórico para a troca, e a próxima checagem tenta as duas de novo.
- Nó do core (`packages/core/lib/member.js`, `periodicRekey`; `packages/core/lib/session.js`): só durante uma sincronização contínua, 30 s depois do início (no máximo uma vez por hora, contada quando a checagem roda) e depois de uma sincronização que faz crescer um grupo local que não é comunidade nem grupo já visto como público (o crescimento dentro da hora do grupo é checado quando ela acaba, num temporizador só). A checagem interrompe a sincronização como um pedido qualquer e a retoma. Como no `group.rekey` do core, a entrega de histórico é melhor esforço e a troca não tem a sonda de elegibilidade. Uma sincronização `once` nunca checa.
- `rekeyDue`: um envelope com `at` anterior ao da época conta como o `at` da época, então envelopes antedatados não encurtam a espera dos outros distribuidores.
- Uma falha não grava nada que mude a elegibilidade, nunca deixa o grupo `rekey-pending` e só se tenta de novo na próxima checagem.
- Docs: `docs/protocol.md` (Rotation, a frase "never automatic", o primeiro risco residual e o parêntese desatualizado "no key commitment"), `docs/design.md` (Limites) e `AGENTS.md` (a exceção das escritas iniciadas pelo nó).

## Como verificar

Cada arquivo sozinho:

```sh
node packages/core/test/group-rekey.test.js
node packages/core/test/private-rekey.test.js
node packages/web-member/test/periodic-rekey.test.js
node packages/core/test/group-private.test.js
npm run lint
```

- `group-rekey.test.js`: limites da política (fator, idade e contagem com s = 1, 2 e 8, grupo parado, `rekey-pending`, época nula, `at` no futuro, desempate e sorteio, envelopes antedatados, reserva de exatamente 10%, relógio obrigatório, portão por hora (`readyAt`) e relógio que volta, memória limitada).
- `private-rekey.test.js` (core): "core: a due group rotates once, and every member reads after the rotation", "core: a group not due yet does not rotate", "core: a failed rotation writes nothing and leaves the group not rekey-pending", "core: a plain member never rotates", "core: two distributors, the opener rotates at once and the other waits", e na sessão "core session: a continuous run checks after its start, rotates a due group once and runs on", "core session: a once run never checks", "core session: growth inside a group's hour waits for the hour to end, then one check", "core session: a community's growth never reaches the check". Os testes do core têm `t.timeout(180000)`: sob carga, só a preparação dos dois nós leva cerca de 30 s.
- `periodic-rekey.test.js` (navegador): os mesmos casos no nó do navegador, mais "locked: nothing is planned", e na sessão "session: a due group rotates once in the upkeep pass", "session: a group not due is left alone", "session: a failed rotation is not retried within the hour, and the group stays not rekey-pending", "session: a grown group starts a rotation-only pass on the run's cores, at most once an hour". `node packages/web-member/test/session-upkeep.test.js` continua passando (a passagem só de troca não arma a manutenção desarmada).
- Regressão: cada teste novo falha sem a correção que ele cobre (saídas no relatório do commit): sem o piso no `at` da época, o teste dos envelopes antedatados; sem o portão por hora no crescimento, "not before the hour ends" no navegador e no core; sem o filtro de grupos checáveis no core, "only the group".
- Regressão: sem a chamada `await periodicRekeyStep(epoch, generation)` na passagem de manutenção, "session: a due group rotates once in the upkeep pass" falha com `tempo esgotado: the rotation`; com ela, passa.

## Não verificado / limites conhecidos

- Celulares e Safari não foram medidos: o custo de uma troca (entrega de histórico e a época nova) num aparelho fraco fica por conferir.
- Um grupo cujos distribuidores quase nunca ficam online troca pouco: a troca só acontece com um distribuidor online, e a janela pode passar de dias (espera de 48 h mais sorteio dos outros, checagem por hora).
- Aparelho roubado: nada muda. Um aparelho que continua no grupo recebe toda chave nova, e o histórico continua legível com as chaves antigas.
- Páginas ficam de fora: o serviço de conta grava os grupos de Página pelo próprio código e nunca chama esta checagem (não há guarda explícita: um grupo de Página não se identifica barato na checagem).
- O portão por hora e o sorteio ficam em memória: um reinício do nó (recarregar a página, reabrir o app, reiniciar o `varanda-serve`) reabre a hora de cada grupo e sorteia de novo a espera dos outros distribuidores.
- No navegador, a passagem só de troca não testa a falha da entrega de histórico (a função é interna ao módulo); o caminho é o mesmo do `group.rekey`.
- O nome selado de um grupo novo conta como envelope, então um grupo novo e parado troca uma vez, aos 7 dias.
- Um `at` forjado no passado pode fazer os outros distribuidores trocarem antes; o portão por hora e a reserva do diário limitam o custo.
- `rotateEpoch` do core não tem a sonda de elegibilidade do navegador: uma época nova que não fique elegível só faz os leitores continuarem na época anterior, sem `rekey-pending`.
