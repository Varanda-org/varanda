# feat/varandinha-visual

Visual novo da Varandinha: direção A, "Pôr do sol", com os pontinhos de fase e a gota de sede da direção B. Só aparência: nenhum método do RPC, registro, leitura ou guarda mudou.

## O que mudou

- `apps/app/src/ui/gardenStyle.js` (novo, módulo puro):
  - paletas `GARDEN_LIGHT` e `GARDEN_DARK`, `gardenTokens(scheme)` e `gardenGradients(scheme)`;
  - formas sem transformação: `PATHS`, `placePath`, `placeShapes`, `shapePath`, `leafAt`, `bladeAt`, `veinAt`, `sparkAt`, `lineAt`, `sprigPath`;
  - pistas: `stageDots`, `thirsty`, `ripeOf`, `dotRow`, `THIRST_BADGE`;
  - desenhos para o PR seguinte: `giftDrawing(item)` e `STALL_DRAWING`;
  - estilos de cartão: `HIT`, `CARD_RADIUS`, `LIFT` e `gardenCardStyles(tokens)`.
- `apps/app/src/ui/GardenArt.js` (novo): `gradId`, `GardenDefs`, `ShapeList`, `GardenDrawing`, `PotArt`, `StageDots`, `ThirstBadge`, `useGardenStyles`, `StickerCard`, `GardenButton` e `GardenSection`.
- `apps/app/src/ui/gardenScene.js`:
  - céu de fim de tarde (cidade ao luar no escuro), telhado com beiral, grade de madeira e piso de lajotas;
  - vasos de barro e plantas redesenhados com contorno, quatro fases por planta;
  - `potCues`: os quatro pontinhos e a gota quando o vaso pode ser regado.
  - `gardenLayout` mantém as garantias: largura máxima de 420, alvos de 44, seis vasos e as faixas dos enfeites.
- `apps/app/src/ui/gardenDecor.js`: os quatro enfeites com contorno e as cores novas. As lâmpadas do pisca ganham halo à noite.
- `apps/app/src/ui/GardenSceneView.js`:
  - o fundo é memorizado, então o relógio da tela não o redesenha;
  - a planta pronta balança e o brilho pulsa no mesmo `Animated.Value`;
  - com redução de movimento, os dois param.
- `apps/app/src/varandinhaView.js`: `THIRSTY_LABEL` ("precisa de água") entra no rótulo do vaso, porque a gota fica escondida dos leitores de tela.
- `apps/app/src/screens/Varandinha.js` e `VarandinhaRua.js`:
  - cartões e botões no estilo novo;
  - escolha de planta em grade de duas colunas;
  - o estado "ainda não joga" mostra a varanda vazia.
  - Mesma lógica e mesmos rótulos de acessibilidade.

## Testes

`apps/app/test/gardenStyle.test.js` (novo):

- `both palettes share keys and hold hex colours`
- `sheet text reads on its card`
- `gradients resolve to palette colours`
- `placePath moves, turns, mirrors and scales`
- `placeShapes keeps paint and stroke widths`
- `dots, thirst and ripeness read own data only` (inclui getters e proxies hostis)
- `badge, gifts and stall stay in their boxes`
- `card styles keep every target at least 44 tall`
- `source is pure and deterministic`

Nos arquivos existentes:

- `gardenScene.test.js`:
  - posições novas;
  - `the back row stands on the cap, the front row on the floor`;
  - `the backdrop fills the scene, stars only at night`;
  - `cues are the stage dots and, when it can take water, the drop`.
- `gardenDecor.test.js`: contorno e paleta nova; ids, caixas e faixas como antes.
- `gardenSceneView.test.js`:
  - fundo memorizado;
  - nenhum `Pressable` além dos vasos;
  - nenhum `Animated.Value` além do balanço.
- `varandinhaView.test.js`:
  - `THIRSTY_LABEL`;
  - `the Varandinha screens define every style key they read`;
  - `the plant grid lets Android break a plant name after its hyphens`.

## Falha sem a correção

As conferências em aparelho acharam três defeitos do restyle. Cada um ganhou teste.

1. **Cabeçalho do dono sem estilo na varanda de um vizinho.** O restyle tinha perdido chaves do `makeStyles`.
   - Sem a correção, `the Varandinha screens define every style key they read` falha (12/13 testes no arquivo, antes do teste do hífen).
   - Com ela, passa.
2. **Na grade de plantas, a sombra do cartão era mais alta que a face.** O nome de duas linhas esticava a linha da grade.
   - Sem `flexGrow: 1` no `card`, `card styles keep every target at least 44 tall` falha (8/9 testes, 1128/1130 asserções).
   - Com ele, passa (1130/1130).
3. **Com fonte 1.3 no Android, "Espada-de-são-jorge" quebrava dentro de "jorge".** O Android só quebra depois de um hífen com a hifenização ligada.
   - Sem `android_hyphenationFrequency='normal'`, o teste do hífen falha (521/522 asserções).
   - Com ele, passa (522/522).

## Conferência em aparelho

Build Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`), sem rede.

### Android (emulador, build de debug)

- Varanda própria nos temas claro e escuro, com vasos prontos, crescendo, em semente e vazios.
- A planta pronta balança e brilha. Com "Remover animações" ligado, nada se move: duas capturas seguidas tinham 172 linhas de pixels diferentes com animação e 0 sem.
- Folha do vaso: Colher e Arrancar num vaso pronto, Descartar do plantio pendente, e a grade de plantas. Esta conferência achou o defeito 3.
- A Rua em cartões.
- Varanda de um vizinho:
  - a gota aparece em dois vasos com sede;
  - o botão Regar funciona e a rega fica gravada ("1 vizinho regou");
  - esta conferência achou o defeito 1.
- TalkBack lê os rótulos dos vasos, incluindo "precisa de água".
- Fonte 1.3: varanda e grade de plantas.

### iOS (simulador iPhone 17 Pro)

- Temas claro e escuro.
- Grade de plantas. Esta conferência achou o defeito 2.
- Estado "ainda não joga".

### Web

- 390 de largura, claro e escuro.
- 1280 de largura, escuro: a cena fica com 420 de largura, centralizada.
- Os únicos erros do console são as mídias de `vitrine.invalid` da própria Vitrine.

### Observação

A gota continua na varanda do vizinho depois da sua rega. A ajuda de um vizinho só encurta o crescimento e não limpa a terra seca do dono, como o "terra seca" de antes, e o botão Regar some depois da ajuda do dia.

## Comandos

```sh
npm run lint
node apps/app/test/gardenStyle.test.js       # 1130/1130
node apps/app/test/gardenScene.test.js       # 6022/6022
node apps/app/test/gardenDecor.test.js       # 479/479
node apps/app/test/gardenSceneView.test.js   # 36/36
node apps/app/test/varandinhaView.test.js    # 522/522
node apps/app/test/garden.test.js            # 1297/1297
node apps/app/test/gardenStall.test.js       # 96/96
node apps/app/test/loopRender.test.js        # 16/16
node apps/app/test/platformGate.test.js      # 807/807
node apps/app/test/themeUsage.test.js        # 1515/1515
node apps/app/test/vitrine.test.js           # 4430/4430
node apps/app/test/vitrineGuard.test.js      # 1404/1404
npm run demo
```

A suíte inteira roda na CI do GitHub.

## Não rodado

- iOS: VoiceOver e redução de movimento. O `simctl` não tem chave para esses ajustes.
- Web: redução de movimento.
- Perfil de quadros num Android fraco e em aparelho físico. Só o emulador e o simulador foram usados.
- Enfeites na tela: a Vitrine ainda não passa `decor` à varanda própria, e o PR seguinte faz essa ligação. Os enfeites estão cobertos só pelos testes de `gardenDecor` e `gardenScene`.
