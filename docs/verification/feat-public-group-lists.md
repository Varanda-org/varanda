# feat/public-group-lists

Listas de grupos públicos do semeador: as leituras `indexGroupBrowse` e `indexPublicGroups` (`packages/core/lib/seeder.js`, `packages/core/lib/group-index.js`) passam a ter rotas HTTP públicas em `apps/cli/lib/seed-ws.js`. Regras em `docs/protocol.md`, seção "Index routes".

## O que mudou nas rotas

- `GET|HEAD /index/group-browse/members` e `/index/group-browse/recent` (`INDEX_GROUP_BROWSE_RE`) -> `{ groups: [{ group, name, creator, community, communityName, writerCount, created, active }], more, indexing, complete }`.
- `GET|HEAD /index/public-groups/<D>[/<after>]` (`INDEX_PUBLIC_GROUPS_RE`) -> `{ groups: [{ group, name, creator, community, communityName, writerCount }], next, hidden, indexing, complete }`.
- Os corpos são refeitos campo a campo (`browseBody`, `publicGroupsBody`): uma chave a mais na linha do semeador nunca sai. `hidden` só é `true` se o semeador mandar `true`.
- As duas rotas usam o limite público de `/index`, nunca o da triagem. Resposta `null`, exceção ou caminho malformado continuam no 404 genérico.

## Testes (`apps/cli/test/seed-ws.test.js`)

- `routes answer the wire shapes`: os dois corpos, as chaves exatas do corpo e da linha (a linha do stub traz uma chave extra que não pode sair), o cursor chegando ao semeador e o 404 de um diário desconhecido.
- `malformed paths never reach the seeder`: `/index/group-browse/trending`, `/index/group-browse/Members`, `/index/group-browse/members/x`, query string, `/index/public-groups/` com 63 hex, maiúsculas, cursor ruim e segmento a mais, todos 404 sem chamar o semeador. Um PR seguinte torna `/index/group-browse/trending` válida e a tira dessa lista.
- `the real Seeder's answers`: `/index/group-browse/members` responde 200 com `groups` em lista, e `/index/public-groups/<chave não servida>` é 404.
- `worst-case bodies stay within 64 KiB`: dois nomes de 80 surrogates soltos por linha (6 bytes cada no JSON). 20 linhas de `group-browse` dão 26.178 bytes e 32 linhas de `public-groups` dão 40.231 bytes, abaixo de 65.536; 64 linhas passariam do limite e dão 404, por isso a página de 32.

## Falha sem a correção

Sem os dois ramos novos de `indexCall`, `node apps/cli/test/seed-ws.test.js` termina com código 1 (a rota de `group-browse` responde o 404 genérico e o teste de formato quebra). Restaurados, passa.

## Comandos

```sh
node apps/cli/test/seed-ws.test.js      # 108/108 testes, 2633/2633 asserções
node apps/cli/test/caddyfile.test.js    # 24/24 testes, 323/323 asserções
npx standard apps/cli/lib/seed-ws.js apps/cli/test/seed-ws.test.js   # limpo
npm run demo                            # DEMO OK
```

## Não rodado

A suíte inteira roda na CI do GitHub. Nenhum semeador real foi consultado pela rede e o Caddy não foi recarregado: as rotas novas ficam sob o `handle /index/*` que já existe.

## Correções da revisão (rodada 1)

- `browse('members')`: `created` sai com a mesma regra de data de `recent`, só no valor: `null` quando falta ou está mais de 24 h (`MAX_FUTURE_MS`) à frente de `now`, senão `Math.min(created, now)`. A linha mantém o lugar. Um cabeçalho com `at` no ano 9999 não sai mais como está.
- `browse('recent')`: datas futuras aceitas viram `now` no fio, mas a ordem usa a data bruta como segundo critério (antes da chave), e o limite de 2 por criador fica com os dois mais novos de verdade. A linha não ganha chave nova.
- `publicGroupsOf`: `limit` acima de `PUBLIC_GROUPS_PAGE` (32) é reduzido a 32; `limit` não inteiro ou menor que 1 continua `null`.
- `publicGroupsBody` (`seed-ws.js`): com `hidden: true` o corpo leva `groups: []` e `next: null`, seja o que for que o semeador mandar.

Testes novos: em `packages/core/test/group-index-browse.test.js`, o limite inclusivo de `now + MAX_FUTURE_MS` em `recent` e a data nula ou presa em `members`; um criador com três grupos em `now + 1 h`, `+ 2 h` e `+ 3 h` cujas chaves vão na ordem contrária das datas (`recent` mantém `+ 3 h` e `+ 2 h`, os dois com `created === now`); um grupo privado em que o diário tem escritor ativo nunca aparece em `publicGroupsOf`; `limit: 1000` devolve 32 linhas e `next` não nulo, e `0`, `-1`, `1.5` e `'3'` dão `null`. Em `apps/cli/test/seed-ws.test.js`, um semeador que responde `hidden: true` com linhas e `next` dá 200 com `groups: []`, `next: null` e `hidden: true`. Dois testes antigos mudaram a expectativa: o de `recent` agora põe `key(2)` (`now + 1 h`) antes de `G` (`now`), e `members` manda `created === now` para `now + 1 h`.

Falha sem a correção, conferido revertendo cada uma e restaurando: sem a de `members`, 2 testes do arquivo de browse falham; sem a do desempate pela data bruta, 2 falham; sem o teto de `limit`, 1 falha; sem a de `hidden`, o teste novo de `seed-ws` falha (108/109). O teste do grupo privado é uma guarda e passa também sem as correções.

```sh
node packages/core/test/group-index-browse.test.js   # 14/14 testes, 110/110 asserções
node packages/core/test/group-index.test.js          # 14/14 testes, 161/161 asserções
node packages/core/test/seeder-group-browse.test.js  # 5/5 testes, 53/53 asserções
node apps/cli/test/seed-ws.test.js                   # 109/109 testes, 2635/2635 asserções
npx standard packages/core/lib/group-index.js packages/core/test/group-index-browse.test.js apps/cli/lib/seed-ws.js apps/cli/test/seed-ws.test.js   # limpo
```

## Correções da revisão (rodada 2)

- `indexPublicGroups` (`packages/core/lib/seeder.js`): o filtro `joined` também deixa de fora um grupo público cuja raiz o semeador ainda não leu em ordem até o tamanho que baixa dela (`_rootGap`: o log assinado inteiro, ou os blocos guardados abaixo de um corte). Uma raiz baixa fora de ordem, então um `group-meta` que fechou a entrada depois de um buraco não era lido, o grupo ficava com o `open` do cabeçalho e saía na lista do perfil com `complete: true`. Agora, quando o filtro recusa um grupo por buraco ou por leitura da raiz atrasada, a resposta sai com `complete: false`. Uma raiz privada nunca é lida e nunca conta. `_rootScanBehind`, `_groupsUnsettled`, `_discoveryUnsettled` e `indexGroupBrowse` não mudaram.
- `docs/protocol.md`: os dois itens das rotas dizem que a lista por diário deixa de fora o grupo até a raiz ser lida até o tamanho baixado, com `complete` falso, e que, nas duas rotas, `complete` cobre o que o semeador leu em ordem.

Teste novo em `packages/core/test/seeder-group-browse.test.js`: o buraco é feito no semeador, de forma determinística. A leitura do bloco 1 da raiz de H fica presa, A acrescenta um post e um `group-meta` que renomeia H, o bloco 1 é apagado da cópia do semeador (`contiguousLength` volta a 1, `length` fica 3) e a leitura presa não acha nada. Nesse estado a leitura não está atrasada (`_rootScanBehind` falso), H sai das listas de D, E e A e `complete` é falso; o browse ainda lista H. Como a faixa de download não busca de novo sozinha um bloco apagado localmente, o teste pede o bloco 1, como faria um par que o tem, e H volta à lista com o nome novo e `complete: true`. O mesmo teste confere que A, num grupo privado e num aberto, tem `complete: true` e que `_rootGap` da raiz privada é falso. O ramo do corte de `_rootGap` não tem teste (uma raiz nunca recebe corte hoje).

Falha sem a correção, conferido tirando `_rootGap` do filtro e restaurando: o teste novo falha (5/6, as 6 asserções de lista e de `complete` durante o buraco).

```sh
node packages/core/test/seeder-group-browse.test.js   # 6/6 testes, 71/71 asserções
node packages/core/test/seeder-groups.test.js         # 44/44 testes, 271/271 asserções
node packages/core/test/seeder-communities.test.js    # 9/9 testes, 59/59 asserções
node packages/core/test/group-index-browse.test.js    # 14/14 testes, 110/110 asserções
node apps/cli/test/seed-ws.test.js                    # 109/109 testes, 2635/2635 asserções
npx standard packages/core/lib/seeder.js packages/core/test/seeder-group-browse.test.js   # limpo
```

## Correções da auditoria de segurança (rodada 3)

- `browse` (`packages/core/lib/group-index.js`), as duas ordens: uma só regra de data. `created` é a data do cabeçalho da raiz (ISO canônica, em 1970 ou depois) quando está no máximo 5 minutos (`CREATED_SKEW_MS`, 300.000 ms) à frente de `now`, senão `null`. A data nunca é presa em `now`. Antes, um grupo datado até 24 h à frente saía com `created === now` e ficava acima de todo grupo com data honesta em `recent`, e um membro certificado podia prender um grupo no topo de "Criados recentemente" por cerca de 24 h e renovar. `recent` deixa de fora `created` nulo, ordena por `created` decrescente e depois pela chave crescente, aplica o limite de 2 por criador e corta em 20. O desempate pela data bruta da rodada 1 saiu: a ordem no fio é exatamente a ordem declarada, e duas linhas presas em `now` não chegam mais fora da ordem de chave. `MAX_FUTURE_MS` deixou de ser exportado por `group-index.js` (só o teste o importava). Nota: as frases da rodada 1 sobre o limite de 24 h, `Math.min(created, now)` e o desempate pela data bruta não valem mais.
- `publicGroupsOf`: `joined` roda por último, só para um grupo que passa por `listed`, não é o Geral da comunidade e tem entrada efetiva `open`; o grupo entra quando ao menos um escritor ativo do diário passa por `joined`. Assim um buraco na raiz do Geral, de um grupo com aprovação, de um privado ou de um sem nome não deixa mais `complete: false` na lista de perfil dos membros. As checagens rodam para todo grupo candidato do diário, antes do cursor e depois da página também, então `complete` é o mesmo em toda página. As linhas são as mesmas de antes para qualquer entrada.
- `docs/protocol.md`: o item de `/index/group-browse` traz a regra nova de data e de ordem; o de `/index/public-groups` diz que a checagem da raiz, e `complete: false`, só vale para um grupo que a lista mostraria, que o criador de um grupo listado pode manter `complete` falso para os membros segurando um bloco da raiz e que o cliente não repete o pedido por `complete: false`.
- Comentário de `indexPublicGroups` (`packages/core/lib/seeder.js`) atualizado; nenhum código do semeador mudou.

Testes novos ou reescritos em `packages/core/test/group-index-browse.test.js`: em `recent`, um grupo em `now + CREATED_SKEW_MS` sai com essa data, um em `now + CREATED_SKEW_MS + 1` não sai, e um em `now + 23 h` não sai nem fica acima de um grupo honesto em `now - 1 min` (e sai, com a própria data, quando `now` chega a 5 minutos dela); empate de data vai pela chave crescente; um criador com grupos em `now + 1`, `+ 2` e `+ 3 min`, chaves na ordem contrária, dá `+ 3` e `+ 2 min` com as próprias datas. Em `members`, grupos em `now + 2 dias` e `now + 1 h` mantêm o lugar com `created === null`, um em `now + 1 min` sai com essa data e uma data canônica antes de 1970 dá `null`. Toda resposta de browse nesses testes e no de `more` passa pela checagem da ordem declarada (`inOrder`). Um `joined` espião nunca é chamado para o Geral, um grupo com aprovação, um sem nome, um privado ou um sem create na comunidade, é chamado para os dois grupos abertos listados (também com `limit: 1` e com o cursor depois do primeiro), e as linhas são iguais às de `joined` sempre verdadeiro.

Em `packages/core/test/seeder-group-browse.test.js`: um buraco na raiz de P (com aprovação) e outro na do Geral G, os dois com escritor de D e de A, deixam `indexPublicGroups` de D e de A com `[H]` e `complete: true` (`_rootGap` verdadeiro, leitura não atrasada); o teste 6, buraco na raiz de H, continua dando `complete: false`. E um teste em que só a leitura da raiz da comunidade C está presa (as raízes de G, H e P em dia): `indexGroupBrowse('members')`, `indexGroupBrowse('recent')` e `indexPublicGroups(D)` dão `complete: false`, e `true` depois de soltar, com o nome novo da comunidade.

Falha sem a correção, conferido revertendo e restaurando cada uma:

- F6: com o `browse` antigo (24 h, data presa em `now`, desempate pela data bruta), os três testes de data do arquivo de browse falham (12/15 testes, 186/193 asserções), entre elas "a group dated 23 h ahead never sits above an honest one".
- F7: com o `publicGroupsOf` antigo, o teste do espião falha (14/15; linhas iguais, mas `joined` chamado para os grupos não listados, e não chamado depois da página nem antes do cursor). No arquivo do semeador, o teste do buraco em P e G falha nas duas asserções de `complete`.
- V1: com o laço de `_discoveryUnsettled` ignorando raízes de comunidade, o teste novo falha nas três asserções de `complete: false` (o arquivo deu 6/8 testes, 88/93 asserções, junto com o revert de F7).

```sh
node packages/core/test/group-index-browse.test.js    # 15/15 testes, 191/191 asserções
node packages/core/test/group-index.test.js           # 14/14 testes, 161/161 asserções
node packages/core/test/seeder-group-browse.test.js   # 8/8 testes, 93/93 asserções
node packages/core/test/seeder-groups.test.js         # 44/44 testes, 271/271 asserções
node packages/core/test/seeder-communities.test.js    # 9/9 testes, 59/59 asserções
node apps/cli/test/seed-ws.test.js                    # 109/109 testes, 2635/2635 asserções
npx standard packages/core/lib/group-index.js packages/core/test/group-index-browse.test.js packages/core/test/seeder-group-browse.test.js packages/core/lib/seeder.js   # limpo
```
