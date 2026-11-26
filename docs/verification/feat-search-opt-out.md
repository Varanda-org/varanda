# Aparecer na busca (issue #166)

O membro grava `{ type: 'search-show', on, at }` no próprio diário pelo `search.show` (5.181) do nó do navegador. O índice de engajamento do semeador dobra o registro como o `groups-show` (`searchShown`), e `/index/search` deixa de fora o diário cuja escolha viva mais nova é `on: false`. Enquanto a varredura do diário não leu o bloco mais novo (primeira passagem, cursor parado ou atrás do tamanho presente), o diário fica fora dos resultados e a resposta diz `complete: false`. O índice de nomes continua com o @nome verificado, e seguir pelo @nome exato (serviço de conta) ou pela chave não muda.

## Critérios de aceite

| Critério | Como foi conferido |
| --- | --- |
| Quem desliga deixa de aparecer na próxima varredura | `apps/cli/test/seeder-index.test.js`, caso "search-show off leaves account search at the next pass": antes do registro a conta aparece; depois da passagem que lê `on: false` ela some, inclusive pela busca do @nome exato; enquanto o bloco seguinte não foi lido ela fica de fora com `complete: false`; com `on: true` ela volta. Sem o filtro em `indexSearch` (trocado por `return true` e sem a espera), 3 asserções falharam; com o filtro de volta, todas passaram. |
| Continua podendo ser seguida pelo @nome exato ou pela chave | No mesmo caso, `byUsername('joaoa')` ainda devolve a chave e o diário continua servido. A busca do @nome exato no serviço de conta não lê o registro. |

## Resultados locais

| Comando | Resultado |
| --- | --- |
| `npm run lint` | Passou. |
| `node apps/cli/test/seeder-index.test.js` | 56 testes, 9102 asserções passaram. |
| `node packages/core/test/engagement-index-search-show.test.js` | 4 testes, 24 asserções passaram. |
| `node packages/core/test/records.test.js` | 78 testes passaram. |
| `node packages/core/test/engagement.test.js`, `engagement-session.test.js`, `engagement-index-delete.test.js`, `name-index.test.js`, `seeder-delete.test.js`, `seeder-group-browse.test.js`, `seeder-discover.test.js` | Passaram. |
| `node packages/rpc/test/methods.test.js` | 186 testes passaram. |
| `node packages/web-member/test/search-show.test.js` e `groups-show.test.js` | 4 testes cada passaram. |
| `node apps/cli/test/seed-ws.test.js` | 122 testes passaram. |
| `node apps/app/test/aparecerNaBusca.test.js`, `composePolish.test.js`, `gruposNoPerfil.test.js`, `help.test.js`, `platformGate.test.js`, `vitrine.test.js`, `vitrineIndex.test.js` | Passaram. |
| `npm run demo` | `DEMO OK`. |
| Suíte inteira | Roda na CI do GitHub (Node 20 e 24). |

## Limites

- Não conferido em aparelho: a chave em Ajustes só aparece com `node.hosted` (web hospedada e app ligado à instalação), e o build de debug não entra numa instalação de produção. A tela foi conferida pelos testes de fonte e pela vitrine.
- Um semeador de versão anterior ignora o registro e continua listando a pessoa (`docs/protocol.md`, tabela de versões): os semeadores precisam atualizar antes de a escolha valer em toda a rede.
- Por fechar em caso de dúvida, um diário cujo cursor de índice parou no teto do índice de engajamento também sai da busca (com `complete: false`) até sobrar espaço. Antes dessa mudança ele continuava aparecendo pelo nome. Achado de severidade baixa da auditoria, aceito: a alternativa seria listar alguém cuja escolha mais nova o semeador ainda não leu.
- O estado mostrado em Ajustes vem do diário local. Se outro aparelho da mesma passkey mudou a escolha e este ainda não sincronizou, a tela mostra o valor anterior até a sincronização; a gravação sincroniza antes de comparar.
