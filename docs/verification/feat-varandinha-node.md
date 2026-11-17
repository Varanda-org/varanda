# Varandinha, o nó (PR feat/varandinha-node)

Este PR acrescenta o contrato `garden.*` ao `@varanda/rpc` (os métodos `garden.set`, `garden.state`, `garden.play` e `garden.help` em `packages/rpc/lib/methods.js` e as seções 5.156 a 5.159 de `docs/rpc.md`), os stubs do nó do core (`packages/core/lib/session.js` responde aos quatro com `USAGE` `'leitura sob demanda só na versão web'`), as operações do nó do navegador (`gardenOwn`, `gardenSet`, `gardenLeave`, `gardenPlay`, `gardenHelpCheck` e `gardenHelp` em `packages/web-member/lib/member-ops.js`), os quatro handlers e a checagem do vaso do dono fora da cadeia (`gardenTarget`, que falha fechado) em `packages/web-member/lib/session.js`, e um teste de ponta a ponta com um semeador local (`packages/web-member/test/garden-e2e.test.js`).

## Handlers do nó do navegador (`packages/web-member/lib/session.js`)

Rodado no Node 24.22.1, sobre 2fd8e2a2 (a ponta de feat/varandinha-index, o PR de baixo da pilha), com as mudanças deste PR ainda fora de commit:

- `npx standard packages/web-member/lib/session.js packages/web-member/test/garden-e2e.test.js`
  resultado: passou.
- `npm test -w packages/web-member -- test/garden-e2e.test.js`
  resultado: passou, 1/1 teste e 51/51 asserções, 1 arquivo, 0 falha.
- `npm test -w packages/web-member -- test/garden.test.js test/visits-e2e.test.js test/scraps.test.js`
  resultado: passou, 3 arquivos, 0 falha; `garden.test.js` 20/20 testes e 130/130 asserções, `visits-e2e.test.js` 2/2 e 40/40, `scraps.test.js` 5/5 e 49/49.

O que `packages/web-member/test/garden-e2e.test.js` cobre (um `Seeder` real atrás de `startSeedWs`, nós do navegador reais sobre armazenamento em memória, DHT local presa a `127.0.0.1` e diretórios temporários):

- A entra na Varandinha (`garden.set` ligado); entrar de novo não escreve nada. A planta manjericão no vaso 0 numa jogada; `garden.state` devolve o estado salvo e `savesToday` 1.
- B segue A e C; antes de ligar a própria Varandinha a rega é recusada com `'ligue a Varandinha para regar'`; regar a si mesmo, `'não dá para regar a própria varanda'`. D, que liga a Varandinha mas não segue A, recebe `'você só rega a varanda de quem você segue'`.
- Com a sincronização de B rodando (as espiadas saem dela): C, que nunca entrou, `'esta pessoa não está na Varandinha'`; o vaso 3 vazio de A, `'este vaso não tem planta para regar'`.
- Falha fechada: com a resposta do índice `/index/garden/<A>` trocando os ponteiros `on` e `state` (cada um aponta para um bloco de outro tipo), marcada como `indexing`, ou sem resposta, a rega responde `NOT_FOUND` `'semeador indisponível'`. O índice mente pela opção `fetchMedia` do nó, que repassa à rota real do semeador.
- A rega de B no vaso 0 de A dá certo e grava um `garden-help` com `to` e `pot`; a segunda rega à mesma varanda no mesmo dia de Brasília é recusada com `'você já regou esta varanda hoje'`; `garden.state` de B mostra `helpsToday` 1 e a rega em `given`.
- Na hora 3 (o `Date.now` do processo adiantado `GARDEN_WATER_GAP_MS` mais um minuto, como em `dm-moment-e2e.test.js`), A rega o manjericão: `w` 1 e `water` igual ao `at` do novo estado.
- A sai (`garden.set` desligado): `garden.state` com `on` falso, `state` nulo e `given` vazio; sair de novo não escreve nada. B sai e a rega some de `given` e de `helpsToday`.
- Toda recusa confere que o diário de quem chamou ficou do mesmo tamanho.

Não coberto no teste de ponta a ponta: uma página como `to` (`'páginas não têm Varandinha'`). Registrar uma página exige o serviço de conta, que assina e anexa o diário da página com a chave dela; o teste não sobe esse serviço. A checagem é a mesma de `scrap.write` e `fan.set` (um `page-roster` no bloco 1 ou 2 espiado).

Conferido que o teste falha sem a checagem: com a chamada a `gardenTarget` tirada de `garden.help`, o arquivo falhou nas recusas de C, do vaso vazio e nos três casos de falha fechada (asserções 27 a 36); com a chamada de volta, passou de novo.

Conferido à mão que as seções 5.156 a 5.159 de `docs/rpc.md` descrevem a ordem das checagens, a saída sem nada a fazer, a leitura de `garden.state` sem a chave destravada e a resposta de falha fechada do código, e que não há travessão (U+2014) nem meia-risca (U+2013) nas linhas novas.

## Contrato, stubs e operações (depois da revisão e da sincronização)

Rodado no Node 24.22.1, sobre 9dd4ad75 (a ponta de feat/varandinha-index, já com a `main` em 063a3590), com as mudanças deste PR ainda fora de commit. As seções do `docs/rpc.md` passaram de 5.152 a 5.155 para 5.156 a 5.159, porque a `main` usou 5.152 a 5.155 para `device.*`.

- `npx standard packages/rpc/lib/methods.js packages/rpc/test/methods.test.js packages/core/lib/session.js packages/core/test/engagement-session.test.js packages/web-member/lib/member-ops.js packages/web-member/lib/session.js packages/web-member/test/garden.test.js packages/web-member/test/garden-e2e.test.js`
  resultado: passou.
- `node packages/rpc/test/methods.test.js`
  resultado: passou, 7459/7459 asserções.
- `node packages/core/test/engagement-session.test.js`
  resultado: passou, 136/136 asserções (os quatro `garden.*` respondem `USAGE` `'leitura sob demanda só na versão web'` sem escrever bloco; parâmetro a mais, `'parâmetro desconhecido'`).
- `node packages/web-member/test/garden.test.js`
  resultado: passou, 22/22 testes e 160/160 asserções. Inclui `gardenTargetSeqs` (a lista da espiada, ou nada para recusar) e `gardenTargetVerdict` (20 casos de espiada montada: página, bloco 1 ou 2 faltando, bandeira desligada, de outro tipo ou datada mais de 24 h à frente, estado ausente, abaixo da bandeira, datado à frente, vaso vazio, plantado depois de agora, maduro).
- `node packages/web-member/test/garden-e2e.test.js`
  resultado: passou, 51/51 asserções.
- `node packages/web-member/test/session-devices.test.js`
  resultado: passou, 16/16 asserções (o arquivo da `main` que divide `session.js` com este PR).

## CI completa

Rodado na raiz, no Node 24.22.1, sobre 9dd4ad75 com as mudanças deste PR, na ordem da CI:

- `npm ci --ignore-scripts`
  resultado: passou.
- `npm run lint`
  resultado: passou.
- `npm test -- --affected=origin/main`
  resultado: passou, 821 arquivos de teste, 0 falha.
- `npm run demo`
  resultado: passou, terminou com "DEMO OK".

Não rodado: o Node 20 (a CI roda os dois); um navegador de verdade (os testes usam o nó do navegador sobre armazenamento em memória).
