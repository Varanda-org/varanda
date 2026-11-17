# Escritor de quem saiu, listado pela entrada ligada (branch fix/left-writer-listing)

Parte da #350. Correção do semeador que entrou na #713 (`feat/writer-slot-walk`, commit 8772d908).

## O problema

Desde a #713 o semeador guarda, marcado como `left`, um escritor contado cuja última entrada no diário está desligada, e um escritor liberado por um corte 0. Ele listava esse escritor com a seq da última entrada do diário (`liveGroupJoins` em `packages/core/lib/seeder.js`), que para quem saiu é a entrada desligada (`on: false`). Essa seq vai para a admissão (`admitted.json`, `groups[W].seq`) e para a página de escritores do grupo. Todo leitor confere a seq do item contra o bloco do diário e exige um `group-join` ligado que nomeie o escritor e o grupo: `joinVerdict` em `packages/core/lib/sync.js` e a conferência equivalente em `packages/web-member/lib/sync.js`. Com a entrada desligada, o leitor recusava o escritor como `unbound` e contava a listagem contra o semeador (`badHint`; com 32 listagens recusadas, ele deixa de usar aquele semeador). O leitor do serviço de conta (`apps/cli/lib/account/pages-groups.js`) lê os diários inteiros e não usa a seq do item, então não era afetado.

Acontecia quando o semeador guardava o escritor depois da saída: uma saída antes de o semeador ver o escritor (entrar e sair entre duas sincronizações, uma busca do escritor que demorou) ou um semeador novo que conhece o diário depois da saída. Um escritor já guardado antes da saída mantinha a seq da entrada ligada.

## O que mudou

Só o semeador (`packages/core/lib/seeder.js`); nenhum leitor muda.

- `groupWalkStep` guarda, na caminhada de cada grupo, a seq da entrada ligada mais nova de cada escritor que a caminhada conta ou liberou (`onSeq`). O mapa nunca passa dos limites da caminhada por grupo (8 vivos, 8 congelados, 16 liberados).
- `liveGroupJoins` lista o escritor que saiu, e o liberado, com essa seq. A caminhada só conta um escritor depois de uma entrada ligada, então ela sempre existe.
- `_reconcileGroups` passa a usar a seq da listagem também para um escritor que saiu: uma ligação guardada com a seq da entrada desligada (pela versão anterior a esta) se corrige no próximo escaneamento do diário, em memória, na página e em `admitted.json`. Uma ligação que o escaneamento não lista (o diário nomeou W em outro grupo, ou o grupo passou do limite de 64) continua com linha na página: ela recebe a entrada ligada mais nova de W naquele grupo pela caminhada, assim que o escaneamento a lê; até lá fica com a seq guardada. O resto fica como estava: a marca `left`, os limites por diário, `groupRefused` pela seq e a caminhada.
- Com a #717 (`fix/group-records-ignore-deletes`) já na `main`, uma entrada apagada que chega depois de o escaneamento passar por ela refaz a caminhada do grupo (`foldGroupRecord`), também pelo `groupWalkStep`. Assim `onSeq` acompanha: um escritor que saiu, cuja entrada ligada apagada chega atrasada, é listado por ela. Esse caminho não precisou de mudança no código, só de um teste.

Documentos: `docs/protocol.md` seção 10, "Seeder group admission" ("Scan") e "Data-dir files" (`groups` de `admitted.json`).

## Testes

Cada arquivo sozinho, a partir da raiz, com `VARANDA_TEST_CONCURRENCY=1 node <arquivo>`:

- `packages/core/test/seeder-groups-cuts.test.js`: 14/14, 296 asserções.
  - Novo: "a stored binding the scan no longer lists gets its on join too, never an off one (#350)": a ligação de W em G guardada com a seq 2 (entrada desligada); o diário depois nomeia W em H, e o escaneamento lista W só em H. `_reconcileGroups` dá à ligação e à linha da página a seq 1 (a entrada ligada em G), marcada `left`.
  - "liveGroupJoins: a counted writer whose join is off stays, left; an uncounted one does not (#350)": as duas expectativas que pediam a seq da entrada desligada (10 e 3) agora pedem a da entrada ligada (2 e 2).
  - Novo: "liveGroupJoins: a left or released writer is listed by its newest on join for the group, never an off join (#350)": entrou duas vezes e saiu; liberado e depois saiu; entrada ligada em outro grupo antes; saiu, voltou e saiu de novo.
  - Novo: "a writer that left before its admission is listed by its on join, and a binding stored with the off join heals at the next start (#350)": B entra com W e sai (uma saída em W e a entrada desligada) antes de o semeador ver W. O item da página e `admitted.json` trazem a seq 1 (entrada ligada) e `left: true`. Depois, com o semeador parado, `admitted.json` recebe a seq 2 (a entrada desligada, como a versão anterior gravava); no reinício o escaneamento devolve a seq 1 à página e ao arquivo, sem descartar W.
- `packages/core/test/sync-groups-7.test.js` (novo): 1/1, 12 asserções. Ponta a ponta com o nó core: Ana cria o grupo, Bia entra, publica e sai pelo `member.groupLeave` antes de sincronizar; depois do semeador, a sincronização de Ana busca o escritor de Bia sem nenhum `group-skipped` e lê a publicação de antes da saída.
- `packages/web-member/test/sync-groups-3.test.js` (novo): 1/1, 14 asserções. O mesmo com o nó do navegador (`ops.groupLeave`) e um terceiro membro lendo pelo semeador via WebSocket.
- `packages/core/test/seeder-delete.test.js`: novo "a deleted on join that arrives after the scan lists its left writer by that join (#350)": o diário entra com W (seq 1), sai (seq 2, entrada desligada) e apaga a entrada (seq 3). O escaneamento lê a seq 2 e passa pela 1 como buraco; quando a 1 chega, W é listado com `{ seq: 1, left: true }`.
- Sem mudança, para conferir que nada mais se moveu, antes do merge com a `main` (3f7e8420): `packages/core/test/seeder-delete.test.js` 30/30 (263), `packages/core/test/sync-groups-3.test.js` 16/16 (71), `packages/core/test/seeder-groups.test.js` 43/43 (262), `packages/core/test/seeder-groups-3.test.js` 6/6 (33), `packages/core/test/seeder-groups-waits.test.js` 12/12 (61) e `packages/web-member/test/sync-groups-2.test.js` 26/26 (130).
- Depois do merge com a `main` (d2294699, com a #717): `seeder-groups-cuts` 13/13 (293), `seeder-delete` 35/35 (288, com o teste novo), `seeder-groups` 44/44 (270), `sync-groups-7` 1/1 (12) e `web-member sync-groups-3` 1/1 (14).
- Com a volta pela caminhada para a ligação não listada: `seeder-groups-cuts` 14/14 (296), `seeder-delete` 35/35 (288), `seeder-groups` 44/44 (270), `sync-groups-7` 1/1 (12) e `web-member sync-groups-3` 1/1 (14).
- `apps/cli/test/changelog.test.js` 9/9 (42) e `npm run lint` limpo.

## Prova de regressão

Com `packages/core/lib/seeder.js` da `main` (3f7e8420) e os testes desta branch:

- `seeder-groups-cuts`: 10/13 (283/293). Falham os dois testes de `liveGroupJoins` acima (por exemplo, "frozen and left: kept for its history, by its on join") e o teste de integração novo: "by its on join, the block readers check" (seq 2 no lugar de 1), "and stored with it", "listed left by its on join again" e o arquivo depois do reinício.
- `sync-groups-7`: 0/1 (7/12). O semeador lista o escritor de Bia com a seq 5 (a entrada desligada; a ligada é 4), e a sincronização de Ana o recusa: `group-skipped` com `reason: 'unbound'` (a listagem contada contra o semeador), sem `group-downloaded`, sem o núcleo guardado e sem a publicação "oi".
- `web-member sync-groups-3`: 0/1 (10/14). O mesmo no nó do navegador: `group-skipped` `unbound`, o escritor não fica guardado e "oi" não aparece.
- `seeder-delete`, com `packages/core/lib/seeder.js` da `main` d2294699: 34/35 (287/288). Falha só o teste novo: "listed left by the late on join, never the off one" dá seq 2 (a entrada desligada) no lugar de 1.
- `seeder-groups-cuts`, com `packages/core/lib/seeder.js` de 55b2ec73 (antes da volta pela caminhada para a ligação não listada): 13/14 (294/296). Falha só o teste da ligação não listada: "the binding takes its on join in G" dá 2 no lugar de 1, e a linha da página também sai com a seq 2.

Só com a mudança de `_reconcileGroups` desfeita (a de `liveGroupJoins` mantida), `seeder-groups-cuts` dá 12/13 (291/293): depois do reinício a página continua com a seq 2 que o arquivo trazia ("listed left by its on join again" e "and stored with it").

Nos dois testes ponta a ponta, sem a correção, a recusa depende de o semeador escanear a entrada desligada antes de admitir o escritor; se ele admitisse com a entrada ligada ainda sozinha no diário, a seq já sairia certa. Nas execuções acima a recusa apareceu toda vez. Os testes do semeador não dependem dessa ordem.

## Para o operador

Atualize os semeadores antes (ou no lugar) de qualquer app: a correção é toda do semeador e os apps instalados passam a aceitar a listagem sem atualizar nada. Um semeador já em produção com escritores guardados pela entrada desligada se corrige sozinho no primeiro escaneamento de cada diário depois de reiniciado.

## Fica de fora

- Nada foi exercitado em aparelho nem contra um semeador de produção.
- A suíte inteira e `npm run demo` não foram rodados nesta branch.
