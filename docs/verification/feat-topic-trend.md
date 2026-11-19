# Assuntos do momento na rota pública do semeador

O teste com o stub confere o corpo e as chaves exatas da resposta, GET e HEAD, a chamada sem argumentos, o 404 genérico para caminhos inválidos ou resposta nula e o uso do orçamento público mesmo com um token de triagem válido.

## Verificações executadas

- Em `apps/cli/test/seeder-topic-trend.test.js`, três pessoas publicam `#feira`. Com o cursor do índice de nomes de uma delas atrasado ou pausado, o assunto sai da lista e a resposta traz `complete: false`. Quando o cursor alcança o fim e volta a correr, `#feira` reaparece com três pessoas e `complete: true`, mesmo com o cursor de um diário sem hashtags ainda pausado.
- Com dois diários de pessoas e uma Página, a passagem de assuntos e a varredura de blocos chegam ao fim antes de o índice de nomes ler o registro assinado da Página. Nesse intervalo, `#feira` fica fora e a resposta traz `complete: false`. Depois da leitura do registro, a Página continua fora e `complete` volta a `true`.
- Sem a verificação do cursor, o arquivo passou em 6 de 8 testes e 32 de 35 asserções. Nas três falhas, a resposta trazia `feira` com três autores e `complete: true`. Com a verificação restaurada, passaram os 8 testes e as 35 asserções.
- `npx standard apps/cli/lib/seed-ws.js apps/cli/test/seed-ws.test.js` e `npm run lint` passaram com `XDG_CACHE_HOME` num diretório temporário. O sandbox recusou a escrita no cache padrão com `EPERM`.
- `node apps/cli/test/caddyfile.test.js` passou com 24 testes e 323 asserções. O Caddy já encaminha `/index/*` ao semeador.
- Em `apps/cli/test/seed-ws.test.js`, os 9 testes sem sockets passaram com 109 asserções. Com o listener HTTP simulado em memória, o teste novo da rota e o teste de grupos com o `Seeder` real passaram. A primeira execução teve 41 asserções, pois `indexTopicTrend` ainda faltava no `Seeder`. Na repetição, o método já estava disponível na dependência do workspace e as 43 asserções passaram, incluindo o 200 com `topics` como array. Ao retirar o despacho da rota em memória, o novo teste falhou com 404 onde esperava 200.
- `node packages/core/test/topic-trend.test.js`, `node packages/core/test/topic-index.test.js` e `node packages/core/test/group-activity.test.js` passaram com 24, 26 e 10 testes, respectivamente.
- `node apps/cli/test/changelog.test.js` passou com 9 testes. O parser do changelog aceitou a nova entrada na seção `Adicionado`.

## Verificações pendentes

- A execução integral de `node apps/cli/test/seed-ws.test.js` e de `npm test` depende de sockets locais. O sandbox respondeu `EPERM` ao abrir TCP e UDP em `127.0.0.1`.
- `npm run demo` parou em `UDXSocket.bind` com `operation not permitted` ao iniciar a DHT local. A saída `DEMO OK` ainda precisa ser conferida fora do sandbox.
