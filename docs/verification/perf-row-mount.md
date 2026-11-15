# Montagem das linhas de publicação: uma renderização por linha (branch perf/row-mount)

Este arquivo confere o PR3 da rodada de desempenho. Uma linha de publicação passa a renderizar uma vez ao montar: `src/postRowLayout.js` mantém a largura da legenda dentro de 0,5 pt da estimativa (`captionWidthNext`), compara tamanhos com tolerância de 0,5 pt (`sameSize`) e guarda num cache do módulo o último tamanho dos alvos do cabeçalho, que semeia a reserva do primeiro render da linha seguinte (`headReserveOf`, uma semente por linha); `ClampText` só guarda uma contagem medida quando ela muda a conta (`measurementToStore`); cada `ActionsSheet` monta na primeira abertura e fica (`openedNext`); o ouvinte de movimento reduzido do módulo `PostRow` foi trocado pelo repositório compartilhado (`useReduceMotion`). A foto (`MediaView`, `startImageFade`) anima no driver nativo onde existe e no JS na web, e um movimento reduzido que chega tarde a encaixa por `stopAnimation`.

Ambiente: o mesmo da seção 252 e de `docs/verification/perf-render-isolation.md` (emulador `varanda-perf` com `-no-window`, simulador iPhone 16e, Chrome sem cabeça com CPU 4x, Metro com `--clear`, Vitrine grande, sem nó, carga média de 1 min anotada abaixo). Antes é `docs/verification/perf-render-isolation.md` (T7, mesma máquina, no mesmo dia); depois é esta branch com as mudanças ainda sem commit. Alcance: A Rua com rolagem roteirizada de 60 s.

```sh
# a partir de apps/app; por célula, Metro novo e a rolagem roteirizada (Android e iOS)
EXPO_PUBLIC_VARANDA_VITRINE=1 EXPO_PUBLIC_VARANDA_VITRINE_LARGE=1 EXPO_PUBLIC_VARANDA_PERF=1 EXPO_PUBLIC_VARANDA_PERF_SCROLL=rua [EXPO_PUBLIC_VARANDA_VITRINE_RICH=1] npx expo start --port 8097 --clear
node apps/app/scripts/perf-summary.js <log>
# web: npx expo export --platform web --dev --output-dir <pasta> com as mesmas variáveis (ricas), servido e medido por CDP com CPU 4x
```

Antes e depois (mediana de 3 execuções cada; web e iOS ricas, Android texto e ricas). `rendersPerMountMedian` e `P95` vêm de `perf-summary.js`. Dentro do ruído quer dizer menos de 10%.

| Célula | Medida | Antes (253) | Depois | Mudança |
|---|---|---|---|---|
| Android texto (carga 17,1 a 19,1) | `tab:rua`, renderizações | 1149 | 794 | -31% |
| | `tab:rua`, ms | 13470 | 10904 | -19% |
| | renderizações por linha montada, mediana / P95 | 2 / 3 | 1 / 3 | -50% / igual |
| | abas escondidas, renderizações / ms | 82 / 54 | 82 / 79 | igual / +46% (de 54 para 79 ms, ver leituras) |
| | quadros p95 | 52,7 | 58,2 | +10% (execuções de 57 a 70 contra 43 a 54), dentro do ruído da carga |
| Android ricas (carga 17,4 a 19,4) | `tab:rua`, renderizações | 1100 | 817 | -26% |
| | `tab:rua`, ms | 11120 | 9363 | -16% |
| | renderizações por linha, mediana / P95 | 2 / 3 | 1 / 3 | -50% / igual |
| | quadros p95 | 52,7 | 64,8 | +23%, execuções de 55 a 69 contra 45 a 97; carga 17 a 22 nos dois |
| iOS ricas (carga 10 a 18) | `tab:rua`, renderizações / ms | 1193 / 5817 | 937 / 4272 | -21% / -27% |
| | renderizações por linha, mediana / P95 | 2 / 3 | 1 / 3 | -50% / igual |
| Web Chrome 4x, ricas (carga 12 a 30) | `tab:rua`, renderizações / ms | 1822 / 14742 | 1604 / 11677 | -12% / -21% |
| | renderizações por linha, mediana / P95 | 2 / 3 | 1 / 2 | -50% / -33% |
| | quadros p95 | 33,4 | 32,6 | dentro do ruído |

Critério do plano (renderizações por linha montada e milissegundos de render da lista, ao menos 20% abaixo da 246 no emulador Android): renderizações por linha, atingido (mediana de 2 para 1); renderizações da lista, atingido (-31% e -26%); milissegundos de render da lista, quase: -19% no texto e -16% nas ricas, ou seja, não atinge 20% no Android. No iOS (-27%) e na web (-21%) atinge. O P95 de renderizações por linha continua em 3 no Android e no iOS: as linhas que renderizam mais de uma vez ao montar (legenda clampada que o estimador erra, curtida que chega) não foram eliminadas.

Leituras:

- O ganho vem de a linha deixar de renderizar uma segunda vez ao montar (mediana de renderizações por linha de 2 para 1), não de a rolagem ficar mais barata por quadro: o p95 de quadros no Android não melhorou (subiu de 52,7 para 58,2 e 64,8, mas as execuções se cruzam e a carga foi de 17 a 22 nos dois lados; não se afirma ganho nem regressão).
- Abas escondidas no Android: o número de renderizações não mudou (82), mas o custo somado subiu de 54 para 77 a 79 ms nas duas configurações. Pode ser ruído de carga (cada renderização custa menos de 1 ms) ou a leitura de um contexto novo (`useReduceMotion`); não foi isolado nesta medição. Fica registrado.
- Nenhuma célula foi repetida com contas de usuário reais: a Vitrine não passa por `node.request`.

## À mão

Android (emulador, Vitrine rica, Metro 8097), com captura de tela:

- [x] Abrir a folha de ações (⋯) de uma publicação e tocar em "Copiar link": a folha abre na primeira vez, fecha e o aviso "Link copiado" aparece uma vez (a ação rodou uma só vez, depois do fechamento).
- [x] Fotos aparecem e a Vitrine carrega sem erro (primeira tela com fotos ao abrir).
- [ ] Clamp e "ver mais" numa publicação longa; fonte 1,3: não conferido. A Vitrine tem só publicações curtas (25 rolagens sem achar "ver mais" pelo `uiautomator`); sem nó não há como criar uma. O comportamento do clamp está coberto por `postClamp.test.js` e `postRowLayout.test.js`.
- [ ] Pressão longa numa linha; folha com fechar e reabrir rápido no iOS; foto em cache aparece de uma vez; curtida depois do fade mantém a opacidade 1; movimento reduzido encaixa a foto; deslizar para responder numa linha de Mensagem ou Grupo com player; listas da web crescem além das primeiras linhas: não conferidos.
- iOS e web à mão: não feitos (sem como tocar no simulador e no Chrome sem cabeça neste orçamento; só as células de medida rodaram).

## Não medido

- Android ricas com players (`EMBEDS=1`): ainda aborta pelo laço de permissão de DRM (PR #606), como em `docs/verification/perf-render-isolation.md`; não repetido.
- Android texto: a contagem de renderizações por linha no P95 e as linhas com legenda longa; iOS texto e web texto: não repetidos (a tarefa pedia só ricas no iOS e na web).
- Nó vivo, PWA instalado, build de release e aparelho de verdade: mesma lista da seção 252.

Na raiz, na ordem da CI, `npm run lint`, `npm test` e `npm run demo` têm de passar. A demo termina com `DEMO OK`.
