# feat/core-pagina-grupos-privados

Parte de #352 (PR 7), sobre a PR 5 (feat/core-conversas-pagina). Uma Página nos grupos privados pelo nó core, só texto. Sem mudança nos Termos.

## O que mudou

- `packages/core/lib/member.js`: `loadGroup` aceita `as: { page, box }` e dobra o grupo como a Página, com a caixa de grupo dela no lugar da caixa do aparelho (os escritores dela são os do diário da Página cujo cabeçalho tem essa caixa; o aparelho não tem escritor ali). Novas: `pageGroupRead`, `pageGroupNoKey`, `pageGroupSeal` e `pageGroupRoots`, com `withPageGroup`, `pageLiveWriter` e `pageKeyState` portados de `packages/web-member/lib/member-ops.js`. A cópia da caixa é zerada ao fim, aconteça o que acontecer, e as chaves de época abertas ficam só no resultado da dobra, apagadas depois. `groupRead` passa a usar `readFold`, sem mudança de resultado.
- `packages/web-member/lib/core-dm.js`: `withPageGroupBox(page, fn)` (roda `fn(take)` na fila do motor, então um `dm.pageForget` fica todo antes ou todo depois; `take()` dá uma cópia da caixa de grupo, nunca pelo RPC) e `heldPages()` (síncrona, fora da fila da sessão). Depois de destravar, adotar (`dm.pageSecrets`) ou esquecer (`dm.pageForget`) uma Página, chama `ops.pagesChanged`.
- `packages/core/lib/session.js`: com a fábrica `dm`, `group.read` com `page` e `group.seal` dobram dentro de `withPageGroupBox`, e a cópia da caixa só é tirada quando a vez da dobra chegou na fila e a rodada parou (uma suspensão antes disso não guarda cópia). `ops.pagesChanged` reinicia a rodada contínua quando a lista de Páginas guardadas mudou (a rodada iniciada antes do destravamento tinha lista vazia). Sem as chaves da Página, a leitura responde o estado `no-key` com a visibilidade do cabeçalho e o lacre responde `USAGE` `'sem chave da página'`. `media` ou `card` no `group.seal`: `USAGE` `'mídia disponível só na versão web'` antes de pedir a caixa. `marks` e `topic` com `page`: `USAGE` `'leitura sob demanda só na versão web'`. Sem a fábrica, as duas recusas ficam iguais. A rodada de sincronização recebe `pages`.
- `packages/core/lib/sync.js`: opção `pages`. `storedPageRoots` (a mesma usada por `member.pageGroupRoots`) lê as raízes que o diário guardado de cada Página liga (`group-join` vivos), julgando o diário como um seguido (bloqueio, fork, certificado, emissor revogado), e fecha toda réplica que abre. Elas entram como grupos locais sem escritor próprio (`writer: null`), fora dos bloqueados, e cada uma é paginada pelo tipo que o cabeçalho da raiz verificado diz (`community` ou `group`, como o navegador; papel `any` até saber): a comunidade de uma Página vira pai, sem `header-invalid`.
- As raízes das Páginas são lidas uma vez por rodada. Destravar, adotar ou esquecer uma Página reinicia a rodada contínua; um `group-join` novo que chega ao diário da Página no meio de uma rodada só conta na rodada seguinte.
- As regras de troca de chave (`packages/core/lib/group-rekey.js`) não mudaram: nenhuma repetição automática nova.
- Docs: `docs/rpc.md` (Conversas no core e 5.114), `docs/protocol.md` ("Comunidades como página").

## Regressão

Antes desta mudança, num nó core, `group.read` com `page` respondia `USAGE` `'mensagens diretas disponíveis só no navegador'`. A linha nova de `packages/core/test/dm-session-refuse.test.js` (`['group.read', { group: KEY, page: KEY }, DM_NO]`) registra isso numa sessão sem a fábrica, caminho que esta mudança não toca: `ok 24 - group.read` nos dois testes do arquivo (2/2, 56 asserções).

## Testes

Cada arquivo rodou sozinho (`node <arquivo>`, Node 24.22.1, DHT local e `tmpDir`):

- `packages/core/test/page-groups-core.test.js` (novo): 11/11, 60 asserções, 27 s sozinho (100 s com outros testes rodando na máquina). Um nó administrador lê o grupo privado como a Página e lacra para o escritor dela; o envelope, acrescentado como o serviço faria, abre na dobra de quem criou o grupo e na dobra da Página; um post lacrado por outro membro abre na dobra da Página; outra caixa não dobra nada; raiz ausente é `NOT_FOUND`; depois de uma troca de caixa o estado é `rekey-pending` e o lacre espera (`'aguardando nova chave'`) até uma nova época, e a caixa antiga não lacra; pela sessão: leitura e lacre com a fábrica, `no-key` e `'sem chave da página'` sem as chaves, mídia e cartão recusados sem pedir a caixa; `pageGroupRoots` acha as raízes do diário guardado da Página; a cópia da caixa é zerada também quando o lacre falha e na sessão; a rodada contínua reinicia quando as Páginas guardadas mudam (falha sem `pagesChanged`: `tempo esgotado: restart`); um delegado core fora da comunidade sincroniza (`runSync` com `pages`, semeador real) as raízes da Página e dobra o grupo com estado `ok` e lacra (falha sem a classificação pelo cabeçalho: a raiz da comunidade é recusada e o estado fica em espera de chave; falha sem a guarda `writer !== null`: `TypeError`).
- `packages/core/test/dm-session-refuse.test.js`: 2/2, 56 asserções.
- `packages/core/test/private-member.test.js`: 5/5, 115 asserções.
- `packages/web-member/test/core-page-groups-e2e.test.js` (novo): 1/1, 10 asserções, 16 s. Um administrador no navegador e um no core com o motor real adotam as chaves da Página; o post lacrado no navegador abre no core (`group.read` com `page`) e o lacrado no core (`group.seal`) abre no navegador.
- `packages/web-member/test/core-dm-e2e.test.js`: 9/9, 70 asserções, 51 s. Com uma semente corrompida, `group.seal` e `group.read` com `page` agora chegam ao motor e respondem `'arquivo das Conversas corrompido neste aparelho'` (antes: recusa do navegador).
- `packages/web-member/test/page-groups.test.js` 7/7 (60), `page-groups-sync.test.js` 3/3 (26), `page-group-roots-e2e.test.js` 1/1 (14), sem mudança.
- `npx standard` nos arquivos tocados.

## Não verificado

- O reinício por `pagesChanged` é conferido pela sessão com uma fábrica falsa (nova rodada com a lista nova), não com um destravamento real seguido de dobra.
