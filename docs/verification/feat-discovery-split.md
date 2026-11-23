# Descobrir: comunidades e grupos sem comunidade (`feat/discovery-split`)

## Testes automáticos

Rodados em `apps/app` com `node ../../scripts/run-tests.js <arquivo>`, um arquivo por vez ou em grupo:

- `test/comunidadesRow.test.js` (39 testes antes, 43 depois): quatro testes novos. A busca mostra Comunidades e depois Grupos, cada lista com o próprio aviso de mais resultados, e cada resultado abre a tela certa; um 404 da busca diz "A busca ainda não está disponível." e outra falha continua com "Tentar de novo"; com a busca vazia, as listas de comunidades vêm antes das de grupos. O harness da busca passou a injetar `fetchDiscoverSearch`. Um resultado de comunidade mostra a foto que o índice tem para ela, pedida uma vez e numa página só de comunidades.
- `test/indexClient.test.js`: 96 testes antes, 94 depois. Saíram os testes de `fetchGroupBrowse` e `fetchPublicGroups`, removidos do cliente; o teste de `fetchGroupSearch` virou teste de `validGroupSearch` (o validador fica para a Vitrine), com os mesmos casos ruins.
- `test/comunidadesShelves.test.js`: a nota de lista incompleta das comunidades fala de comunidades, não de grupos.
- `test/conversasList.test.js`, `test/chatSurfaces.test.js` e `test/group-flow.test.js`: acompanham o rótulo novo da busca, o texto vazio novo e o fim do "na comunidade" nos resultados.
- `test/newGroup.test.js` e `test/help.test.js`: a ajuda de **Grupo sem comunidade** volta a dizer que um grupo público sem comunidade aparece em Descobrir, em Grupos.
- Também passam: `test/platformGate.test.js`, `test/communityShelfUi.test.js`, `test/groupShelfUi.test.js`, `test/groupShelves.test.js` e os outros arquivos que leem `Comunidades.js`, `indexClient.js`, `newGroup.js` ou `help.js`.

Conferência por mutação (cada uma falha só o teste novo correspondente, e o arquivo foi restaurado depois):

- Grupos antes de Comunidades em `searchSections`: falha "search shows Comunidades then Grupos".
- Todo resultado abrindo o grupo: falha o mesmo teste.
- 404 tratado como falha comum: falha "a 404 from the discover search".
- Listas de grupos antes das de comunidades: falha "an empty query shows the community shelves before the group shelves".
- Resultado de comunidade lendo as fotos dos grupos: falham as duas conferências do código da busca em "group and community surfaces" e "search image requests".

## Conferências manuais pendentes

Primeiro no Android (build de debug) e no simulador iOS, depois na web, no PWA e na Vitrine:

- Descobrir com a busca vazia: as listas de Comunidades vêm antes das de Grupos; nenhum grupo de comunidade aparece nas listas de Grupos; tocar numa comunidade abre a comunidade, tocar num grupo abre o grupo.
- Busca: "Buscar comunidades e grupos" responde em duas listas com título, Comunidades e depois Grupos, cada uma com o aviso de mais resultados quando há; sem resultado aparece "Nenhuma comunidade ou grupo público encontrado.".
- Caixa de grupos públicos do perfil: só grupos públicos de entrada aberta e sem comunidade; com "Grupos públicos no perfil" desligado em Ajustes, a caixa some.
- Um grupo de comunidade nunca aparece fora da comunidade: nem nas listas, nem na busca, nem na caixa do perfil.
- App antigo diante do semeador novo (com o #882): as rotas antigas respondem listas vazias, então Descobrir e a caixa do perfil ficam vazios até o app ser atualizado; o resto do app funciona.
- App novo diante de um semeador antigo (404 nas rotas `/index/discover/*`): a busca diz "A busca ainda não está disponível." e nenhuma lista de Descobrir aparece.
- Ordem de publicação: o PR1 (#878) e o PR2 (#879) precisam estar nos semeadores antes de publicar este app.
- Termos 110: um app instalado na versão 109 não abre a sessão da conta até ser atualizado.

## Cliente do índice, Termos e listas (T22, T23, T25)

- `apps/app/test/indexClient.test.js`: `fetchDiscoverGroups`, `fetchDiscoverCommunities`, `fetchDiscoverSearch` e `fetchStandaloneGroupsOf` conferem cada resposta com validadores de chaves exatas (campos, tetos, ordem, cursor `next` só numa página cheia de 32 na lista por diário, resultados repetidos entre as duas listas da busca recusados). A lista "Em alta" de grupos só conta grupos com pelo menos 2 membros ativos; a ordem antiga das rotas legadas não mudou. Seis mutações nos validadores fazem testes falharem.
- Termos 110 (`packages/core/lib/terms.js`, `apps/app/src/legal.js`, data 23/11/2026): `packages/core/test/terms.test.js`, `apps/app/test/legal.test.js` e `apps/site/test/legal.test.js` passam; as páginas do site foram geradas de novo pelo script e `--check` confere. O texto descreve as listas de comunidades "Mais membros" e "Criadas recentemente" (no máximo 2 comunidades por pessoa) e a ordem da busca. `docs/design.md` acompanha.
- Listas e caixa do perfil: `groupShelves`, `comunidadesShelves`, `groupShelfUi`, `communityShelfUi` (novo), `groupFanOut`, `publicGroupsBoxScreen` e `gruposNoPerfil` passam. As listas de grupos leem só as rotas novas; as de comunidades vêm de `fetchDiscoverCommunities`; a caixa do perfil, a lista de quem você segue e a chave de Ajustes leem `fetchStandaloneGroupsOf`. Quando as cinco rotas novas respondem 404, nenhuma lista aparece. Oito mutações fazem testes falharem.

## Vitrine (T24)

- `apps/app/src/vitrine/indexResponder.js` responde às quatro rotas `/index/discover/*` com o mesmo formato do semeador, e cada resposta passa pelos validadores estritos do cliente, com tetos e cursores. Grupos de comunidade, privados e com aprovação ficam de fora; com a opção de esconder os grupos do perfil, a lista por diário some.
- `test/vitrineIndex.test.js` (40 testes), `test/vitrineLarge.test.js` (14) e `test/vitrine.test.js` (69) passam. A chamada que lia `fetchGroupSearch`, removido do cliente, agora lê `fetchDiscoverSearch`. 37 mutações no responder fazem testes falharem.
