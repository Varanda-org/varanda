# Ocultar uma publicação pela lista assinada de moderação (issue #225, primeira parte)

A moderação esconde uma publicação sem bloquear a conta. `mod hide <chave> <seq>` e `mod unhide <chave> <seq>` mantêm uma segunda lista assinada, só de publicações ocultas (`hidden-posts.json`, até 512 referências `<chave>:<seq>`, com número de sequência próprio), que vai ao semeador e circula entre os nós pelo canal novo `varanda/blocklist/2`. A lista de bloqueio, o `blocklist.json` e o canal `varanda/blocklist/1` ficam como na `main`, então um nó de versão anterior continua seguindo os bloqueios. A decisão "ocultar" do painel por `mod apply` fica no PR seguinte, empilhado sobre este.

## Critérios de aceite

| Critério | Como foi conferido |
| --- | --- |
| A publicação listada sai de A Rua e da busca depois da próxima sincronização, e o resto do diário continua | Nó do navegador (também o worklet do app): `packages/web-member/test/blocklist.test.js`, "a hidden post leaves feed.read and log.read after the next run; the rest of the diary and the own post stay". Nó da linha de comando: `packages/core/test/blocklist-member.test.js`, "a hidden post leaves log.read and feed.read of followers, not of its author". Funções puras: `feed.test.js` (a publicação e as republicações dela saem, nada mais) e `peek.test.js` (`diaryPeek`). Semeador: `blocklist-seeder.test.js`, "a hidden post is cleared and dropped from the indexes at runtime and on restart; the diary stays served". |
| Uma lista antiga ou adulterada nunca desfaz a ocultação | `packages/core/test/blocklist.test.js`, "acceptHiddenList: an older or tampered list never undoes a hide" (seq anterior, mesmo seq com outro conteúdo, assinatura errada, certificado de moderação mais novo) e "createBlocklistState: the hidden-posts list is adopted apart from the snapshot"; o último passo do teste do navegador. |
| `mod unhide` traz a publicação de volta, com trilha | `apps/cli/test/mod.test.js`, "mod hide and unhide sign a hidden-posts list of their own, with audit lines" (linhas `hide` e `unhide` em `moderation.jsonl`, com `post`); `blocklist-member.test.js`, "... an unhidden post comes back"; `blocklist-seeder-media.test.js`, "an unhide serves the media again on the next serve". |
| O semeador não serve a publicação nem a devolve nos índices | `blocklist-seeder.test.js` (os bytes são apagados, o `seq` ainda não guardado nunca é buscado, vale depois de reiniciar; com `noClear`, `postBlock` e `_liveRecord` a tratam como não guardada); `blocklist-seeder-media.test.js` (fotos, prévias e capas que só ela mostra são recusadas e apagadas, também depois de reiniciar); `apps/cli/test/seeder-push.test.js`, "push: a reply hidden before its push pass emits nothing". |
| Uma chave de moderação substituída não assina mais nenhuma das duas listas | `blocklist.test.js`, "createBlocklistState: one moderator certificate floor for both lists" (nos dois sentidos; a lista já guardada fica); `mod.test.js`, "after a rotation the stored list of the other kind is re-signed under the new certificate" (`mod hide` reassina a lista de bloqueio, `mod block --json` reassina a de ocultas, sem linha de auditoria, e um nó com a lista nova adota a reassinada); `mod-apply.test.js`, "after a rotation apply publishes the re-signed hidden-posts list right after the snapshot..." (sem confirmação de entrega das duas, nada é confirmado ao painel; a nova tentativa reenvia as duas e só então confirma); "after a failed channel 2 publish, an apply with a new decision still sends the re-signed hidden-posts list before the ack" (com uma decisão nova antes da nova tentativa, a lista de ocultas guardada vai logo depois da lista de bloqueio nova). |
| Testes de formato, de recusa de lista antiga, do semeador e do navegador | Tabela abaixo. |

## Formato e compatibilidade

- Carga assinada com o prefixo `varanda-hidden-posts-v1` e 8 chaves; vetor dourado em `packages/core/test/blocklist.test.js` e no `docs/protocol.md`.
- A maior lista (512 referências) tem 43511 bytes e a mensagem dela no canal 2, 43542 bytes, abaixo de `MAX_HIDDEN_BYTES` (49152) e de `MAX_HIDDEN_MESSAGE` (65536) (teste "hidden-posts size").
- A lista de bloqueio e o canal 1 não mudam. Um par de versão anterior recusa o canal 2; o canal 1 e a conexão continuam (`blocklist-net.test.js`, "a peer with channel 1 only: channel 2 resolves unsupported, channel 1 and the socket stay").
- Com um semeador de versão anterior, `mod hide` sai com código 1 e a lista fica gravada para `mod publish` (`mod.test.js`, "a seeder without the hidden-posts channel"), e o nó do navegador termina a sincronização e recebe a lista de bloqueio (`web-member/test/blocklist.test.js`, "a seeder with no hidden-posts channel still settles a once run and hands over the blocklist").

## Testes

| Arquivo | O que cobre |
| --- | --- |
| `packages/core/test/blocklist.test.js` | vetor dourado, `createHiddenList`, recusas de `verifyHiddenList`, tamanho, lista antiga ou adulterada, `createBlocklistState` com as duas listas, `hiddenPostMap` e afins |
| `packages/core/test/blocklist-net.test.js` | canal 2 ao lado do canal 1, par só com o canal 1, mensagem acima de `MAX_HIDDEN_MESSAGE` |
| `packages/core/test/blocklist-member.test.js` | nó da linha de comando: leitura sem a publicação, a do autor continua, réplica que apaga e não busca de novo, sincronização a partir de um semeador que nunca a guardou |
| `packages/core/test/blocklist-seeder.test.js` | semeador: apagada e fora dos índices, durante a execução e depois de reiniciar; `noClear`; um `seq` listado que guarda outro registro não é apagado |
| `packages/core/test/blocklist-seeder-media.test.js` (novo) | mídia da publicação oculta: recusada e apagada, prévia e capa escritas depois, lista adotada antes do diário, reinício, `noClear`, `mod unhide`, `seeder recount` |
| `packages/core/test/deletion.test.js` | o caminho do presente passa o buraco de uma publicação oculta; `clearDeleted` só apaga o `seq` listado como publicação |
| `packages/core/test/feed.test.js`, `peek.test.js` | `buildFeed` e `diaryPeek` sem a publicação oculta e as republicações dela |
| `packages/web-member/test/blocklist.test.js` | nó do navegador: `feed.read` e `log.read`, também com `noClear` (só o filtro de leitura esconde a publicação guardada), semeador sem o canal 2, réplica que apaga, aparelho novo do autor, `trackPresent` |
| `apps/cli/test/mod.test.js` | `mod hide` e `mod unhide`, publicação no canal 2, `mod publish` com as duas listas, semeador sem o canal 2, reassinatura da outra lista depois de trocar a chave |
| `apps/cli/test/seeder-push.test.js` | resposta oculta antes da passagem de push não gera aviso |
| `apps/cli/test/cli.test.js`, `readme-help.test.js` | a linha nova da ajuda igual no `HELP` e no README |
| `packages/core/test/seeder-delete.test.js`, `seeder-link-public.test.js`, `seeder-post-public.test.js`, `apps/cli/test/seeder-index.test.js` | as fixtures de semeador montadas à mão ganharam o estado das publicações ocultas |

## Regressão

Cada parte da correção foi tirada numa cópia do arquivo, carregada no lugar do original por um hook de `require` (o disco ficou intacto), e o teste da área rodou contra ela:

| Sem | Resultado |
| --- | --- |
| o piso de certificado comum às duas listas (`belowFloor` em `createBlocklistState`) | `blocklist.test.js`: "createBlocklistState: one moderator certificate floor for both lists" falhou (4 asserções) |
| a publicação da lista reassinada em `mod apply` (`applySet`) | `mod-apply.test.js`: o teste da troca de chave falhou (só a lista de bloqueio foi publicada) |
| o espaço para um ouvinte de `close` a mais do canal 2 (`packages/core/lib/blocklist-net.js`) | `apps/cli/test/seed-ws.test.js`: "seed --ws-port: a member over a WebSocket is admitted..." falhou com o aviso `MaxListenersExceededWarning` no stderr do semeador |
| o reenvio da lista de ocultas na nova tentativa de `mod apply` (`publishOrFail`) | `mod-apply.test.js`: o mesmo teste falhou na segunda execução (só a lista de bloqueio foi reenviada) |
| o envio da lista de ocultas guardada quando `mod apply` assina uma decisão nova sem reassinar nada (`applySet`) | `mod-apply.test.js`: "after a failed channel 2 publish, an apply with a new decision..." falhou (só a lista de bloqueio nova foi publicada antes da confirmação) |
| a regra de ordem de `acceptWith` (`packages/core/lib/blocklist.js`, lista mais antiga aceita) | `blocklist.test.js`: 4 testes falharam, entre eles "acceptHiddenList: an older or tampered list never undoes a hide" |
| o filtro de leitura do nó da linha de comando (`packages/core/lib/member.js`) | `blocklist-member.test.js`: 2 testes falharam ("a hidden post leaves log.read and feed.read of followers, not of its author" e o da sincronização a partir de um semeador que nunca guardou a publicação) |
| o filtro de leitura do nó do navegador (`packages/web-member/lib/member-ops.js`) | `web-member/test/blocklist.test.js`: o teste novo com `noClear` falhou em "the hidden post left the feed" e "log.read leaves the hidden post out". Nos outros testes a limpeza da sincronização já esconde a publicação |
| a limpeza da sincronização do navegador (`packages/web-member/lib/sync.js`, `trackPresent`) | os 2 testes de `trackPresent` falharam; sem ela e sem o filtro de leitura, o teste de `feed.read` e `log.read` também falhou |
| a regra de limpeza só de publicações no semeador (`_hiddenClearRule`) | `blocklist-seeder.test.js`: "a listed seq holding no post keeps its bytes" falhou (um `follow` num `seq` listado foi apagado) |
| `_hidePosts` no semeador (`packages/core/lib/seeder.js`) | `blocklist-seeder.test.js`: "a hidden post is cleared and dropped from the indexes" esgotou o tempo em "post 2 oculto" |
| cada parte da recusa de mídia no semeador (início do serviço, contagem do `seeder recount`, `keepHiddenMedia`, ocultação depois da varredura, `hidesMedia`), uma de cada vez e todas juntas | com cada variante, pelo menos um teste de `blocklist-seeder-media.test.js` falhou, e cada um dos 7 testes, rodando sozinho, falhou com pelo menos uma variante; com a correção, os 7 passaram (93 asserções). Rodado antes do merge da `main`, que não mexeu nessas partes |

## Resultados locais

No código final, a partir de `origin/main@524493298`: `npm run lint` passou; os 238 arquivos de teste alterados ou que importam um módulo alterado (apps/app, apps/cli, packages/core, packages/rpc e packages/web-member) passaram; `npm run demo` terminou com "DEMO OK". Numa execução anterior, `packages/core/test/seeder-relay.test.js` (arquivo não alterado) falhou uma vez por carga ("never over the cap") e passou sozinho (6/6). A suíte inteira roda na CI do GitHub.

## Limites

- No semeador, `mod unhide` só vale na próxima vez que ele serve o diário (um reinício): o conjunto de blocos excluídos de um diário servido nunca diminui.
- Uma publicação listada que o semeador nunca guardou, sem nada mantido de uma execução anterior, tem fotos que ninguém ali conhece: essas não são recusadas (a prévia e a capa são).
- Num diário cuja mídia os contadores não conseguem seguir (`mediaIrregular`), o semeador recusa só a mídia apagada por lápide, não a de publicações ocultas.
- Um semeador que perdeu a lista pode buscar publicações ocultas de novo até receber a mais nova de um par.
- O aparelho de quem escreveu continua guardando a publicação e pode servir esse bloco a um par que o peça.
- Um nó de versão anterior nunca abre o canal 2: continua mostrando a publicação se já a guardava ou se a recebe do aparelho de quem escreveu; se só sincroniza com um semeador que já a apagou, o caminho do presente da `main` para no buraco dela, e o nó não mostra o que aquele diário publicou depois até atualizar. Por isso o semeador precisa atualizar antes do primeiro `mod hide`, e o app e o PWA logo depois.
- Um `seq` listado que o nó ou o semeador ainda não guarda nunca é buscado, seja qual for o registro: a lista é assinada pela moderação, que só deve listar publicações.
- Um nó que ainda não guarda nenhuma das duas listas aceita uma lista assinada por uma chave de moderação já substituída, até receber a da chave nova. Depois de trocar a chave, um comando que muda uma lista no diretório novo publica as duas com a chave nova.
- Sem conferência em aparelho: a mudança não toca em telas do app, que lê pelos métodos do nó cobertos acima (`feed.read`, `log.read`, `peek.read`, `diary.peek`, avisos).
