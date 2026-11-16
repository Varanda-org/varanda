# Sobras da Espiadinha e dos Avisos: bytes em voo, páginas vazias e a medida do semeador (branch perf/peek-leftovers, parte da #539)

A #539 junta os limites que a rodada de carregamento instantâneo deixou documentados. Esta parte cuida de dois deles e da medida que faltava. Entrada do changelog em `docs/changelog/perf-peek-leftovers.md`.

## O que muda

- **Bytes em voo com blocos grandes demais (#459).** Um semeador pode servir, de diários certificados, blocos assinados acima de `MAX_BLOCK_BYTES` (16 KiB), até o limite de quadro de 1 MiB. A reserva conta 16 KiB por pedido em voo, então a Espiadinha podia ter cerca de 16 x 3 quadros (48 MiB) em voo numa leitura, e os Avisos 8 x 4 (32 MiB); um pedido cancelado em voo (alvo de uma lápide, janela parada) nunca é cobrado, mesmo que o bloco chegue. Agora a leitura conta todo byte de WebSocket que o semeador manda na ligação (`wire`, em `packages/web-member/lib/peek.js` e `notices.js`): passado o orçamento mais um quadro por diário em paralelo (16 MiB + 16 x 1 MiB na Espiadinha, 16 MiB + 8 x 1 MiB nos Avisos), a ligação fecha como no corte do orçamento e a página fica incompleta. Uma leitura honesta fica bem abaixo disso (o orçamento já a corta em 16 MiB cobrados). A reserva por pedido e `packages/web-member/lib/block-window.js` não mudam: reservar o quadro inteiro por pedido encadeado foi tentado e retirado, porque custou cerca de 200 ms na Espiadinha com 100 ms de ida e volta sem apertar o pior caso ("Medidas"). Um bloco grande demais continua encerrando só o seu diário.
- **Páginas vazias com quem segue quase todos (#467).** Uma leitura com descoberta pede no máximo 8 lotes de 48 candidatos (384 diários). Quem segue quase todos esses recebe uma página incompleta e vazia, com cursor, e a lista contava cada uma como seca até pausar com "carregar mais". Agora, numa carga de página seguinte, uma página incompleta que não acrescentou nada à lista continua lendo a partir do cursor dela, no máximo mais 3 leituras por carga (`readLaterPages` e `followsEmptyPage`, `apps/app/src/peek.js`; `loadMore` em `apps/app/src/screens/Espiadinha.js`). `peek.read` é leitura: uma leitura que falha encerra a carga com o erro de sempre e nunca é repetida. As regras de parada continuam: cursor que não andou numa página completa, fim da lista, lista expirada, tela escondida, leitura mais nova, e a pausa de páginas secas da lista depois disso. O cursor não é comparado: uma página vazia que parou à espera de candidatos traz o mesmo cursor que recebeu (`held`, `packages/web-member/lib/peek.js`) enquanto a travessia de candidatos do nó anda, então parar quando o cursor não muda desfaria a correção; o limite de 3 é o que segura um nó que nunca avança.
- **Medidor de carga com e sem descoberta.** `apps/cli/scripts/content-load.js` ganha `--no-discovery` (semeador com `discovery: false`) e diz no relatório se a descoberta estava ligada. Com `--inventory` acima de 48, o lote corta.

Formato do fio: sem mudança (`peek.read` e `notices.list` iguais). `docs/protocol.md` (custos da Espiadinha e dos Avisos) e `docs/rpc.md` (custos de `peek.read` e `notices.list`) descrevem o limite da ligação no lugar do "Residual" da reserva.

## Testes

Cada arquivo rodou sozinho (`node <arquivo>`, Node v24.22.1) nesta branch e, com os mesmos testes, sobre as fontes da `main` (os arquivos de `lib` ou `src` trocados pelos de `origin/main@56ea00f7`, depois restaurados).

| Arquivo | Branch | Fontes da `main` | Falham sem a correção |
|---|---|---|---|
| `packages/web-member/test/peek.test.js` | 43/43, 412/412 | 42/43, 406/408 | 43 (limite da ligação): página completa, 3.522.420 bytes servidos (na branch, incompleta com 604.122) |
| `packages/web-member/test/notices.test.js` | 24/24, 188/188 | 23/24, 187/188 | 22 (limite da ligação): a leitura só fecha pelo orçamento, com 11.424.258 bytes servidos (na branch, pelo limite, com 701.574) |
| `apps/app/test/peek.test.js` | 18/18, 119/119 | 16 passam, depois `TypeError: readLaterPages is not a function` | 17, 18 |
| o mesmo, branch com `PEEK_EMPTY_FOLLOW_MAX = 0` (sem seguir o cursor, como antes) | | 16/18, 111/119 | 17, 18 |
| o mesmo, branch parando a cadeia quando o cursor não anda (pedido na revisão, não aplicado) | | 17/18, 115/119 | 17: 2 leituras em vez de 3, porque a página vazia presa aos candidatos traz o cursor que recebeu |
| `apps/cli/test/content-load.test.js` | 4/4, 88/88 | o teste 1 falha na asserção de `discovery` e para em `--no-discovery` ("falta o valor de uma opção") | 1 |

Em `packages/web-member` a única mudança de código é o limite da ligação, então a coluna da `main` é também a branch sem ele. O número de asserções muda entre as colunas porque um teste que falha para em outro ponto. Os dois testes de regressão servem 30 diários com blocos de 100 KB (o Hypercore junta respostas, então blocos pequenos não mostram o excesso) com o orçamento em 8 MiB e o limite da ligação em 500 KB: na Espiadinha, cada diário enterra dois blocos grandes sob lápides, e os pedidos já em voo para eles são cancelados sem cobrança; nos Avisos, o primeiro bloco grande de uma linha a encerra e cancela os pedidos atrás dele. Os dois conferem que a leitura fecha incompleta perto do limite.

Também passam nesta branch, cada um sozinho: os testes do app que leem a Espiadinha (`avisosHosted` 32/32, `feedPreviews` 16/16, `feedRender` 15/15, `help` 15/15, `linkPreview` 19/19, `notices` 61/61, `postShareRow` 9/9, `requestPriority` 3/3, `ruaChrome` 15/15, `screensPolish` 17/17, `tabBar` 11/11, `platformGate` 6/6). `npm run lint` passa.

Suíte inteira de `packages/web-member` (`~/.claude/scripts/ci-lock.sh -- npm test -w packages/web-member`, Node v24.22.1): 104 arquivos, 0 falha, 1286/1286 testes, 12652/12652 asserções. As suítes de `apps/app` e `apps/cli` não rodaram inteiras; rodaram os arquivos acima, que leem o que mudou.

## Medidas

Node v24.22.1 neste Mac (Apple M4 Pro, 12 núcleos, 48 GB), não um celular: o nó do navegador (`createBrowserNode`, armazenamento em memória) no Node, com o semeador no mesmo processo, DHT local em 127.0.0.1, sem Docker. Tabela completa, comando e leitura em `docs/performance.md`, "Espiadinha e Avisos com e sem descoberta".

`node apps/cli/scripts/content-load.js --clients 4 --duration-ms 20000 --inventory 200 --json`, com e sem `--no-discovery`, intercalado, n = 3 de cada, carga de 1 min entre 5,2 e 6,0 (mediana [mínimo-máximo]):

| | Com descoberta | Sem descoberta |
|---|---|---|
| `peek.read` p50 / p95 (ms) | 95 [94-101] / 111 [111-120] | 383 [367-388] / 443 [435-450] |
| `notices.list` p50 / p95 (ms) | 17,6 [17,4-18,4] / 27,6 [27,4-31,3] | 11,6 [11,3-11,7] / 21,8 [21,1-23,7] |
| Bytes do semeador por abertura (KB) | 192 [192-193] | 525 [525-525] |
| Aberturas em 20 s | 408, 384, 412 | 164, 160, 168 |

Com 100 ms de ida e volta (`--rtt-ms 100`, n = 1): `peek.read` p50 1598 ms com descoberta e 6092 ms sem; `notices.list` 359 e 361 ms. Nenhuma falha nem erro interno em nenhuma execução.

A reserva de quadro por pedido encadeado, tentada primeiro para a #459, foi medida e retirada: com 100 ms de ida e volta, `peek.read` p50 1798 e 1800 ms com ela, 1596 ms com os arquivos de `main` e 1598 ms só com o limite da ligação. O pior caso não muda sem ela, porque o limite da ligação já o fixa. O diff dessa versão ficou fora do commit.

Ainda sem medida: celular de verdade e Chrome com CPU 4x.

## Conferência em aparelho

- [ ] TODO (sessão principal): Espiadinha numa conta que segue quase todos os diários recentes, no Android, no iOS e na web, depois do deploy: a lista mostra linhas sem passar por páginas vazias e sem "carregar mais" logo de cara. Não conferido nesta parte (só Node).
