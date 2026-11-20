# Filtro de tipo antes de clonar e validar (branch perf/record-type-filter)

Parte da #353 (restos da #340). Antes, `latestProfile`, `latestUsernameRecord`, `heldUsernames` e os percursos de grupo `groupJoins`, `groupJoinHistory`, `groupConfirmHistory`, `groupCutHistory` e `diaryGroupKeys` clonavam e validavam por inteiro todo registro do diário (`validRecordCopy`) para só depois descartar os de outro tipo.

## O que mudou

- `packages/core/lib/records.js`: `validRecordCopyOfType(record, seq, type)`, exportada. A cópia mantém o `type` do original (structuredClone e o percorredor de dados simples copiam propriedades de dados como estão). Por isso, um objeto simples cujo `type` PRÓPRIO é uma propriedade de dados com outro valor nunca vira cópia do tipo procurado, e o clone e a validação são pulados. Sem `type` próprio, com acessor (getter), com leitura que lança, ou não-objeto: cai em `validRecordCopy` como antes (não-objeto dá `null`, igual). `latestProfile` usa o filtro.
- `packages/core/lib/username.js`: `latestUsernameRecord` e `heldUsernames` usam o filtro; `pickUsername` continua checando `seq <= bestSeq` antes. As variantes `...OfCopies` não mudam.
- `packages/core/lib/group.js`: os cinco percursos acima usam o filtro; `groupCutHistory` continua contando o buraco por seq antes da cópia.

## Testes (`packages/core/test/record-type-filter.test.js`, rodado sozinho com `node`)

- `type pre-filter: every walker answers as copy-then-check on random diaries`: 300 diários aleatórios (registros válidos de vários tipos, tipos errados, tipo certo mas inválido, nulos, números, listas, getter e getter que lança em `type`, `type` herdado, Proxy que lança, chave extra, seq fora do normal) contra a implementação antiga copiada no teste (oráculo). Igualdade profunda para os sete percursos.
- `validRecordCopyOfType: same copy as validRecordCopy for the wanted type, null otherwise`.
- `type pre-filter: a diary of N records with one profile clones one`: conta chamadas de `structuredClone` (mesmo método da #404 em `feed.test.js`): 200 registros, um perfil, `latestProfile` clona 1 vez; `latestUsernameRecord` sem registro de @nome clona 0.

Falha sem a correção (lib revertida, só o teste de contagem): `not ok - one clone for N records, actual: 200, expected: 1`. O teste do oráculo passa também sem a correção, como deve: ele mostra que a saída não muda. Com a correção: 3 de 3 testes, 2580 asserções. Também rodados sozinhos e verdes: `records`, `username`, `group`, `community-fold`, `name-index`. `npx standard` limpo nos arquivos alterados.

Segunda rodada (revisão): o oráculo também cobre `diaryGroupKeys` (cópia da versão antiga) e roda uma segunda vez sem `structuredClone`, para o `plainClone`. Novo teste `heldUsernames and the group walkers copy only records of their type`, que conta chamadas de `structuredClone` (N = 100 entradas; cada percurso de grupo clona cada entrada uma vez em `eachEntry` e depois só os registros do próprio tipo). Cada asserção falha com só aquele percurso de volta a `validRecordCopy` (restaurado de uma cópia fora do repositório):

| Percurso revertido | esperado | obtido |
|---|---|---|
| `heldUsernames` | 2 | 100 |
| `groupJoins` | 103 | 200 |
| `groupJoinHistory` | 103 | 200 |
| `groupConfirmHistory` | 101 | 200 |
| `groupCutHistory` | 101 | 200 |
| `diaryGroupKeys` (um dos dois passes) | 206 | 303 |

Diferença documentada: um getter numa chave anterior a `type` poderia reescrever `type` durante o clone; o registro é pulado (falha fechada). Para dados simples (saída de `decodeBlock`, entradas de `plainCopy`) a resposta é idêntica.

## Medidas (Node no Mac, não são números de celular)

Máquina com outras sessões rodando: a carga de 1 min vai de 5,7 a 12,1, então só diferenças grandes valem. A = origin/main f40cf6f6, B = esta mudança, alternados.

`node packages/web-member/scripts/startup-bench.js --follows 60 --blocks 150 --own 800 --issued --reads --runs 3 --file --json` (verificação nativa):

| Rodada | carga 1 min | profileMs | feedMs |
|---|---|---|---|
| A | 7,48 | 47,7 | 32,5 |
| B | 7,09 | 17,0 | 40,0 |
| A | 6,47 | 49,6 | 31,7 |
| B | 6,33 | 15,8 | 32,9 |
| A | 6,78 | 42,1 | 31,9 |
| B | 12,08 | 16,5 | 46,3 |

`profileMs` cai de cerca de 46 para cerca de 16 ms (a leitura de perfil de todos os autores). `feedMs` não mudou (o feed já copia cada entrada uma vez); a variação é ruído de carga.

`node packages/web-member/scripts/startup-bench.js --groups 20 --group-blocks 200 --runs 3 --file --json` (groupListMs / groupList2Ms / communityListMs):

| Rodada | carga 1 min | groupListMs | groupList2Ms | communityListMs |
|---|---|---|---|---|
| A | 9,98 | 620,9 | 60,1 | 7,1 |
| B | 6,34 | 550,0 | 64,9 | 7,2 |
| A | 5,73 | 586,7 | 71,7 | 8,1 |
| B | 8,07 | 681,3 | 67,9 | 8,3 |

Sem diferença distinguível do ruído: este cenário não passa pelos percursos filtrados em quantidade que apareça (não medido o motivo). Nenhum ganho é afirmado para grupos.

## Suíte

Na raiz, no Node 24: `npm run lint` e `npm run demo` (`DEMO OK`) passaram. No `npm test -- --affected=origin/main`, 26 de 797 arquivos estouraram o tempo com a máquina carregada por suítes de outras branches (arquivos de rede de `packages/core` e `apps/cli/test/update.test.js`). Cada um passou rodando sozinho (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`), 26 de 26.

## Não rodado

Perfil de CPU (`--cpu-prof`); medida em navegador ou celular; Node 20 (só na CI); o ganho dos 210 ms da #340 não foi reproduzido naquele cenário.
