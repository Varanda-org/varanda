# feat/varandinha-model

Varandinha, Fase 1, PR 4: o modelo puro, os textos, o cliente do índice, a arte, o texto de ajuda e as respostas da Vitrine. Ainda não há tela: as telas chegam no PR seguinte.

## O que mudou

- Modelo puro (`apps/app/src/garden.js`, `apps/app/src/varandinhaView.js`): o cálculo do jardim sobre as regras de `@varanda/rpc` (`garden`) e os textos em pt-BR.
- Cliente do índice (`apps/app/src/indexClient.js`): `gardenUrl`, `gardenStreetUrl`, `validGarden`, `validGardenStreet`, `fetchGarden`, `fetchGardenStreet`, e o campo `garden` na resposta do perfil.
- Arte (`apps/app/src/ui/gardenScene.js`, `apps/app/src/ui/GardenSceneView.js`) e texto de ajuda (`apps/app/src/help.js`).
- Vitrine (a demonstração sem rede):
  - `fixtures.js`: `gardenRecords`. Lia joga (um vaso maduro, um crescendo e seco, um crescendo e regado, um recém-plantado, dois vazios, `garden-state` no seq 52), Cecília e André jogam, seguem a Lia e regaram um vaso dela hoje, Lia regou um vaso da Cecília (seq 53) e Bia saiu do jogo (flag desligada, seq 130). João fica de fora, porque é o amigo pendente que não segue de volta.
  - `request.js`: `garden.set`, `garden.state`, `garden.play` e `garden.help`, com as mensagens de `docs/rpc.md` 5.157 a 5.160, sobre os registros do próprio diário (um jogo, uma rega ou uma saída aparecem em `diary.peek` e no índice).
  - `indexResponder.js`: `/index/garden/<dono>`, `/index/garden/<dono>/rua[/<cursor>]` e o campo `garden` da rota de perfil.
- Nenhum arquivo gerado, nenhum segredo e nenhuma dependência nova.

## Testes

- `apps/app/test/garden.test.js`: o plano de espiadas (crescente, sem repetição, agrupado por quem regou, dentro do teto de 29 seqs e só com um índice dentro dos tetos da rota), a montagem da varanda (ponteiro forjado, de outro tipo, apagado, repetido ou sem `follow` nunca conta; quem a pessoa bloqueou some; nada é dobrado enquanto o bloco 1 ou 2 não foi lido; um relógio inválido dá varanda incompleta), a única nova busca do índice, `flagOn`, as jogadas pendentes (que voltam ao maior começo que ainda vale) e o consentimento.
- `apps/app/test/varandinhaView.test.js`: textos, recusas de `docs/rpc.md` 5.157 a 5.160 (inclusive `'você bloqueou esta pessoa'`), avisos e contagem regressiva.
- `apps/app/test/gardenScene.test.js`: seis plantas com quatro fases distintas, paleta clara e escura, medidas inteiras em 360, 375 e 1280, vasos dentro da parede, áreas de toque de 44 pt, layout vazio em larguras pequenas, balanço só da planta, no driver nativo fora da web e reiniciado quando muda o conjunto de vasos maduros. `loopRender.test.js` passa a cobrir a nova cena.
- `apps/app/test/indexClient.test.js`: respostas válidas, listas grandes demais, repetições, cursor malformado, chave a mais, semeador antigo sem `garden` e respostas que não são 200.
- `apps/app/test/help.test.js`: a entrada `varandinha`, sem jargão.
- `apps/app/test/vitrine.test.js`: chaves de resposta e parâmetros de exemplo dos quatro métodos; os registros do jardim validam em `validateRecord`; `garden.state` do estado inicial; `garden.play` grava um estado novo, apaga o anterior na mesma escrita e uma jogada inválida muda nada (`jogada inválida`); a colheita conta as regas que a própria pessoa deu (`foldGiven`), como o nó; `garden.set` sai e volta, e a saída e a volta apagam a flag anterior; `garden.help` e suas recusas.
- `apps/app/test/vitrineIndex.test.js`: as duas rotas passam em `validGarden` e `validGardenStreet`; cada ponteiro de rega resolve em `diary.peek` para um `garden-help` ao dono e o `followSeq` para um `follow` vivo; a rua lista só quem o dono segue e que ligou o jogo; o perfil traz `garden`; uma varanda desligada não lista estado, rega nem rega dada; dono desconhecido é not-found.

## Comandos

Rodados pelo orquestrador:

```sh
npm test -w apps/app -- test/garden.test.js test/varandinhaView.test.js test/gardenScene.test.js test/loopRender.test.js test/loopMotion.test.js test/platformGate.test.js test/themeUsage.test.js test/help.test.js test/indexClient.test.js test/vitrine.test.js test/vitrineIndex.test.js test/vitrineGuard.test.js test/vitrineLarge.test.js
npx standard apps/app/src/garden.js apps/app/src/varandinhaView.js apps/app/src/ui/gardenScene.js apps/app/src/ui/GardenSceneView.js apps/app/src/indexClient.js apps/app/src/help.js apps/app/src/vitrine/request.js apps/app/src/vitrine/indexResponder.js apps/app/src/vitrine/fixtures.js
```

## Não rodado

Nenhuma tela usa esses métodos ainda: a conferência no celular fica para o PR das telas.

## CI completa

Node 24.22.1, depois de `npm ci --ignore-scripts`:

- [x] `npm run lint`
- [x] `npm test -- --affected=origin/main`: 838 arquivos de teste, 0 falha
- [x] `npm run demo`: DEMO OK

Não rodou localmente: Node 20 (a CI roda os dois).
