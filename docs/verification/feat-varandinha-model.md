# feat/varandinha-model

Varandinha, Fase 1, PR 4: o modelo puro, os textos, o cliente do índice, a arte, o texto de ajuda e as respostas da Vitrine. Ainda não há tela: as telas chegam no PR seguinte.

## O que mudou

- Modelo puro (`apps/app/src/garden.js`, `apps/app/src/varandinhaView.js`): o cálculo do jardim sobre as regras de `@varanda/rpc` (`garden`) e os textos em pt-BR.
- Cliente do índice (`apps/app/src/indexClient.js`): `gardenUrl`, `gardenStreetUrl`, `validGarden`, `validGardenStreet`, `fetchGarden`, `fetchGardenStreet`, e o campo `garden` na resposta do perfil.
- Arte (`apps/app/src/ui/gardenScene.js`, `apps/app/src/ui/GardenSceneView.js`) e texto de ajuda (`apps/app/src/help.js`).
- Vitrine (a demonstração sem rede):
  - `fixtures.js`: `gardenRecords`. Lia joga (um vaso maduro, um crescendo e seco, um crescendo e regado, um recém-plantado, dois vazios, `garden-state` no seq 52), Cecília e André jogam, seguem a Lia e regaram um vaso dela hoje, Lia regou um vaso da Cecília (seq 53) e Bia saiu do jogo (flag desligada, seq 130). João fica de fora, porque é o amigo pendente que não segue de volta.
  - `request.js`: `garden.set`, `garden.state`, `garden.play` e `garden.help`, com as mensagens de `docs/rpc.md` 5.156 a 5.159, sobre os registros do próprio diário (um jogo, uma rega ou uma saída aparecem em `diary.peek` e no índice).
  - `indexResponder.js`: `/index/garden/<dono>`, `/index/garden/<dono>/rua[/<cursor>]` e o campo `garden` da rota de perfil.
- Nenhum arquivo gerado, nenhum segredo e nenhuma dependência nova.

## Testes

- `apps/app/test/vitrine.test.js`: chaves de resposta e parâmetros de exemplo dos quatro métodos; os registros do jardim validam em `validateRecord`; `garden.state` do estado inicial; `garden.play` grava um estado novo e uma jogada inválida muda nada (`jogada inválida`); `garden.set` sai e volta; `garden.help` e suas recusas.
- `apps/app/test/vitrineIndex.test.js`: as duas rotas passam em `validGarden` e `validGardenStreet`; cada ponteiro de rega resolve em `diary.peek` para um `garden-help` ao dono e o `followSeq` para um `follow` vivo; a rua lista só quem o dono segue e que ligou o jogo; o perfil traz `garden`; dono desconhecido é not-found.

## Comandos

Rodados pelo orquestrador:

```sh
npm test -w apps/app -- test/vitrine.test.js test/vitrineIndex.test.js test/vitrineGuard.test.js test/vitrineLarge.test.js test/indexClient.test.js test/garden.test.js
npx standard apps/app/src/vitrine/request.js apps/app/src/vitrine/indexResponder.js apps/app/src/vitrine/fixtures.js apps/app/test/vitrine.test.js apps/app/test/vitrineIndex.test.js
```

## Não rodado

Nenhuma tela usa esses métodos ainda: a conferência no celular fica para o PR das telas.

## CI completa

- [ ] npm run lint
- [ ] npm test -- --affected=<ref>
- [ ] npm run demo
