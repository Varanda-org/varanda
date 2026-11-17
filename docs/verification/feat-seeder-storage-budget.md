# Orçamento total de bytes do semeador (branch feat/seeder-storage-budget)

Parte da #33 (núcleo, CLI e docs). O aviso no app e no nó do navegador para `storage-full` vem num segundo PR, que fecha a issue.

## O que muda

- `packages/core/lib/storage-budget.js` (novo, puro, sem `require`): cobrança de um núcleo pelo tamanho assinado (`byteLength` + `length` x 128; um tamanho fora dos inteiros seguros nunca conta como zero), orçamento com 10% de reserva, reservas de admissões em andamento, núcleos sendo limpos ainda contados, a parte justa de cada membro (um dezesseis avos do orçamento, nunca menos que um diário e a mídia dele nos limites; conta os núcleos do membro e as raízes de grupo que as entradas dele trouxeram; uma raiz nova é conferida contra a parte inteira, e um núcleo do próprio membro só contra os núcleos dele), o que um membro além da parte dele descarta (as raízes, a maior primeiro; o membro só se os núcleos dele ainda passarem) e a ordem de descarte do orçamento (raízes primeiro, depois membros; o que mais ocupa primeiro; no empate, o admitido mais recentemente, depois a chave).
- `packages/core/lib/seeder.js`:
  - diários, núcleos de mídia e núcleos de grupo cobrados ao entrar e a cada crescimento;
  - admissão recusada com `storage-full` antes de buscar o bloco 0, quando não há espaço nenhum no orçamento ou na parte do membro, e depois de saber o tamanho assinado;
  - a reserva vale como piso da primeira cobrança, porque a réplica ainda não tem o tamanho assinado quando o núcleo passa a ser servido;
  - passagem de descarte quando um membro passa da parte dele (primeiro) ou o servido passa do orçamento, que confere de novo depois de cada dono descartado; a raiz de um grupo é dona de si mesma, então o tamanho dela nunca pesa na vez do membro cuja entrada a trouxe, e conta na parte dele;
  - a mesma passagem no `start()` antes do enxame, esperando as limpezas;
  - `storage` em `stats()`.
- CLI e implantação:
  - `VARANDA_STORAGE_BYTES` (de 1 GiB a 1 PiB, padrão 64 GiB);
  - `deploy.sh` e `update.sh` com até 16 dígitos nas variáveis de limite;
  - quatro medidores novos em `/metrics`;
  - exemplos de `.env`, `seeder.env` e `compose.yaml`.
- `docs/protocol.md`: seção 5 "Storage budget", passos (b'') e (c''), admissão de mídia e de grupo, passo 4b da partida e contagem do `ready`, `/health` e `/metrics`, mapa de módulos e riscos residuais.

## Comandos e resultados

Da raiz, um arquivo por vez (`node <arquivo>`), em 17/11/2026:

- `packages/core/test/storage-budget.test.js`: 19 testes, 139 asserções, todos passam.
- `packages/core/test/seeder-storage-budget.test.js` (DHT local), 14 testes, 152 asserções, todos passam:
  - uma admissão acima do orçamento menos a reserva é recusada com `storage-full` (resposta e log), nunca é guardada, e o uso fica exato e abaixo do teto; o anúncio repetido de um diário servido continua `admitted`; a primeira cobrança de um diário recém-admitido já é a reservada;
  - sem espaço nenhum, o bloco 0 nem é buscado (`gateHook`);
  - o crescimento de uma mídia passa do orçamento: o dono (diário e mídia) é descartado, o `rejected storage-full` chega a todos os pares, os avisos `storage-over-budget` e `storage-full` trazem uso, orçamento e bytes, o `admitted.json` fica só com o outro membro, sem `goneRoots` nem `revokedCreators`, e um reinício com o mesmo orçamento não descarta nada;
  - um reinício com orçamento menor descarta, antes do `ready`, o maior e depois o mais novo dos dois empatados; nenhum dos dois entra no enxame, `ready.cores.diaries` é `{ kept: 1, dropped: 2 }`, e um segundo reinício não descarta nada;
  - uma falha de limpeza no meio do descarte da partida faz o `start()` falhar e mantém o membro listado; a partida seguinte escolhe o mesmo membro e o limpa;
  - uma mídia que não cabe é recusada com `storage-full` e nunca é guardada;
  - um escritor de grupo que não cabe depois da busca é recusado com `storage-full`, nunca é guardado, e as respostas do grupo (`indexGroup`, `indexGroups`, `indexGroupSearch`) dizem `complete: false` enquanto a recusa vale;
  - uma raiz de grupo que cresce além do orçamento é descartada sozinha, com os bytes dela, e o membro cuja entrada a trouxe continua guardado;
  - uma mídia além da parte justa do membro é recusada com `storage-full`, nunca é guardada, e o orçamento ainda tem espaço;
  - uma raiz que cresce além da parte de quem a trouxe é descartada (`storage-member-over` com a parte e o teto, `storage-full` só para a raiz), os dois membros continuam e ela não volta enquanto não couber na parte de nenhum dos dois;
  - um membro cuja mídia cresce além da parte dele é descartado com a mídia (`storage-member-over` e `storage-full` com os bytes dele), sem passar do orçamento;
  - acima do orçamento, a raiz de um grupo sai antes de um membro maior, e todos os membros continuam;
  - com a parte de um membro cheia por uma raiz que a entrada dele trouxe, uma mídia nova dele é admitida mesmo assim, e a raiz é que sai (`storage-member-over` para o membro, `storage-full` só para a raiz);
  - um escritor de grupo recusado pela parte do membro (depois da busca e, com a parte já cheia, antes dela) espera e é tentado de novo, mas as respostas do grupo (`indexGroup`, `indexGroups`, `indexGroupSearch`) continuam `complete: true`, como nos limites por diário.
- `apps/cli/test/seeder-index.test.js` (53 testes) e `seeder-topic.test.js` (10), cujos semeadores falsos agora têm um orçamento, todos passam.
- Arquivos do semeador já existentes, todos passam: `seeder.test.js` (29 testes), `seeder-media.test.js` (9), `seeder-groups.test.js` (44) e `seeder-groups-waits.test.js` (12).
- CLI, todos passam:
  - `apps/cli/test/cli.test.js` (5 testes, 1367 asserções), com faixa e dígitos de `VARANDA_STORAGE_BYTES`;
  - `deploy.test.js` (63 testes) e `update.test.js` (73 testes, 1908 asserções), com 1 PiB aceito e 1 PiB + 1, 17 dígitos e zero à esquerda recusados;
  - `readme-help.test.js` (1);
  - `seed-ops.test.js` (16 testes, 220 asserções), com a lista de chaves do `/health` com `storage`, os valores padrão e os medidores.
- `npx standard` nos arquivos alterados: sem apontamentos.

## Falha sem a correção

Cada peça tirada sozinha, com o código restaurado depois (`cmp` igual ao original):

- Sem a reserva do tamanho assinado do diário, o teste 1 falha ("tempo esgotado: storage-full").
- Sem a checagem de espaço antes do bloco 0, o teste 2 falha.
- Com `_storageCheck` sem efeito, o teste 3 falha ("tempo esgotado: rejected storage-full").
- Sem a passagem do `start()`, o teste 4 falha ("largest first, then the newer admission").
- Sem esperar as limpezas no `start()`, o teste 5 falha.
- Sem o desempate pela admissão mais nova, o teste 4 falha.
- Sem a reserva da mídia, o teste 6 falha ("tempo esgotado: media storage-full").
- Sem a recusa do escritor de grupo depois da busca, o teste 7 falha ("tempo esgotado: group-rejected ... storage-full").
- Sem `storage-full` em `_groupFullFor`, o teste 7 falha nas três respostas `complete: false`.
- Sem o piso da reserva:
  - o teste 1 falha ("charged from the first set, before the replica holds the signed sizes");
  - o teste unitário "a reservation is the floor of the charge that replaces it" falha em duas asserções.
- Com a raiz cobrada de quem a trouxe (a regra anterior), o teste 8 falha em três asserções: o descartado é o membro, com 11345 bytes, e não a raiz.
- Com um tamanho fora dos inteiros seguros contado como zero, o teste unitário "a signed size past the safe integers is never charged as nothing" falha em três asserções.
- Sem a parte do membro na reserva:
  - o teste unitário "an admission past its member's share is refused while the budget has room" falha em quatro asserções;
  - sem ela na reserva da mídia, o teste 9 falha em quatro asserções.
- Com a passagem sem disparar quando um membro passa da parte dele, o teste 10 falha ("tempo esgotado: storage-full").
- Sem descartar as raízes de um membro além da parte, o teste 10 falha ("tempo esgotado: storage-full").
- Sem descartar o membro cujos núcleos passam da parte, o teste 11 falha ("tempo esgotado: rejected storage-full").
- Sem as raízes antes dos membros:
  - o teste 12 falha ("tempo esgotado: R purgado"; o descartado é o membro maior);
  - o teste unitário "victims: roots go before members, the largest root first" falha em três asserções.
- Com os núcleos do próprio membro conferidos contra a parte inteira, raízes incluídas (a regra anterior):
  - o teste 13 falha ("tempo esgotado: media-admitted"; a mídia é recusada com `storage-full`);
  - o teste unitário "roots filling a share never keep the member's own cores out; another root is refused" falha em dez asserções.
- Com a espera de uma recusa pela parte do membro contada como falta de espaço do semeador:
  - antes da busca, o teste 14 falha em duas asserções (as respostas ficam `complete: false`);
  - depois da busca, o teste 14 falha em três asserções.

## Limites

- Só servidor e CLI: nenhuma tela muda neste PR. O aviso no app vem no segundo PR da #33, conferido no Android, no iOS e na web.
- O tamanho do disco de produção ainda não é conhecido. O padrão de 64 GiB só protege se o disco for maior que isso mais `--blob-bytes`. O passo do operador (cerca de 70% do disco) está na #224.
- A parte justa conta as raízes pelo `by` da ligação, que não muda depois que a entrada sai: uma raiz trazida por um membro continua na parte dele enquanto for guardada. Com a parte cheia de raízes, uma raiz nova que a entrada desse membro traria é recusada (`storage-full`) até sobrar espaço; o diário, a mídia e os escritores dele nunca são recusados por causa delas.
- A cobrança por bloco (128 bytes) é uma estimativa, e os nós da árvore que um escritor de grupo cortado guarda para blocos limpos além de `MAX_LOG_BLOCKS` não são cobrados. O conjunto de mídia das conversas e os de mensagens diretas e visitas têm tetos próprios, fora do orçamento.
- Não há teste para a parada antecipada da passagem quando o descarte de um membro também libera raízes que ninguém mais sustenta. Ela segue do código e está descrita no `docs/protocol.md`.
