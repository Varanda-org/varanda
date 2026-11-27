# Reabertura completa a partir da cópia do aparelho

Branch `fix/reopen-complete-from-cache`. Medição no laboratório hospedado, só na web, em Chrome headless. Os números abaixo são os que o laboratório imprimiu; nada foi estimado.

## Montagem

- Dois worktrees separados, cada um com `npm ci --ignore-scripts` e `npm run build:node -w apps/app`: o de `origin/main` (6ab83393e) com um remendo só de medição, sem commit, e o da branch (HEAD mais o trabalho não commitado).
- Remendo de medição na `main`: `perf-summary.js`, `Avisos.js` (só as marcas), `node.js` (só as linhas do registro), `openLine.js`, a marca `blocks-ok` de `blocksProvider.js` e as marcas `rows-snapshot:espiadinha` e `rows-live:espiadinha` de `Espiadinha.js`. Assim as duas passagens imprimem as mesmas marcas.
- Metro: `CI=1 EXPO_PUBLIC_VARANDA_PERF=1 npx expo start --web --port 8092 --clear` (em `apps/app`).
- Laboratório: `node apps/cli/scripts/hosted-lab.js --port 8135 --dataset 1 --dataset-size 60x150 --expo http://127.0.0.1:8092`, aberto em `http://localhost:8135`.
- Chrome headless com autenticador virtual (CTAP2, PRF, elegível a backup), CPU 4x mais lenta, janela de 420x900, preferência de tema clara, tudo por uma sessão DevTools única.
- Leitor criado no laboratório (celular de teste, código do laboratório), seguindo 40 dos 60 diários (os outros 20 ficam sem seguir para a Espiadinha ter linhas), com 40 publicações próprias e as 2 comunidades.
- Roteiro por tela (A Rua, Espiadinha, Diário Publicações, Diário Mural, Avisos, Conversas): abrir e esperar 45 s (para a cópia ser gravada), recarregar duas vezes esperando 20 s cada, e recarregar uma vez com as URLs `*/seeder*`, `*/media/*` e `*/index/*` bloqueadas (a rede "desligada": o shell vem do Metro). Bloquear também `/account` mostra a tela "Confirme sua idade", não as linhas, então essa lista não vale.
- Depois de cada recarga, a tela é aberta o mais cedo possível por um roteiro injetado na página (a aba monta só quando é tocada; A Rua é a única que abre sozinha), e `__varandaDev.report()` é lido antes da recarga seguinte. O resumo vem de `node apps/app/scripts/perf-summary.js` sobre essas leituras. Tempos em ms desde `js-entry`, com CPU 4x.
- As contagens (repostagem em esqueleto, linhas esqueleto, "Respondendo a …", imagens quebradas ou pendentes) vêm do DOM visível, lidas até 40 ms depois de cada marca (`blocks-ok`, `rows-snapshot*`) e no fim da espera. Heurística: folha com 14 px e raio 7 (esqueleto de repostagem), folha de 44 px com raio 22 e sem imagem (linha esqueleto), texto "Respondendo a …", `img` visível incompleta ou com largura 0.
- Os mesmos roteiros e a mesma montagem nas duas passagens; os dados vêm da mesma semente, mas o leitor e as chaves do laboratório são novos em cada passagem.

## Antes e depois por tela

Resumo do bloco Reabertura (mediana e p95, ms). Antes: `main` com o remendo, 18 execuções (abrir, 2 recarregas, em 6 telas). Depois: branch, 24 execuções (as mesmas mais a recarga com a rede bloqueada).

| Tela | ready até rows-snapshot | blocks-ok até rows-snapshot | rows-snapshot até rows-live |
|---|---|---|---|
| A Rua, antes | 1561 (p95 1617) | 1243 (1303) | 2730 (3284) |
| A Rua, depois | 1561 (p95 1600) | 1470 (1509) | 2538 (3018) |
| Espiadinha, antes | 1565 (1620) | 1247 (1307) | 3658 (3714), n=3 |
| Espiadinha, depois | 1565 (1604) | 1474 (1513) | 3079 (3159), n=4 |
| Diário (Publicações e Mural), antes | 1572 (1628) | 1253 (1315) | 4391 (7048), n=6 |
| Diário (Publicações e Mural), depois | 1573 (1612) | 1482 (1521) | 4280 (4484), n=8 |
| Avisos | sem cópia (n=0) | sem cópia | sem cópia |
| Conversas | sem cópia (n=0) | sem cópia | sem cópia |

Leitura:
- A cópia salva pinta em cerca de 1,56 s depois de `ready` nas duas passagens: neste laboratório web o tempo até a cópia não mudou.
- A resposta de `block.list` veio antes: `blocks-ok` mediano de cerca de 620 ms (antes) para cerca de 400 ms (depois) desde `js-entry`; o pedido `req:block.list` passou de mediana 288 ms (mín. 238, máx. 324, n=24) para 67 ms (mín. 53, máx. 75, n=24). Por isso "blocks-ok até rows-snapshot" fica maior depois: a marca anda para trás, não a pintura para frente.
- Em Avisos e Conversas o leitor não tem avisos nem conversas, as cópias guardadas são vazias (cerca de 260 bytes) e não há `rows-snapshot` nas duas passagens (`sem cache`).

Contagens no quadro da cópia salva, em `blocks-ok` e depois do vivo (esqueleto de repostagem / linhas esqueleto / "Respondendo a …" / imagens quebradas+pendentes). Nas duas passagens:
- Em `blocks-ok` ainda não há linhas na tela (a marca vem antes da pintura da cópia): tudo 0.
- Na cópia e depois do vivo: 0 esqueletos de repostagem, 0 linhas esqueleto, 0 imagens quebradas ou pendentes em todas as telas.
- "Respondendo a …": 1 na Espiadinha na cópia salva da passagem antes (nas 3 execuções), 0 na passagem depois; 0 nas demais telas.
- Imagens visíveis depois do vivo: 7 na Espiadinha nas duas passagens; 1 em A Rua e em Conversas.

Neste conjunto de dados a passagem antes já não mostrou repostagens em esqueleto na Espiadinha (0 esqueletos de repostagem na cópia e no fim), então o laboratório não reproduziu o esqueleto do aparelho do dono. Só o "Respondendo a …" apareceu uma vez na cópia antes e não depois.

## Rede desligada

Recarga com seeder, mídia e índice bloqueados:
- Depois: A Rua, Espiadinha e Diário pintam a cópia em cerca de 1,9 s (`rows-snapshot` 1860 a 1916), as linhas ficam, 0 imagens quebradas ou pendentes, com a nota "Números incompletos" no topo.
- Antes (segunda tentativa, mesma lista bloqueada): o mesmo, `rows-snapshot` entre 1836 e 1895 nas telas com cópia; 0 imagens quebradas.
- Avisos e Conversas: telas vazias nas duas passagens (sem dados no laboratório).

## Tempos de pedido (mediana, mín., máx., ms; execuções somadas)

| Pedido | Antes | Depois |
|---|---|---|
| `block.list` | 288 (238 a 324), n=24 | 67 (53 a 75), n=24 |
| `peek.read` | 700 (662 a 1384), n=18 | 524 (502 a 950), n=24 |
| `feed.read` | 765 (694 a 1186), n=18 | 750 (382 a 1880), n=25 |
| `notices.list` | 56 (47 a 1355), n=18 | 60 (46 a 1453), n=24 |

`log.read` mistura leituras de diários diferentes (o próprio e os de outros), por isso não vai na tabela: mediana 309 ms antes e 310 ms depois, sem separar com e sem `posts`.

## Cópia gravada na primeira abertura

Depois (branch), no primeiro uso com o leitor novo, lendo as chaves `varanda-screen-*` de `localStorage` a cada 1 s a partir da abertura da Espiadinha (o Diário foi aberto 4 s depois):
- `varanda-screen-espiadinha`: gravada em 4 s, regravada em 8 s.
- `varanda-screen-diario`: gravada em 10 s (cerca de 6 s depois de abrir o Diário).
- `varanda-screen-listas`: 7 s.

Antes (`main`): essa leitura por segundo não foi feita. Na primeira passagem, com esperas de 22 s, as cópias da Espiadinha e do Diário ainda não existiam; depois de 30 a 40 s existiam (medido só por essa inspeção grosseira). Não é comparação direta.

## Registro de sincronização

Ajustes, Avançado, Sincronização, Ver registro (mostra só as últimas linhas):
- Depois: `aviso: listas 230 ms` e `aviso: listas 237 ms` em duas aberturas. Nenhuma linha `abertura` apareceu (a abertura levou menos de 1 s). `cópias locais apagadas` não apareceu (nenhum apagamento).
- Antes: o registro tinha só as últimas 14 linhas, todas de pedidos lentos; nenhuma linha `listas` nem `abertura` foi lida.

## Repro da aba em branco

No laboratório, com 40 publicações e depois 31 curtidas pela interface (os botões passaram a "descurtir"), a aba Publicações da `main` não ficou em branco: mostrou "Post do leitor 40, 39, …" nas 3 execuções. A branch também mostra as publicações (execuções abrir, recarga 1 e 2). Ou seja, o laboratório não reproduziu o branco com esse método; as curtidas pela interface talvez não entrem na página do `log.read` como no aparelho do dono. A leitura só de publicações (`posts`) fica coberta por `diarioSnapshot.test.js` e `diarioSlim.test.js`, e o filtro por `packages/core/test/log-read-posts.test.js` e `packages/web-member/test/log-read-posts.test.js`.

## Não verificado

- O aparelho do dono (compilação de release do Android e iOS): tempo até as listas de bloqueio, linha `abertura`, e se a segunda abertura pinta da cópia salva.
- A Vitrine no emulador Android e no simulador iOS: não foi rodada (ela não inicia o worklet de qualquer forma).
- Imagens de fotos e capas na lista: só a contagem das `img` visíveis numa janela de 420x900; as fotos fora da janela não foram contadas.
- Avisos e Conversas com dados (nomes e avatares): o leitor não tem avisos nem conversas, e uma segunda identidade (seguir, curtir, mensagem direta) não foi montada. Sem número.
- `log.read` com e sem `posts: true` num diário de 60x150: o gancho de desenvolvimento da página só aceita `follow.add`, `community.join` e `post.create`. Sem número.
- Repro do branco com 31 curtidas: não reproduzido (acima).
- Cópia reescrita depois de uma abertura a frio: só se viu que as chaves existem e que a da Espiadinha foi regravada (4 s e 8 s); uma gravação recusada por troca de geração e não rearmada não foi verificada.
- Linha `abertura` do registro e `cópias locais apagadas`: não apareceram, então não foram conferidas; o registro na `main` não foi lido.
- Passagem antes da cópia salva a frio na `main` com a mesma leitura por segundo: não feita.
- Telas só na web: nenhum número de Android nem de iOS.
