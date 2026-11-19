# Escolha de mostrar os grupos públicos no perfil

O primeiro teste de `packages/core/test/seeder-group-browse.test.js` usa a varredura de engajamento do semeador com blocos em memória. Antes da leitura de `on: false`, o grupo aparece com `complete: false`. Depois da leitura, a resposta traz `hidden: true`, lista vazia e cursor nulo. Enquanto o registro seguinte, `on: true`, aguarda leitura, a lista continua oculta e incompleta. Ao ler esse registro, o grupo volta à lista.

O teste com a DHT local grava as escolhas no diário de um dos dois membros ativos de um grupo. Confere a ocultação em todas as páginas da pessoa, a lista de outro membro, a volta da lista com `on: true` e o efeito de apagar o último registro de ocultação. Enquanto o perfil está oculto, o teste exige que o grupo conserve os três membros na descoberta, os dois ativos em "Em alta" e o escritor da pessoa em `/index/group/<G>` para a confirmação de denúncias.

## Resultados locais

| Comando ou verificação | Resultado |
| --- | --- |
| Teste em memória do semeador, isolado | 4 de 4 asserções passaram. Ao remover a condição de ocultação de `indexPublicGroups`, 2 falharam porque a resposta exibia o grupo. Ao restaurá-la, as 4 passaram. |
| `node packages/core/test/engagement-index-groups-show.test.js` | 4 testes e 24 asserções passaram. |
| `node packages/core/test/group-index-browse.test.js` | 21 testes e 238 asserções passaram. |
| `node packages/core/test/seeder-group-browse.test.js` | O teste em memória passou. O primeiro caso de rede parou em `UDXSocket.bind` com `EPERM`. O novo caso de integração, executado isoladamente, parou no mesmo ponto. |
| `node packages/core/test/seeder-group-trending.test.js` e `node packages/core/test/seeder-groups.test.js` | Cada arquivo parou ao abrir o socket da DHT local com `EPERM`. |
| `npx standard packages/core/lib/seeder.js packages/core/test/seeder-group-browse.test.js` e `npm run lint` | Passaram com o cache do Standard no diretório temporário. |
| `npm run demo` | A sandbox recusou o socket da DHT local em `UDXSocket.bind`. |

A linha da LGPD em `docs/design.md` registra que o semeador guarda em memória só o valor de cada registro vivo, como faz o índice de engajamento: um booleano por registro, para voltar à escolha anterior quando a mais nova é apagada. Só a escolha viva de maior sequência decide a resposta.
