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
- App novo diante de um semeador antigo (404 nas rotas `/index/discover/*`): a busca diz "A busca ainda não está disponível." e nenhuma lista de Descobrir aparece. A caixa de grupos públicos do perfil fica vazia, e a folha "Grupos públicos no perfil", em Ajustes, mostra "Não foi possível ler agora." com "Tentar de novo": a chave não muda ali até o semeador ser atualizado.
- Títulos com a busca vazia: "Comunidades" acima das listas de comunidades e "Grupos" acima das listas de grupos, cada título só quando há ao menos uma lista dele embaixo; os dois "Mais membros" ficam distinguíveis.
- Agindo como Página: Descobrir mostra só comunidades, sem listas de grupos, sem o título "Grupos" e sem resultados de grupo na busca.
- Ordem de publicação: o PR1 (#878) e o PR2 (#879) precisam estar nos semeadores antes de publicar este app.
- Termos 110: um app instalado na versão 109 não abre a sessão da conta até ser atualizado.
- Bloqueio na busca: bloquear quem criou uma comunidade pública, buscar o nome dela: ela não aparece.

## Cliente do índice, Termos e listas (T22, T23, T25)

- `apps/app/test/indexClient.test.js`: `fetchDiscoverGroups`, `fetchDiscoverCommunities`, `fetchDiscoverSearch` e `fetchStandaloneGroupsOf` conferem cada resposta com validadores de chaves exatas (campos, tetos, ordem, cursor `next` só numa página cheia de 32 na lista por diário, resultados repetidos entre as duas listas da busca recusados). A lista "Em alta" de grupos só conta grupos com pelo menos 2 membros ativos; a ordem antiga das rotas legadas não mudou. Seis mutações nos validadores fazem testes falharem.
- Termos 110 (`packages/core/lib/terms.js`, `apps/app/src/legal.js`, data 23/11/2026): `packages/core/test/terms.test.js`, `apps/app/test/legal.test.js` e `apps/site/test/legal.test.js` passam; as páginas do site foram geradas de novo pelo script e `--check` confere. O texto descreve as listas de comunidades "Mais membros" e "Criadas recentemente" (no máximo 2 comunidades por pessoa) e a ordem da busca. `docs/design.md` acompanha.
- Listas e caixa do perfil: `groupShelves`, `comunidadesShelves`, `groupShelfUi`, `communityShelfUi` (novo), `groupFanOut`, `publicGroupsBoxScreen` e `gruposNoPerfil` passam. As listas de grupos leem só as rotas novas; as de comunidades vêm de `fetchDiscoverCommunities`; a caixa do perfil, a lista de quem você segue e a chave de Ajustes leem `fetchStandaloneGroupsOf`. Quando as cinco rotas novas respondem 404, nenhuma lista aparece. Oito mutações fazem testes falharem.

## Vitrine (T24)

- `apps/app/src/vitrine/indexResponder.js` responde às quatro rotas `/index/discover/*` com o mesmo formato do semeador, e cada resposta passa pelos validadores estritos do cliente, com tetos e cursores. Grupos de comunidade e privados ficam de fora; como no semeador, um grupo público com aprovação aparece em "Mais membros", "Criados recentemente" e na busca, mas não em "Em alta" nem na lista por diário; com a opção de esconder os grupos do perfil, a lista por diário some.
- `test/vitrineIndex.test.js` (40 testes), `test/vitrineLarge.test.js` (14) e `test/vitrine.test.js` (69) passam. A chamada que lia `fetchGroupSearch`, removido do cliente, agora lê `fetchDiscoverSearch`. 37 mutações no responder fazem testes falharem.

## Bloqueios na busca e fotos de comunidades

A busca `/index/discover/search` passou a levar o `creator` (o diário da raiz) nos resultados de grupo e de comunidade, e o app tira da busca os resultados cuja chave ou cujo criador a pessoa bloqueou, como já fazia nas listas. Enquanto a lista de bloqueios não foi lida, a busca fica em "Buscando…"; se a leitura falha, aparece "Não foi possível buscar agora." com "Tentar de novo", nunca resultados sem filtro. Nenhuma foto é pedida para um resultado bloqueado. Um resultado de comunidade que o nó tem (community.list) mostra a foto do nó, ou nenhuma, e não pede ao índice; enquanto essa lista não foi lida, nenhuma foto de comunidade é pedida.

- `packages/core/test/group-index-discover.test.js` (6 testes, 83 asserções): um teste novo, o criador certo nos dois tipos de resultado.
- `packages/core/test/seeder-discover.test.js` (3 testes, 86 asserções): a resposta da busca traz o criador.
- `apps/cli/test/seed-ws.test.js` (120 testes, 3047 asserções): a rota devolve o criador e um criador ausente, nulo ou fora de hex64 vira o 404 genérico.
- `apps/app/test/indexClient.test.js` (94 testes, 2009 asserções): `validDiscoverSearch` exige o criador hex64 com chaves exatas; `validGroupSearch` (legado) segue recusando o campo.
- `apps/app/test/vitrineIndex.test.js` (40 testes, 2215 asserções): a Vitrine responde o criador da raiz.
- `apps/app/test/comunidadesRow.test.js` (46 testes, 426 asserções): três testes novos (bloqueios fora das seções e dos pedidos de foto, também depois de um bloqueio novo; espera e erro da lista de bloqueios; fotos de comunidades conciliadas com community.list).

Conferência por mutação (cada uma falha o teste indicado; os arquivos foram restaurados):

- Sem o criador em `discoverSearch` do índice: falham três testes de `group-index-discover` e um de `seeder-discover`.
- Sem o criador no corpo da rota: falham três testes de `seed-ws`.
- Validador sem conferir o criador (grupo ou comunidade), sem copiá-lo ou com as chaves antigas: falha o teste de `validDiscoverSearch`.
- Vitrine sem o criador: falham dois testes de `vitrineIndex`.
- Busca sem filtrar grupos ou comunidades: falha "blocked keys and creators leave the search".
- Resultados mostrados com a lista de bloqueios pendente ou com falha: falha "no search result shows while the block list is loading".
- Comunidade sem conciliação, ou conciliada com a lista ainda não lida: falha "a community hit the node holds".
- Tela usando a busca crua: falha a conferência do código em "search image requests".
- Linha de Página sem campo de foto, ou linha pendente, tratada como resposta do nó (a foto do índice some): falham duas asserções de "a community hit the node holds". Essas linhas mantêm a foto do índice.

## Vitrine com aprovação, títulos de Descobrir e Página

- Vitrine: `standaloneListed` segue o semeador. "Mais membros", "Criados recentemente" e a busca listam qualquer grupo público sem comunidade, com aprovação também (o "Coral da praça" aparece); "Em alta" e a lista por diário só os de entrada aberta. `test/vitrineIndex.test.js` (40 testes, 2215 asserções) passou a esperar isso. Mutações: exigir entrada aberta em todas as rotas, aceitar aprovação em "Em alta" ou aceitar aprovação na lista por diário fazem testes falharem.
- Com a busca vazia, os títulos "Comunidades" e "Grupos" (o mesmo `SectionHeader` dos resultados da busca, com papel de cabeçalho) ficam acima das listas de cada tipo, só quando há lista embaixo. Agindo como Página, Descobrir não mostra listas de grupos nem resultados de grupo na busca, e nenhuma foto de grupo é pedida (`shownGroupShelves` e `shownSearch` com `groups` falso).
- `test/comunidadesRow.test.js` (48 testes, 436 asserções): dois testes novos. Mutações: tirar o título "Comunidades" ou "Grupos" falha o teste dos títulos; mostrar as listas de grupos ou os resultados de grupo a uma Página, na função ou na tela, falha o teste da Página.
