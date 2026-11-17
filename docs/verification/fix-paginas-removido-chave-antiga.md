# Administrador removido perde também a chave antiga (PR `fix/paginas-removido-chave-antiga`)

Data: 2026-11-17.

No laboratório web, o dono de uma Página que tinha mudado de chave (K1 para K2) removeu o administrador B da K2. Nos aparelhos de B, a K2 saiu de Páginas, mas a K1 continuou listada como "encerrada", com a caixa "Chave antiga" das Conversas: o serviço de conta listava a K1 para B porque B continuava no roster congelado da K1. Decisão da manutenção (2026-11-17): quem é removido da chave viva perde também a chave antiga, como numa Página que nunca mudou de chave.

## O que mudou

- Serviço de conta (`apps/cli/lib/account/pages-store.js`): o papel de alguém numa linha que mudou de chave só vale enquanto essa pessoa ainda é dona ou administradora da linha do fim da cadeia de mudanças (`movedTo` seguido até uma chave que não mudou, no máximo `MAX_PAGE_MOVES` saltos; uma ponta encerrada mantém o seu roster). `role`, `authorize` e `listFor` seguem essa regra. Uma cadeia quebrada ou longa demais não dá papel a ninguém.
- Rotas (`apps/cli/lib/account/pages-routes.js`): as leituras assinadas `status` e `follows`, as únicas que aceitam uma linha que mudou de chave, conferem o papel pelo `role` do armazenamento. Quem foi removido da K2 recebe `sem-permissao` na K1.
- App (`apps/app/src/pages.js`, `pagesList`): ao esquecer uma Página que a lista não mostra mais, o app também esquece, quando a lista não as mostra, as chaves de que ela veio (cadeia `movedFrom` lida com `page.read`, `apps/app/src/pageOldKeys.js`). Sem isso, depois de reabrir o app, a K1 nunca era esquecida: nenhuma resposta anterior a nomeava, e a chave de mensagens publicada na K1 não muda, então o nó não a marca. A cadeia é lida antes de a Página sair do aparelho: se uma leitura falha (sem rede, tempo esgotado, nó travado), nada da cadeia é esquecido nem dado como tentado, e a próxima leitura da lista tenta de novo; a K2 continua marcada pelo nó, então isso vale também depois de reabrir o app. Antes de esquecer, o app confere a lista mais nova (quem foi adicionado de volta fica com as chaves). Uma Página só encerrada, sem mudança, não faz leitura de cadeia. O nó core não guarda chaves de página e não lê cadeia.
- `docs/protocol.md`, "Mudar de chave": a regra. Nenhuma forma de resposta muda, então `docs/rpc.md` fica como está. Os Termos (linha "Um administrador removido continua com o que já leu") não mudam: apagar no aparelho é melhor esforço.

## Caminhos do serviço conferidos

- `list`: segue a regra (corrigido).
- `status` e `follows` da K1: seguem a regra (corrigido).
- Escritas, envio de mídia e avatar, convite, aceite, remoção, oferta, encerrar e mudar: passam por `writableRow` ou `ownerRow`, que recusam uma linha movida com `movida`. Sem mudança.
- Conversas como página (`dm-*`, inclusive o pacote antigo `dm-legacy-read` e `dm-legacy-done`): `dmRow` e `writableRow` recusam a linha movida; a mudança apaga o `dm` da K1 e leva o pacote antigo para a K2. Sem mudança.
- Avisos (`notices`), grupos e comunidades como página: recusam a linha movida. Sem mudança.
- `GET /account/pages/successor/<K1>`: público, sem sessão, responde só o `page-moved` contra-assinado. Sem mudança.
- `delete-routes.js` (exclusão de conta) e o limite de páginas na criação contam só páginas vivas. Sem mudança.

## Testes automáticos

- `apps/cli/test/pages-store.test.js`: `an admin removed from the live key loses the old keys too` (depois da mudança e da remoção de B da K2, `listFor(B)` não traz nem K1 nem K2, `role` e `authorize` recusam B na K1, o dono e quem continua administrador ainda veem a K1 como movida, o mesmo depois de reabrir o arquivo; uma segunda mudança K2 para K3 com remoção na K3 tira K1 e K2; quem foi removido antes da mudança continua fora) e `a closed end of the move chain keeps its roster for the old keys`.
- `apps/cli/test/pages-lifecycle.test.js`: `an admin removed from K2 after a move gets nothing of K1` (pelas rotas, com a remoção assinada pelo dono: `list` de B vazio, `status` e `follows` da K1 com `sem-permissao` para B; o administrador que ficou e o dono leem a K1).
- `apps/cli/test/pages-store.test.js`: `a move chain whose end row is missing, or that loops, counts no old roster` (sem a linha do fim, ou com um laço, ninguém tem papel na K1: falha fechada).
- `apps/cli/test/pages-lifecycle.test.js`, no mesmo teste: `notices` da K1 responde `movida` e o da K2 `sem-permissao` para B. `apps/cli/test/pages-dm.test.js`: `an admin removed from K2 after a move gets movida from the dm reads of K1` (`dm-box-read` e `dm-legacy-read` da K1 respondem `movida`, os da K2 `sem-permissao`). Essas recusas já existiam: os testes só as fixam.
- `apps/app/test/pages.test.js`: `pagesList also forgets the keys a dropped page moved from, unless the list still shows them` (sem resposta anterior, só a marca do nó nomeando a K2: K2, K1 e K0 são esquecidas; uma chave antiga que a lista ainda mostra como movida fica; uma Página só encerrada sai sem leitura de cadeia), `a failed read of the move chain marks nothing tried, and a later list read forgets the old keys`, `a newer list that shows the keys again keeps them when an earlier walk lands` e `walks no move chain on a core node or a malformed answer`.
- Prova de regressão, executada localmente: sem a correção de `pages-store.js`, os dois testes novos do armazenamento falham (41 de 43 testes, 332 de 347 asserções); sem a de `pages-routes.js`, o teste das rotas falha nas leituras `status` e `follows`; sem as duas, falha também a lista (7 de 8 testes, 115 de 118 asserções); sem a de `pages.js` e `pageOldKeys.js`, três testes do app falham (84 de 87 testes, 736 de 741 asserções), e o mesmo com a primeira versão desta correção, que esquecia a K2 antes de ler a cadeia. As asserções de `notices`, `dm-box-read` e `dm-legacy-read` e o teste do nó core e da resposta malformada passam também sem a correção.

## Como verificar à mão

No laboratório, com uma Página de dono A e administradores B e C: A muda a Página de chave, depois remove B da chave nova. Em B: Páginas não mostra nenhuma das duas chaves, e as Conversas da chave antiga somem desse aparelho. Em C e em A: a chave antiga continua em Páginas como encerrada e a caixa "Chave antiga" continua nas Conversas da chave nova.

Conferência em aparelho (não conferido em aparelho):

- [ ] Android: B, com o app aberto durante a remoção, perde as duas chaves em Páginas e a caixa "Chave antiga".
- [ ] Android: B, com o app fechado durante a remoção, abre o app, espera uma sincronização e abre Páginas: as duas chaves somem e as conversas da chave antiga saem do aparelho.
- [ ] Android: C e A continuam com a chave antiga só para ler.
- [ ] iOS: os mesmos três casos.
- [ ] Web (navegador e PWA): os mesmos três casos.

## Limites conhecidos

- Um aparelho que já tinha esquecido a K2 numa sessão anterior a esta correção (quando o serviço ainda listava a K1) e que reabre o app depois do deploy guarda as chaves e as conversas da K1 sem mostrá-las: nada mais nomeia a K1 para o app. Com o app aberto na hora do deploy, a próxima leitura de Páginas a esquece.
- Enquanto a leitura da cadeia falhar, a K2 também fica no aparelho (sem aparecer em Páginas), até uma leitura da lista em que a cadeia seja lida.
- O app confia na cadeia `movedFrom` que o `page.read` devolve para saber o que esquecer; um serviço de conta malicioso poderia apontá-la para outras chaves. Uma chave que a lista mais nova mostra nunca é esquecida.
