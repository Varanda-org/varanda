# Partida nativa: barra do splash na camada nativa (branch perf/native-boot)

Este arquivo confere a partida do app nativo com a árvore do PR (HEAD 21407c2f mais `Splash.js` e `splashWiring.test.js`: a barra de progresso do splash desliza por `translateX` no driver nativo, com o preenchimento de largura fixa em vez de animar a largura). Vitrine grande, Metro com `--clear`, marcas `perf:` ligadas, Android no emulador 5560 (build de debug) e iOS no iPhone 16e. Carga de 1 minuto: 6 a 18 nas partidas de Android, 6 a 10 no iOS (uma partida a quente do iOS, a 10, correu com carga 27 e colidiu com a captura de tela seguinte).

## Resultados

- [x] Android, 5 partidas a frio (`am start -W`), medianas: `TotalTime` 653 ms (611 a 786); `Start proc` a `js-entry` 2039 ms; `Start proc` a `first-rows:rua` 5364 ms; `app-commit` 689 ms; `first-rows:rua` 3333 ms desde `js-entry`. Contra a seção 252 (730 ms, 691 ms, 3465 ms): sem diferença acima do ruído, como esperado, porque a mudança é a animação da barra.
- [x] Android, 5 partidas a quente (app em segundo plano, volta ao primeiro plano): `TotalTime` 89, 98, 145, 118, 137 ms (mediana 118 ms; seção 252: 100 a 131 ms). Não há marcas novas, o JS não reinicia.
- [x] iOS, 5 partidas a frio: `app-commit` 574 a 587 ms (mediana 585), `first-rows:rua` 2718 a 2736 ms (mediana 2728); chamada `simctl launch` 190 a 234 ms (mediana 199). Seção 252: 587 e 2769 ms. 5 a quente (voltando do Safari): `simctl launch` 139, 139, 290, 147, 135 ms (mediana 139); sem marcas, o JS não reinicia (a décima reiniciou por colisão com a captura e não conta).
- [x] Barra do splash (T19), Android e iOS, capturas a cada 0,45 s numa partida a frio: a barra aparece depois do nome, o preenchimento avança em degraus (cerca de 60% e depois 80% da trilha antes de A Rua entrar) e as pontas ficam arredondadas, tanto a do preenchimento quanto a da trilha, sem esticar, em todas as capturas. Cortes de 420 px conferidos por imagem. Não vi os degraus de 90% e 100% antes de A Rua entrar na Vitrine (a marca `details` não sai nela, seção 252). Não conferi uma partida em que o preenchimento chegue ao fim na aparência, só a ausência de esticamento.
- [x] Partida em primeiro plano: abre, splash, A Rua com as linhas da Vitrine, sem erro no console do Metro nem no logcat (marcas `js-entry`, `sweep-media-cache`, `app-commit`, `first-rows:rua` na ordem).
- [x] Partida só em segundo plano: `index.js` e `src/backgroundTask.native.js` não mudam contra HEAD (`git diff HEAD --stat` vazio), então `TaskManager.defineTask` continua no topo do módulo, importado antes do componente raiz. Conferido por esse diff e por `node test/backgroundTask.test.js` (ok). Não conferi ao vivo: a Vitrine não tem conta, então `registerBackgroundRefresh` não roda e `dumpsys jobscheduler` não mostra tarefa do app. Conferir com uma instalação real.
- [ ] Não medido: `worklet-start` (maior que 150 ms seria o próximo candidato), falha do worklet e reconexão. Motivo: a Vitrine não sobe o worklet Bare nem o nó, então a marca não sai e não há caminho de falha para provocar. Também não vi `splash-end` na janela capturada (a Vitrine o libera por `patience` perto de 7 s, depois do fim das capturas).
- [ ] Não medido: release nativo, aparelho de verdade, PWA e web.

## Inline requires (T21), descartado

Decisão: descartado. Sob carga de 20 a 50 as medianas passaram da regra, mas com carga parecida o ganho ficou abaixo dela (`TotalTime` empatado, primeiras linhas de 0 a 9%); a revisão achou registros de limpeza (snapshots de tela, fotos guardadas) e o preload do nó web que passariam a carregar tarde. Fica para uma rodada medida em build de release, com um módulo de boot explícito.

Dados, Android a frio, A (HEAD) contra B (`inlineRequires: true`), intercalados ABABABABAB, Metro com `--clear` por partida:

- Bloco do T21, carga de 1 minuto 20 a 50 (outras sessões rodando testes): medianas `TotalTime` 1392 contra 1209 ms (-13%); `Start proc` a `first-rows` 9673 (n=4, uma partida de A perdeu a janela) contra 8303 ms (-14%); `app-commit` 1113 contra 763 ms. O par 9/10, com carga parecida (cerca de 21): `TotalTime` 878 contra 880 ms, primeiras linhas 7197 contra 6806 ms (-5%).
- Bloco repetido com a máquina calma (carga 8 a 20), 5 pares: `TotalTime` mediana 720 contra 714 ms; diferenças por par (B menos A) 24, -23, 49, -56, -108 ms. `Start proc` a `js-entry` 2226 contra 1951 ms (pares -171, -334, -140, -17, -369). `Start proc` a `first-rows` 5994 contra 5449 ms (-9%; pares -31, -779, -336, +82, -693). `app-commit` 721 contra 540 ms (pares -149, -180, -192, -181, -276).
- Leitura: sem carga, `TotalTime` empata e as primeiras linhas melhoram 9%, abaixo da regra de 10%. A melhora de `app-commit` é consistente, mas sozinha não passa na regra.
