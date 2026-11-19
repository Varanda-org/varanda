# Descoberta de grupos públicos e Assuntos do momento

Os Termos de Uso e a Política de Privacidade passam da versão 97 para a 98, de 19/11/2026. O teste do app confere que os dois textos descrevem a lista de grupos do perfil, a opção de ocultá-la, as regras das listas de Comunidades e a contagem de hashtags. O teste do site compara o texto e a ordem de cada seção publicada com os documentos do app.

## Verificações executadas

Sobre a `main` com #814, rodaram os arquivos de teste que o PR muda e os que importam um módulo alterado.

| Comando | Resultado |
|---|---|
| `npm run lint` | Saiu com código 0 |
| 21 arquivos de `apps/app/test/` | 554 testes e 16810 asserções passaram |
| 9 arquivos de `packages/core/test/` que importam `lib/terms.js` | 73 testes e 1231 asserções passaram |
| 32 arquivos de `apps/cli/test/` que importam `@varanda/core/lib/terms` | 521 testes e 10621 asserções passaram |
| `node packages/web-member/test/session.test.js` | 88 testes e 791 asserções passaram |
| `node apps/site/test/legal.test.js` | 7 testes e 115 asserções passaram |
| `node apps/site/scripts/render-legal.js --check` | Saiu com código 0 depois de regenerar as duas páginas |
| `npm run demo` | Terminou com `DEMO OK` |

Testes novos ou ampliados no app:

- `groupFanOut.test.js` (7 testes): uma consulta por vez, com intervalo entre os inícios; `hidden: true` numa página seguinte descarta as linhas já lidas daquela pessoa e mantém as outras; "não encontrado" pula a pessoa; limite de taxa para a leitura e a marca como incompleta; falhas seguidas param; uma resposta com `complete: false` fica e não é pedida de novo.
- `comunidadesShelves.test.js` (12 testes): as quatro listas, a ordem e os textos; atualizar não reinicia uma leitura em andamento; entrar num grupo o tira de **Grupos de quem você segue**; uma leitura que falhou antes de qualquer linha não fica guardada, e atualizar pede de novo.
- `groupShelves`, `groupShelfUi`, `gruposNoPerfil`, `publicGroupsBoxScreen`, `topicTrend` (com a paridade da regra de hashtag do semeador) e `trendingTopics`.
- `vitrine.test.js`: `groups.show` repetindo o valor atual devolve `changed: false`.
- `legal.test.js`: versão, data e SHA-256 dos dois textos, e o teste dos parágrafos de descoberta.

Cada teste das correções de revisão falhou com a correção retirada e passou com ela de volta. Ao retirar temporariamente os parágrafos de descoberta dos dois documentos, o teste novo e o do SHA-256 de `legal.test.js` falharam.

## Verificações pendentes

- A suíte completa roda na CI do GitHub deste PR.
- Conferência manual em Android e iOS, seguida de web e PWA. Em uma instalação hospedada, abrir Comunidades e conferir a ordem e os textos das quatro listas, a ocultação durante a busca e a ausência de **Grupos de quem você segue** ao agir como Página. Conferir **Seus grupos públicos** no próprio Diário e **Grupos públicos** no perfil de outra pessoa, com os nomes das comunidades. Desligar **Grupos públicos no perfil** e conferir a ausência da caixa e da pessoa na contagem de seguidos após atualizar a lista. Na Busca, em **Publicações**, conferir **Assuntos do momento** abaixo do campo vazio e abrir uma hashtag para chegar à tela Assunto.
