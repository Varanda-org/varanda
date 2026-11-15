# Isolamento de renderização: linhas, abas escondidas, Skeleton e movimento reduzido (branch perf/render-isolation)

Este arquivo confere o PR2 da rodada de desempenho: as linhas (`Avatar`, `MediaView`, `LinkCard`, `ChatMedia`, `MomentReactionPreview`, `MusicPlayerCard`, `RefreshableList`) leem um contexto estreito do nó (`NodeHandleContext`, `MemberKeyContext`) em vez do contexto inteiro; 27 telas de `App.js` são `memo` de módulo com tratadores estáveis; o pulso do `Skeleton` pausa enquanto a tela está escondida; o `MusicEqualizer` usa o driver nativo; uma só assinatura de movimento reduzido (`src/reduceMotionStore.js`). Medido com o mesmo instrumento e os mesmos roteiros da seção 252 (linha de base em `docs/performance.md`, "M5, linha de base"). Decisão por contadores (renderizações e ms de render), não por p95 de quadro. Abaixo de 10% de diferença: "dentro do ruído". As medidas são de antes da remoção do adesivo de música da leitura na `main` (a50b312c): o `PostMusic` e o `OnlineContext`, que só ele lia, saíram depois, sem mudar o que as outras linhas leem.

Ambiente: o mesmo da seção 252 (emulador `varanda-perf` com `-no-window`, simulador iPhone 16e, Chrome sem cabeça 412x915 com CPU 4x, Metro com `--clear`, Vitrine grande, sem nó). Carga média de 1 min por célula entre 8,5 e 22,2 (anotada abaixo). Alcance do isolamento: a memo de aba isola atualizações do estado do shell (aviso, selo, barra que some ou volta). Uma mudança de `online` ou de visibilidade do nó ainda renderiza o componente de topo de cada aba, porque as telas de aba chamam `useNode()`.

```sh
# Metro por célula (a partir de apps/app), depois a rolagem roteirizada; no Android e no iOS
EXPO_PUBLIC_VARANDA_VITRINE=1 EXPO_PUBLIC_VARANDA_VITRINE_LARGE=1 EXPO_PUBLIC_VARANDA_PERF=1 EXPO_PUBLIC_VARANDA_PERF_SCROLL=rua [EXPO_PUBLIC_VARANDA_VITRINE_RICH=1] npx expo start --port 8097 --clear
node apps/app/scripts/perf-summary.js <log>
# web: npx expo export --platform web --dev --output-dir <pasta> com as mesmas variáveis, servido por servidor estático e medido por CDP (CPU 4x)
```

Antes (linha de base 252, mediana) e depois (esta branch, mediana), na rolagem roteirizada de A Rua de 60 s. "Abas escondidas" soma os ids `tab:*` fora de `rua`.

| Célula | Medida | Antes | Depois | Mudança |
|---|---|---|---|---|
| Android texto (3 e 3; carga 16,3 a 18,9) | abas escondidas, renderizações / ms | 119 / 336 | 82 / 53 | -31% / -84% |
| | `tab:rua`, renderizações / ms | 1230 / 12742 | 1176 / 13470 | -4% / +6%, dentro do ruído |
| | quadros p95 | 42,2 | 50,6 | dentro do ruído (execuções de 43 a 54 contra 39 a 50) |
| Android ricas (3 e 3; carga 15,1 a 22,2) | abas escondidas | 124 / 375 | 78 / 54 | -37% / -86% |
| | `tab:rua` | 1182 / 9589 | 1100 / 11120 | -7% / +16%; a execução 1 (carga 17, 888 renderizações) pegou um estouro, ver abaixo |
| Android parado 75 s (1 e 1) | abas escondidas, partida inclusa | 66 | 51 | -23% |
| iOS texto (3 e 3; carga 8,9 a 12,3) | abas escondidas | 136 / 345 | 90 / 57 | -34% / -83% |
| | `list:rua` / `tab:rua` | 1233 / 8177 ms | 1225 / 8259 ms | dentro do ruído |
| iOS ricas (3 e 3; carga 8,5 a 11,1) | abas escondidas | 124 / 302 | 84 / 44 | -32% / -85% |
| | `tab:rua` | 1226 / 5819 | 1193 / 5817 | dentro do ruído |
| Web Chrome 4x, rolagem de 60 s (3 e 3; carga 8,3 a 12,2) | cada aba que renderizava por quadro (Espiadinha, Avisos, Comunidades, Diário) | 3245 a 3281 | 18 | -99% |
| | soma das abas escondidas, ms | 5350 a 5828 | 190 a 255 | -96% |
| | `tab:rua` | 1831 a 1849 / 14072 a 14342 | 1801 a 1830 / 14590 a 15134 | dentro do ruído |
| | quadros p95 | 35,2 a 38,3 | 32,7 a 34,5 | -4 a -12%, perto do ruído |

Leituras:

- O ganho está onde o PR mirou: as abas escondidas. Na web, o pulso do `Skeleton` que mantinha quatro abas renderizando a cada quadro (cerca de 60 por segundo, parado inclusive) sumiu. No Android e no iOS, restam de 78 a 90 renderizações por aba na rolagem (cerca de 13 a 15 por aba, uma por inversão das barras e por mudanças de `online`/visível via `useNode()`), mas elas custam 40 a 60 ms em vez de 300 a 400.
- A lista de A Rua não ficou mais barata (dentro do ruído, com a carga entre 8 e 22): a barra que some ou volta renderiza a tela dela de qualquer forma, e a memo das linhas já existia. Não se afirma ganho de rolagem. A execução 1 das ricas no Android (carga 17,2, 888 renderizações, p95 de 96,9 ms, 1694 quadros) é uma execução lenta do emulador, não regressão: as outras duas deram 1100 e 1139.
- Parado no Android: sem RPC medida, porque a Vitrine não passa por `node.request` (nenhuma linha `req:`), como na seção 252.

## Regressão ou lacuna encontrada

- Android, ricas + players (`EMBEDS=1`): as 4 execuções (1 mais 3 de repetição) abortaram a rolagem com `scroll-aborted list=rua hidden`, cerca de 8,6 s depois do início, sempre no mesmo ponto. O logcat mostra o `GrantPermissionsActivity` do sistema abrindo por um instante (o WebView do player pede `PROTECTED_MEDIA_ID`, DRM) e fechando; o app recebe `onHostResume`, `backgrounded` vira verdadeiro e `screenSeen('rua')` fica falso. Na linha de base (3 de 3) isto não aconteceu no mesmo emulador. É o laço de permissão de DRM do Android que o PR #606 (aberto) corrige: o Spotify chama `requestMediaKeySystemAccess`, o react-native-webview transforma o pedido numa tela de permissão do sistema, que pausa a atividade e manda o app para segundo plano. Isso acontece na `main` de hoje e depende de qual player carrega e quando; nenhum arquivo deste PR trata permissão de WebView. Fica sem contadores para a célula "ricas + players" no Android até o #606 entrar.

## À mão

Android (emulador, Vitrine rica com players, Metro 8096), cada item com captura de tela:

- [x] As barras somem na descida e voltam na subida.
- [x] Trocar de aba (A Rua, Espiadinha e de volta); tocar de novo na aba de A Rua depois de rolar leva ao topo.
- [x] Citar depois de trocar de aba abre o compositor citando a publicação certa (Lia Oliveira). Responder abre a conversa com a barra de resposta (a tela diz "conversa não disponível" porque a Vitrine não tem nó). O momento "Você" abre e fecha.
- [x] Segundo plano e volta: o app volta em A Rua; o player de YouTube volta fechado (comportamento da regra de segundo plano).
- [ ] Movimento reduzido ligado (escalas de animação do sistema em 0): o fechamento do visualizador de momentos foi instantâneo; a abertura não ficou clara na captura (o `screencap` leva mais que a transição). Inconclusivo; esqueleto e equalizador parados não conferidos.
- [ ] Player tocando continua carregado na troca de aba (contagem de vivos) e equalizador pulando: não conferido. O player do YouTube carregou, mas dirigir o toque no vídeo e a contagem de vivos pelo `adb` não coube neste orçamento.
- [ ] Esqueleto de uma aba escondida começa a pulsar quando a aba abre: não conferido à mão (a Vitrine não mostra esqueleto nas abas). Coberto só pelo teste `loopRender.test.js`.
- [ ] Toast e botão publicar: o botão de publicar abriu o compositor (visto na captura da citação); toast não disparado.
- [ ] iOS à mão e web à mão: não feitos (sem como tocar no simulador e no Chrome sem cabeça neste orçamento). O simulador e o Chrome rodaram só as células de medida.

## Não medido

- Células de rolagem com players no Android (acima); com players no iOS e no web: não repetidas (a tarefa pedia uma vez, no Android).
- iOS parado 60 s e web parado 60 s à parte: a web parada foi lida pelos 110 s de cada execução (as quatro abas ficaram em 18 renderizações cada, contra 3245 a 3281); o iOS parado não foi repetido.
- Nó vivo, PWA instalado, build de release e aparelho de verdade: mesma lista da seção 252.
- Frame p95 não foi usado como portão.

Na raiz, na ordem da CI, `npm run lint`, `npm test` e `npm run demo` têm de passar. A demo termina com `DEMO OK`.
