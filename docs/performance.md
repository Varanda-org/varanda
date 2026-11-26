# Desempenho do carregamento de conteúdo

Como medir o carregamento de A Rua, Diário, perfis e Conversas, e como decidir se uma mudança melhorou ou piorou. Este documento é o ciclo de medição: os números de cada rodada ficam na seção [Resultados](#resultados).

## Para que serve

Medir o carregamento de A Rua, Diário, perfis e Conversas no PWA, no Android e no iOS, com o mesmo conjunto de dados, antes e depois de cada mudança. Sem o mesmo conjunto e as mesmas ferramentas, a comparação não diz nada.

## Conjunto de dados D1

| Parte | Tamanho |
|---|---|
| Diários seguidos | 60 |
| Blocos por diário seguido | 150 |
| Diário próprio (no bench) | 800 blocos |
| Certificados | versão 2, com nome de usuário |
| Verificação de assinatura | em JavaScript puro, como no navegador |
| Posts com foto (no laboratório) | cerca de 20% |

Fator de celular: 3x, aplicado só à CPU. Rede e disco não recebem fator. Os números do nó no computador são uma aproximação do celular, não uma medida dele.

## Ferramentas e comandos

### Nó, IndexedDB (PWA)

```sh
node packages/web-member/scripts/startup-bench.js --follows 60 --blocks 150 --own 800 --idb --issued --js-verify --reads --reads-twice --log --runs 5 --json
```

### Nó, arquivos (app Android e iOS)

O mesmo comando, com `--file` no lugar de `--idb`. Acrescente `--lease-gap` para medir a leitura feita logo depois que a concessão nativa termina a sincronização (`leaseGapReadMs`).

```sh
node packages/web-member/scripts/startup-bench.js --follows 60 --blocks 150 --own 800 --file --issued --js-verify --reads --reads-twice --lease-gap --log --runs 5 --json
```

### Campos do resultado

| Campo | O que mede |
|---|---|
| `medianMs` | Até o leitor ser publicado (mediana das execuções). |
| `startup.ownReads` | Leituras do diário próprio na partida. |
| `feedMs`, `feed2Ms` | Primeiro e segundo `feed.read`. |
| `profileMs`, `profile2Ms` | Primeiro e segundo `profile.read` de 61 autores. |
| `engagementMs` | Leitura das curtidas e reposts. |
| `logPage1Ms`, `logPage8Ms` | Página 1 e página 8 do `log.read`. |
| `leaseGapReadMs` | Leitura depois do fim da concessão (só com `--lease-gap`). |
| `phases.*` | Operações de armazenamento por fase. |

### Laboratório com dados

```sh
node apps/cli/scripts/hosted-lab.js --port 8123 --dataset 1 [--dataset-size 60x150] [--rajada]
```

O app roda em modo de desenvolvimento com `EXPO_PUBLIC_VARANDA_PERF=1`, com o Metro em outra porta e o laboratório apontado para ele com `--expo http://127.0.0.1:<metro>`.

Passos no Chrome:

1. Abrir sempre `http://localhost:<porta>`, nunca `127.0.0.1`: o `rp.id` da passkey não pode ser um endereço IP.
2. Abrir DevTools, em WebAuthn, e criar um autenticador virtual com CTAP2, chave residente, verificação do usuário e suporte a PRF.
3. Entrar no app com esse autenticador.
4. Colar no console o arquivo `reader-setup.js` que o laboratório indica. Ele segue os 60 diários pelo `__varandaDev.request`, que só existe no modo de desenvolvimento com `EXPO_PUBLIC_VARANDA_PERF=1`.

### Preload do nó na exportação web

O `finish-web.js` inclui no `<head>` do `index.html` um `<link rel="preload" as="script" href="/varanda-node-<hex>.js">`, com o caminho da versão da página. Assim, o navegador pode buscar o nó antes de o bundle principal executar `preloadNode`. O link não tem `integrity` nem `crossorigin`, como o script criado por `loadNode`, para permitir o reaproveitamento da busca.

O hash SHA-256 do índice no manifesto do service worker inclui o link. Uma nova execução remove o link gerado anterior antes de calcular a versão, mantendo os arquivos idênticos byte a byte. Verificação em `docs/verification/fix-web-shell.md`. Ganho de tempo e reaproveitamento da requisição em navegador real ainda não medidos.

### Marcas de tempo

Só em desenvolvimento (`__DEV__`) e só com `EXPO_PUBLIC_VARANDA_PERF=1`: as marcas viram linhas `perf: <nome> <ms> [extra]` no console e nunca são enviadas nem guardadas. Todas contam em ms desde `perf: js-entry 0 origin`, a primeira linha de cada execução (`src/perfEntry.js`, importado logo depois do polyfill de cripto em `index.js`).

- Partida, impressas na hora: `sweep-media-cache` e `worklet-start` (duração de cada passo), `app-commit` (primeiro commit do React), `first-rows:<perfId>` (primeira vez que a lista tem linhas), `scroll-start:<perfId>` e `scroll-done:<perfId>` (rolagem roteirizada, abaixo).
- Do nó, uma vez cada: `config`, `sync.status`, `identity.status`, `ready`, `req:<método>` (duração do pedido), `first-rows`, `details`, `moments`, `splash-end` (com `feedReady` ou `patience`), `rows-snapshot` e `rows-live` (com sufixo `:diario`, `:membro`, `:conversas` ou `:comunidades`), `preview-shown`, `media-hash` e `tab:<id>`.
- Renderização: `perf: render <id> <vezes> <ms somados>` pelo `Profiler` do React (tempo de render, `actualDuration`, não de commit). Ids `tab:<rua|espiadinha|busca|avisos|comunidades|feira|diario>` para cada aba montada e `list:<perfId>` para cada lista. Fora da rolagem roteirizada sai no máximo a cada 5 s; durante ela nada é impresso até o fim, e as linhas levam ` phase=scroll:<perfId>`.
- Quadros: `perf: frames n= p50= p95= max= over32= list=<perfId> run=scroll rows= mounts= unmounts= rendersPerMountMedian= rendersPerMountP95=`, impressa em `scroll-done`. Com rolagem à mão, a linha sai sem `run=scroll` depois de cada pausa.
- O contador de linhas (`rows`, `mounts`, `rendersPerMount*`) é mantido por lista (`list=<perfId>`): cada linha `frames` conta só as linhas da própria lista. O custo das abas escondidas que renderizam durante a rolagem aparece nas linhas `render`, não aqui. Não compare as contagens de linhas `frames` de rolagem à mão com as da `run=scroll`.
- Nós: as marcas do nó (`splash-end` inclusive) só saem quando `details` assenta ou numa troca de aba (`apps/app/App.js`, perto das linhas 3014 a 3026); na Vitrine, `details` não assenta, então elas só saem depois de um toque numa aba. A rolagem roteirizada começa (6,2 a 7,0 s) antes de a cobertura do splash sair (cerca de 7,7 s depois de `js-entry`).

Resumo de um registro salvo (logcat ou console do Metro): `node apps/app/scripts/perf-summary.js <registro>` dá execuções, marcas, renderizações por execução e quadros (n, mediana, p95, dispersão). Conta uma amostra por lista e por execução: uma linha `run=scroll` vale pela execução; sem ela, as linhas de rolagem à mão da execução são combinadas (p50 e p95 ponderados por n, aproximados). O script só aceita fichas feitas dos caracteres que a harness imprime (letras, dígitos, `: . _ / = -`) e pula qualquer outra linha, então caracteres de controle de um registro nunca chegam ao terminal. O script conta qualquer linha com `perf: `, de qualquer processo: salve o logcat filtrado pelo processo do app (`adb logcat --pid=$(adb shell pidof -s app.varanda.debug)`), porque um filtro de tag sozinho não impede que outro app do aparelho escreva linhas que mudem os números.

### Lista nativa sem conta (Vitrine)

A Vitrine mostra as telas hospedadas com dados de exemplo, sem conta, sem iniciar o worklet do nó e sem sincronização. Variáveis (só em build de desenvolvimento; valem no Metro, então mudar qualquer uma pede reiniciar o Metro com `--clear` e abrir o app de novo; `CI=1 expo start` não observa arquivos):

| Variável | Efeito |
|---|---|
| `EXPO_PUBLIC_VARANDA_VITRINE=1` | Telas hospedadas com dados de exemplo. |
| `EXPO_PUBLIC_VARANDA_VITRINE_LARGE=1` | 200 linhas extras no feed, só texto. |
| `EXPO_PUBLIC_VARANDA_VITRINE_RICH=1` | Com LARGE: linhas variadas (a cada 50: 5 com uma foto, 2 citações com grade, 2 carrosséis de seis fotos, cartão de link, respostas, citações, republicações). |
| `EXPO_PUBLIC_VARANDA_VITRINE_EMBEDS=1` | Com LARGE e RICH: 4 de cada 50 linhas viram players de verdade (YouTube, SoundCloud, Spotify, Apple Music), que falam com o provedor. |
| `EXPO_PUBLIC_VARANDA_PERF=1` | Marcas, renderizações e quadros acima. |
| `EXPO_PUBLIC_VARANDA_PERF_SCROLL=<perfId>` | Rolagem roteirizada da lista: começa 3 s depois de a lista ter linhas e a tela dela estar visível, dura 60 s a cerca de 1200 px/s, com 4 inversões, e mexe nas barras de A Rua como um dedo (`notifyUserScroll`). Uma vez por execução. Se a tela ficar escondida no meio da rolagem, imprime `perf: scroll-aborted list=<id> hidden`, a execução é descartada (o resumo ignora as linhas de render parciais) e a rolagem não se repete nessa partida. Use só com uma lista visível na abertura (`rua`, o feed de A Rua); para as outras, role à mão com `adb shell input swipe`. |

Exemplo:

```sh
cd apps/app && CI=1 EXPO_PUBLIC_VARANDA_VITRINE=1 EXPO_PUBLIC_VARANDA_VITRINE_LARGE=1 EXPO_PUBLIC_VARANDA_VITRINE_RICH=1 EXPO_PUBLIC_VARANDA_PERF=1 EXPO_PUBLIC_VARANDA_PERF_SCROLL=rua npx expo start --port 8097 --clear
```

Depois:

- Emulador Android: `adb reverse tcp:8081 tcp:8097` e `adb shell am start -W -n app.varanda.debug/app.varanda.MainActivity` (o `TotalTime` mede até o primeiro quadro da atividade, antes do JavaScript). Se o app procurar outro Metro, confira `debug_http_host` nas preferências do app de debug.
- Simulador iOS: `xcrun simctl spawn booted defaults write app.varanda RCT_jsLocation localhost:8097` e `xcrun simctl launch booted app.varanda` (o build de debug procura o Metro na porta 8081; sem a linha `defaults`, suba o Metro na 8081).

### Outros navegadores e aparelhos (tentativa)

| Ambiente | Como | Observação |
|---|---|---|
| Chrome no Mac com CPU 4x mais lenta | DevTools, Performance, CPU throttling | Faz o papel do celular para o PWA. |
| Chrome no emulador Android | `adb reverse tcp:<porta> tcp:<porta>`, depois `http://localhost:<porta>` | Tentativa. |
| Safari no simulador iOS | `http://localhost:<porta>` | Tentativa. |

Se a passkey com PRF não funcionar no emulador ou no simulador, registrar a medida como não medida, sem estimar o número.

### Limites

- O app nativo de desenvolvimento não entra no laboratório local: ele só aceita instalação https, e a passkey precisa do domínio associado.
- Os números do nó nativo vêm do bench com `--file`.
- Os números da interface nativa vêm da Vitrine grande.
- O celular de verdade só é medido depois do deploy.

## Metas provisórias

Metas para o conjunto D1, com a mediana de 5 execuções. Os valores de "hoje" são os da rodada M0 (seção Resultados).

| Métrica | Meta | Hoje |
|---|---|---|
| Leitor publicado (`medianMs`) | <= 450 ms | 567 ms em IndexedDB, cerca de 260 ms em arquivos (M0); M4: 21,6 e 6,2 ms |
| Primeiro `feed.read` | <= 70 ms | 131 ms em IndexedDB, 235 a 341 ms em arquivos (M0); M4: 48,9 e 47,2 ms |
| Segundo `feed.read` | <= 15 ms | 124 ms em IndexedDB, 202 a 232 ms em arquivos (M0); M4: 36,0 e 34,2 ms, meta não atingida |
| `profile.read` de 61 autores | <= 120 ms | 193 ms em IndexedDB, 284 a 333 ms em arquivos (M0); M4: 211,2 e 201,4 ms, meta não atingida |
| `log.read`, página 8 | <= 1,5x a página 1 | 4 ms em IndexedDB e 18 a 26 ms em arquivos, as duas páginas iguais |
| Leitura depois do fim da concessão (`leaseGapReadMs`, arquivos) | <= 100 ms | 390 a 476 ms (M0); M4: 270 ms, meta não atingida |
| Chrome 4x, laboratório: até as linhas de A Rua | <= 2,5 s (o splash fica sempre os 1,5 s da apresentação inteira, contados na web da pintura da página; a rodada M0 media com o mínimo antigo, que valia só para carregando, conectando ou introdução e Termos a seguir) | 5,8 s (build de produção), 6,5 s (desenvolvimento) |
| Chrome 4x, laboratório: troca de aba | <= 400 ms | a medir |
| Chrome 4x, laboratório: perfil | <= 500 ms | a medir |
| Chrome 4x, laboratório: rajada de 2 minutos | nenhum "pedidos demais em andamento" e nenhum "pedido lento" | a medir |
| Vitrine grande nativa: primeiro commit da lista | <= 300 ms | M0 iOS: linhas 2,05 s depois de o JavaScript carregar (desenvolvimento). M4: iOS 681 a 690 ms, Android 1070 ms (desenvolvimento), meta não atingida |
| Vitrine grande nativa: p95 de quadro, rolagem de 60 s | <= 32 ms | M4: iOS 17,1 a 17,3 ms (atingida); Android 31,75 e 38,21 ms (atingida numa execução, não na outra; carga alta) |
| Vitrine grande rica nativa: renders por linha montada, rolagem de 60 s | 1 | M5: Android 1 (P95 3), iOS 1 (P95 3), web 1 (P95 2); atingida (era 2 no PR1 no Android e no iOS) |

Os números da rodada M5 (iOS: primeiras linhas 2769 ms, p95 de 31,5 a 32,5 ms; Android: primeiras linhas 3465 ms) usam outro método que as linhas M4 (rolagem roteirizada com inversões, origem em `js-entry`, Vitrine rica): não se comparam sem um A/B, e nenhuma meta foi reavaliada. Os números da ponta da pilha (seção "M5, resultados": renderizações por linha montada 1 nas três plataformas, iOS p95 de 24,5 a 26,7 ms, Android primeiras linhas 3914 ms desde `js-entry`) usam o mesmo método da linha de base M5; só a meta de renderizações por linha foi avaliada com eles, as demais metas ficam como estão.

As metas são provisórias: podem mudar depois da primeira rodada, com a justificativa anotada na seção Resultados.

## O ciclo

1. Depois de cada PR, medir de novo tudo o que ele pode mudar.
2. Uma tarefa condicionada só roda se a medida dela ainda estiver fora da meta.
3. Parar de trabalhar numa métrica quando duas rodadas seguidas mudarem menos de 10%.
4. "Bom o bastante" quer dizer: todas as metas em 3 execuções seguidas, sem falha de teste de privacidade e sem regressão.
5. O celular de verdade confirma depois do deploy. Nunca afirmar resultado de celular a partir de simulador ou de emulador.

## Resultados

Preenchido ao fim de cada rodada.

### M0, linha de base (07/11/2026, main@e8e477b6)

Mac M4 Pro, Node 24.22.1, com outras sessões usando a máquina (carga média entre 15 e 19), então cada número é a mediana de 5 execuções e as comparações valem entre rodadas feitas do mesmo jeito.

- Nó, D1 com `--js-verify`: leitor publicado 567 ms em IndexedDB e cerca de 260 ms em arquivos; a verificação de assinaturas sozinha leva de 273 a 361 ms. A partida lê o diário próprio uma vez (799 blocos); cada leitura seguinte lê todos os blocos de novo (9800 leituras no feed, iguais na primeira e na segunda vez), porque nenhum bloco fica em cache.
- Arquivos (o caminho do app instalado): `feed.read` 235 a 341 ms, segundo 202 a 232 ms; depois do fim da concessão de 8 s do app instalado, uma leitura leva 390 a 476 ms.
- Chrome com CPU 4x no laboratório D1 (60 diários x 150 blocos, cerca de 1800 fotos): linhas de A Rua na tela em 5,8 s no build de produção (entre 5,8 e 8,7 s) e 6,5 s no de desenvolvimento; primeira foto em 6,5 s e 7,5 s. No desenvolvimento as linhas ficam prontas em cerca de 4,5 s, mas o splash espera os detalhes (nomes, contagens, originais) até cerca de 6,1 s.
- Pedidos mais lentos na partida (desenvolvimento, 4x): `profile.read` 2,7 s, `node.info` 3,1 s (4 vezes), `feed.read` até 2,7 s, `dm.enable` 1,6 s, `community.list` 1,6 s, `dm.list` 1,2 s, `engagement.read` 1,1 s.
- Vitrine grande no simulador iOS (iPhone 17 Pro, iOS 26.2, desenvolvimento): linhas 2,05 s e fim do splash 2,17 s depois de o JavaScript carregar, estável em 3 execuções. Android: não medido nesta rodada (outro emulador ocupava a CPU).
- O semeador limita `/media` de forma global (64 pedidos por segundo, 16 em andamento); acima disso responde 503 e o app desiste da foto em vez de tentar de novo.

### M1, cache de blocos e validação única (PR perf/read-cost)

- Nó, D1: leituras do armazenamento por `feed.read` de 11000 para 5; `feed.read` de 139 para 41 ms em IndexedDB e de 367 para 48 ms em arquivos; segundo `feed.read` 36 ms e 29 ms.
- Chrome 4x, build de produção: linhas de A Rua em 3,76 s (eram 5,8 s); primeira foto em 4,1 s.

### M2, partida mais quieta (PR perf/quieter-boot)

- Chrome 4x, desenvolvimento: linhas em 3,8 s (eram 6,5 s); na partida não há mais `dm.list`, `community.list` nem `community.info`; `node.info` caiu de cerca de 3 s para cerca de 95 ms.
- Chrome 4x, produção: linhas em 3,53 s, primeira foto em 3,94 s.
- O que sobra: o primeiro `profile.read` espera a partida do nó publicar os núcleos (cerca de 2,2 s com CPU 4x), e a maior parte disso é verificar cerca de 122 assinaturas em JavaScript puro.

### M3, renderização (PR perf/app-render)

- Chrome 4x, produção: linhas em 3,47 s, primeira foto em 3,89 s. A renderização não está no caminho crítico da primeira tela na web; o ganho aparece em menos redesenhos durante a sincronização e a rolagem.
- Vitrine grande no emulador Android: sem número confiável nesta rodada (a máquina estava com carga entre 11 e 28).

### M4, instalação rápida (pilha de 19 PRs, `docs/perf-m4`, 10/11/2026)

O que mudou: partida pela configuração lembrada e sem tempo fixo de splash; Espiadinha e Avisos com blocos em paralelo e páginas de candidatos; nó que não espera o armazém de mensagens; leitor publicado antes do fim da sincronização da partida; dobras de conversas e grupos com memória; fotos, A Rua e outras telas a partir da última primeira página; A Rua no lugar do splash; fila de pedidos com faixa de segundo plano; hash nativo das fotos; atualização de A Rua com o app fechado. Detalhes de cada PR em `docs/verification.md` seções 152 a 169.

Nó no Mac M4 Pro, Node v24.22.1, commit 4b8a5e94, conjunto D1 com `--js-verify`. Comando de cada linha (as três execuções de cada caso foram feitas uma depois da outra, cada uma com `--runs 5`; a tabela dá a mediana das três medianas; JSON em saída local, não versionada, arquivos `<caso>-r<n>.json`; carga média de 1 min lida com `uptime` no início de cada execução, em saída local, não versionada):

```sh
node packages/web-member/scripts/startup-bench.js --follows 60 --blocks 150 --own 800 --issued --js-verify --reads --reads-twice --log --steps --early-reads --runs 5 --json --file --lease-gap   # caso file
node packages/web-member/scripts/startup-bench.js ... --idb                                                                                                              # caso idb
node packages/web-member/scripts/startup-bench.js ... --file --dm-rows 5000                                                                                              # caso file-dm
node packages/web-member/scripts/startup-bench.js ... --file --groups 20 --group-blocks 200                                                                               # caso file-groups
```

Carga média de 1 min no início das execuções: file 7,91, 7,53, 6,60; idb 5,90, 5,36, 5,12; file-dm 4,57 (execução 1), 4,96, 4,67. Valores em ms.

| Métrica | M0 (e8e477b6, 5 execuções) | M4 arquivos | M4 IndexedDB | Meta |
|---|---|---|---|---|
| Leitor publicado (`medianMs`) | cerca de 260 (arquivos), 567 (IndexedDB) | 6,2 | 21,6 | <= 450 (atingida) |
| Primeiro `feed.read` | 235 a 341 (arquivos), 131 (IndexedDB) | 47,2 | 48,9 | <= 70 (atingida) |
| Segundo `feed.read` | 202 a 232 (arquivos), 124 (IndexedDB) | 34,2 | 36,0 | <= 15 (NÃO atingida) |
| `profile.read` de 61 autores | 284 a 333 (arquivos), 193 (IndexedDB) | 201,4 | 211,2 | <= 120 (NÃO atingida; domina a verificação de 122 assinaturas em JavaScript puro, `verifyMs` 323,5 e 320,7) |
| Segundo `profile.read` | n/d | 45,6 | 43,6 | n/d |
| `log.read` página 8 / página 1 | 18 a 26 / igual (arquivos) | 0,4 / 0,5 | 2,4 / 2,5 | <= 1,5x (atingida) |
| Leitura depois do fim da concessão (`leaseGapReadMs`) | 390 a 476 | 270 | n/d | <= 100 (NÃO atingida) |
| Leitura própria antecipada (`earlyOwnReadMs`) | n/d | 31,0 | 37,3 | n/d |
| Leitura de A Rua antecipada (`earlyFeedReadMs`) | n/d | 368,5 | 590,7 | n/d |
| Partida concluída (`startupSettledMs`) | n/d | 251 | 570,3 | n/d |

Caso `--dm-rows 5000` (arquivos): `dmUnlockMs` 175,5 e `dmListMs` 11,1 (mediana das três medianas). Antes (E2, `e2-before-E10.json`, outro conjunto de execuções, 3 execuções): o desbloqueio não era medido nesse arquivo; as notas do E2 registram 184 ms com 5000 linhas. Desde a branch `fix/dm-unlock-leftovers` (parte da #539), `unlock()` do armazém e do motor termina no estágio da chave e a carga das linhas segue depois (`loaded()`); a bancada mede o estágio da chave em `dmKeyMs` e os dois juntos em `dmUnlockMs`, e mede à parte a primeira página desde o início de outro desbloqueio, nos núcleos já abertos pelas leituras anteriores: com o resumo selado (`dmFirstPageSummaryMs`) e sem ele (`dmFirstPageNoSummaryMs`, a página espera todas as linhas). Três execuções de `node packages/web-member/scripts/startup-bench.js --file --dm-rows 5000 --runs 5 --json` no mesmo Mac M4 Pro, Node v24.22.1, com outras sessões rodando (carga média de 1 min 17,89, 33,11 e 31,28 no início): `dmKeyMs` 1,7, `dmUnlockMs` 299,4, `dmListMs` 18,5, primeira página com o resumo 2,5 e sem o resumo 278,6 (mediana das três medianas; medianas de cada execução em `docs/verification/fix-dm-unlock-leftovers.md`). Números do Node num Mac, não de um celular: o que compara é a diferença entre as duas primeiras páginas.

Caso `--groups 20 --group-blocks 200`, no commit da ponta, uma execução com `--runs 5` (saída local, não versionada, carga média 4,65 no início, levou cerca de 10 min): `groupListMs` 764,5, `groupList2Ms` 90,3, `communityListMs` 25,2 e `medianMs` 99,1, iguais aos do E13. As execuções 2 e 3 não foram esperadas. Os números do E13, medidos no PR perf/dm-group-reads (3 execuções, saída local, não versionada sem a memória e saída local, não versionada com ela): `groupList2Ms` 778,2 para 90,2 ms, `groupListMs` 1099,4 para 756,4 ms, `communityListMs` 42,6 para 27,7 ms. Antes do E13 (notas do E2): `groupListMs` 1467,6, `groupList2Ms` 1449,3 e `communityListMs` 59,4 ms. Fica por fazer só repetir o caso duas vezes mais.

Efeito do E10 (leitor antecipado), 3 execuções, arquivos, `--steps --early-reads`, `e2-before-E10.json` contra `e2-after-E10.json`: `readerPublishedMs` 327,2 para 9,5; `earlyOwnReadMs` 329,1 para 35,2; `earlyProfileReadMs` 333,1 para 39,4; `earlyFeedReadMs` 452,9 para 461,9 (sem ganho, a passada dos seguidos domina: no M4, o passo "seguidos (abertura)" leva cerca de 203 ms em arquivos e 532 ms em IndexedDB nos arquivos `file-r*.json` e `idb-r*.json`); `startupSettledMs` sem mudança (327 para 327).

Efeito do E8 (candidatos em páginas) no medidor de carga, 4 clientes, 20 s, `e1-before-E8.json` contra `e1-after-E8.json`: `peek.read` p50 49,71 para 48,6 ms e p95 69,73 para 68,48 ms, `notices.list` p50 9,76 para 10,3 ms. O conjunto do medidor tem menos de 48 diários, então o lote não corta nada: sem ganho esperado. A abertura de uma conta com milhares de diários não foi medida.

Capacidade do semeador em loopback: `docs/seeder-capacity.md` (comandos e tabelas ali). Sem mudança de teto; as recusas vêm de `maxExternal` 32 e de `MEDIA_RATE`.

Hash das fotos no app (build de desenvolvimento, 30 fotos de 100 a 400 KiB, 3 execuções por plataforma, saída local, não versionada, `mismatches=0`):

| Plataforma | Nativo (ms) | JavaScript (ms) | Carga média de 1 min na execução |
|---|---|---|---|
| Android (emulador varanda-perf) | 1,4 / 1,0 / 1,0 | 958,9 / 870,2 / 937,2 | 29,27 / 6,70 / 8,37 |
| iOS (simulador iPhone 16e) | 0,2 / 0,2 / 0,2 | 228,7 / 224,1 / 230,8 | 9,20 / 8,87 / 7,78 |

A mudança do PR perf/native-hash passa do corte de 20% nas duas plataformas e foi mantida. Esta medida compara só o hash, não a abertura de uma foto inteira.

Vitrine grande, build de desenvolvimento, 60 s de rolagem, linhas `perf: frames` (saída local, não versionada; carga média de 1 min no início da rolagem entre parênteses):

| Plataforma | Execução | quadros (n) | p50 (ms) | p95 (ms) | acima de 32 ms |
|---|---|---|---|---|---|
| iOS | 1 (8,60) | 1848 | 16,67 | 17,13 | 30 |
| iOS | 2 (5,67) | 1847 | 16,67 | 17,29 | 29 |
| iOS | 3 (7,42) | 1847 | 16,67 | 17,34 | 31 |
| Android | 1 | rolagem fragmentada, descartada (`frames-runs-android-invalid.txt`) | n/d | n/d | n/d |
| Android | 2 (15,77) | 2359 | 16,71 | 31,75 | 112 |
| Android | 3 (12,57) | 2327 | 16,84 | 38,21 | 193 |

Primeiro commit da lista (`first-rows`, mesmas execuções): iOS 686, 690 e 681 ms; Android 1070 ms numa execução (`metro-frames.log` mostra também 8110 ms noutra execução; a causa não foi investigada). A meta de 300 ms NÃO foi atingida em nenhuma plataforma. O p95 de quadro de 32 ms foi atingido no iOS e no Android na execução 2 (31,75), e não na 3 (38,21). Como a margem é pequena e a carga da máquina (entre 5 e 29) passa dos 10% do corte do ajuste condicionado, o E25 (ajuste das constantes da lista) NÃO rodou; fica por fazer numa máquina quieta ou no celular. O fim do splash (`splash-end`) saiu com o motivo `grace` em 1226, 1221 e 1209 ms no iOS e 1637 ms no Android (execução 3).

Não medido nesta rodada, e por quê:

- `peek.read` e `notices.list` contra um semeador com descoberta (páginas de candidatos) e contra um com `discovery: false`, no mesmo conjunto: o medidor de carga não tinha opção para desligar a descoberta e o conjunto do E8 tem menos de 48 diários, então o lote não corta nada. Medido depois, com `--no-discovery` e 200 diários: "Espiadinha e Avisos com e sem descoberta", abaixo.

- Chrome com CPU 4x, segunda abertura no laboratório: não rodado nesta tarefa.
- `rows-snapshot`, `preview-shown` e a tarefa de segundo plano de um membro com conta: o build de debug do emulador e do simulador não entra com passkey em produção ("Limites"). Ficam para o aparelho depois do deploy.
- Medidas em celular de verdade: só depois do deploy.
- O caso de grupos no commit da ponta, acima.
- Tarefas que não rodaram por regra: E11 (a leitura do próprio diário é 8,5% da partida, abaixo de 25%) e E25 (acima). O PR8 foi removido e seu conteúdo está nos PRs de descoberta.

Metas atingidas e não atingidas no nó, com estas medidas: atingidas, leitor publicado, primeiro `feed.read` e `log.read`; não atingidas, segundo `feed.read` (34 contra 15 ms), `profile.read` de 61 autores (201 contra 120 ms, na verificação em JavaScript puro) e leitura depois da concessão (270 contra 100 ms). Nenhuma meta de Chrome 4x ou de celular foi reavaliada.

### M5, linha de base (15/11/2026, branch test/perf-m5-harness sobre main@a64e74d5, contra 11cdb47f)

Pergunta: o app Android e o iOS ficaram mais lentos desde a rodada M4 (PRs #458 a #476, juntados em 11cdb47f)? Onde está o custo hoje, por tela, lista, linha e fase da partida?

Ambiente: Mac M4 Pro (12 núcleos, 48 GB), Node v24.22.1, outras sessões usando a máquina o tempo todo (carga média de 1 min entre 6 e 23, anotada por célula). Só builds de desenvolvimento, servidos pelo Metro. A Vitrine não inicia o nó e não tem sincronização; as fotos dos dados de exemplo são pequenas. Nenhum celular de verdade. Emulador Android `varanda-perf` (API 36, 4 núcleos, 2 GB, GPU em software, SwiftShader), aberto com `-no-window`: com janela, o processo do emulador caiu para cerca de 1 núcleo depois de alguns minutos e todas as execuções travaram (`app-commit` de 3557 a 9030 ms); essas execuções foram descartadas. Simulador iOS iPhone 16e. Registros brutos e scripts em saída local, não versionada.

Regra de decisão desta rodada: contadores (renderizações, ms de render, marcas), não o p95 de quadro, que com esta carga varia mais que 10% entre execuções iguais.

#### Nó, A/B 11cdb47f contra a branch

Mesmo comando nas duas árvores, intercalado A B A B, 3 execuções de cada, cada uma com `--runs 5` (mediana das três medianas, entre colchetes o mínimo e o máximo):

```sh
node packages/web-member/scripts/startup-bench.js --follows 60 --blocks 150 --own 800 --issued --js-verify --reads --reads-twice --log --steps --early-reads --runs 5 --json --file --lease-gap   # arquivos
node packages/web-member/scripts/startup-bench.js ... --idb                                                                                                              # IndexedDB
```

Carga média de 1 min no início de cada execução: entre 13,5 e 20,8.

| Métrica (ms) | arquivos 11cdb47f | arquivos branch | IndexedDB 11cdb47f | IndexedDB branch |
|---|---|---|---|---|
| Leitor publicado (`medianMs`) | 6,2 [6,1-7,9] | 6,3 [5,9-6,8] | 23,7 [22,8-26,0] | 22,8 [22,2-24,6] |
| Primeiro `feed.read` | 28,4 [28,1-30,8] | 28,7 [28,7-33,7] | 34,3 [34,1-35,3] | 35,1 [35,1-35,6] |
| Segundo `feed.read` | 38,6 [37,0-39,1] | 39,2 [37,0-42,6] | 35,5 [34,6-36,0] | 35,3 [35,3-35,6] |
| `profile.read` de 61 autores | 175,7 [174,3-199,2] | 184,3 [181,6-188,1] | 183,7 [180,7-187,5] | 184,7 [180,2-185,4] |
| Segundo `profile.read` | 43,0 [42,6-47,6] | 41,9 [39,4-47,3] | 44,1 [42,5-44,6] | 43,7 [43,2-44,0] |
| Leitura depois da concessão (`leaseGapReadMs`) | 288,3 [266,0-385,1] | 310,7 [302,2-378,1] | n/d | n/d |
| Leitura de A Rua antecipada (`earlyFeedReadMs`) | 352,4 [351,8-450,0] | 378,0 [354,1-394,4] | 611,8 [606,4-623,0] | 607,0 [594,4-628,7] |
| Partida concluída (`startupSettledMs`) | 231,5 [225,6-304,6] | 240,7 [227,3-242,1] | 592,7 [586,4-601,4] | 588,5 [572,7-620,8] |

Veredito do nó: sem regressão. Todas as diferenças ficam dentro da dispersão das próprias execuções (as maiores: `leaseGapReadMs`, +7,8%, e `earlyFeedReadMs` em arquivos, +7,3% (352,4 contra 378,0 ms); `profile.read` em arquivos, +4,9%; as faixas se cruzam). O bench da branch rodou antes do `npm ci`; `web-member` é ligado por workspace e o Hypercore 10 não mudou.

#### Android, A/B da interface (Vitrine grande só texto)

Um só APK de debug (desta branch) e o JavaScript de cada revisão por um Metro próprio (branch na porta 8097, 11cdb47f na 8098, trocado com `adb reverse tcp:8081 tcp:<porta>`). O JavaScript de 11cdb47f roda neste APK sem erro. Variáveis: `VITRINE=1 VITRINE_LARGE=1 PERF=1`, sem rolagem roteirizada (11cdb47f não tem). Por execução: `am start -W`, 12 s, toque em Espiadinha e de volta em A Rua (em 11cdb47f as marcas só saem numa troca de aba), depois 24 arrastos de `adb shell input swipe` (8 para baixo, 8 para cima, 8 para baixo) e `dumpsys gfxinfo`. A B A B, 3 de cada, carga média entre 13,2 e 16,8.

As origens das marcas diferem (11cdb47f conta da criação das marcas em `src/node.js`; a branch, de `js-entry`), então a comparação usa o horário do logcat, contado da linha `Running "main"`, que as duas imprimem.

| Medida | 11cdb47f (3 execuções) | branch (3 execuções) |
|---|---|---|
| `TotalTime` do `am start -W` (até o primeiro quadro da atividade, antes do JavaScript) | 699, 699, 645 ms | 766, 797, 666 ms |
| De `Running "main"` às primeiras linhas de A Rua (`first-rows`) | 1208, 1215, 1036 ms | 3006, 3166, 2885 ms |
| De `Running "main"` ao fim do splash (`splash-end`) | 1788, 1764, 1597 ms (`grace`) | 7072, 7180, 7132 ms (`patience`) |
| Quadros da rolagem à mão, p95 da linha `frames` | 43,9 / 42,6 / 48,5 ms | 54,6 / 42,3 / 96,0 ms |
| `gfxinfo`: quadros / atrasados | 1180/182, 1269/85, 1151/188 | 1245/101, 1314/26, 847/329 |

Veredito: houve regressão, e ela é da partida da interface, não do nó nem da rolagem. As primeiras linhas de A Rua saem cerca de 1,8 s mais tarde (o shell só monta depois da apresentação inteira do splash, 1,5 s, seção 242 de `docs/verification.md`), e o splash cobre A Rua até a paciência de 5 s: a marca `details` nunca sai na Vitrine, então o splash termina por `patience` cerca de 7,1 s depois de `Running "main"`, contra 1,7 s (`grace`, 400 ms depois da primeira página) em 11cdb47f. Num app com conta, a espera extra fica entre os detalhes e Momentos assentados e o teto de 5 s; não foi medida com nó vivo (abaixo). Parte disso é artefato da Vitrine: nos registros da branch, `moments` sai 3755 e 3656 ms depois de `js-entry` (cerca de 3,1 a 3,2 s depois de `Running "main"`) e `details` nunca sai. Até 3,9 s dos 7,1 s do splash (e dos +5,4 s) são a espera por `details`, que só a Vitrine nunca assenta; se `details` assentasse junto com `moments`, o splash terminaria em cerca de 3,2 s (+1,5 s contra 11cdb47f). A rolagem à mão não mostra diferença acima do ruído (uma execução da branch com p95 de 96 ms, as outras duas iguais às de 11cdb47f).

#### Android, custo hoje (branch)

Rolagem roteirizada de A Rua (`PERF_SCROLL=rua`), 60 s, 4 inversões. Linha `frames ... run=scroll` de cada execução; renderizações somadas na fase `scroll:rua`. Mediana [faixa].

| Célula | execuções (carga) | render `list:rua` (vezes / ms) | abas escondidas (vezes / ms) | quadros n / p95 / >32 ms | linhas / montagens / renders por montagem (mediana, p95) |
|---|---|---|---|---|---|
| texto | 3 (11,1 a 22,5) | 1230 [1178-1245] / 12686 [12104-12861] | 119 [113-119] / 336 [323-399] | 2800 / 42,2 (execuções 38,7 a 50,1) / 341 | 121 / 476 / 2, 3 |
| ricas | 3 (8,7 a 10,1) | 1182 [1099-1194] / 9533 [8735-11680] | 124 / 375 [355-415] | 2939 / 41,3 / 285 | 83 / 331 / 2, 3 |
| ricas + players (teto 4) | 3 (15,6 a 20,9) | 1167 [814-1186] / 13409 [12324-18132] | 353 [225-410] / 1359 [1334-1925] | 2176 / 66,8 (execuções 56,0 a 184,6) / 433 | 77 / 312 / 2, 3 |
| ricas + players, teto 0 | 2 (21,2 a 22,6) | 1186, 1208 / 9175, 10680 | 124 / 378, 402 | 2663, 2855 / 42,1, 46,7 | 70 a 77 / 295 a 315 / 2, 3 |
| ricas + players, teto 1 | 2 (14,0 a 14,3) | 1146, 1208 / 11969, 12715 | 304, 358 / 1202, 1379 | 2352, 2474 / 53,1, 58,2 | 70 / 292 a 303 / 2, 3 |

- A lista de A Rua renderiza cerca de 20 vezes por segundo durante a rolagem e soma, em mediana, de 9,5 a 13,4 s de render em 60 s por célula (as execuções vão de 8,7 a 18,1 s; 15% a 22% do tempo). Por montagem de linha: 26,7 ms (texto), 28,8 (ricas), 31,1 (teto 0, a menor de duas execuções; a outra deu 33,9), 41,0 (teto 1) e 43,0 ms (teto 4).
- Cada aba escondida renderiza cerca de 22 vezes numa rolagem com 4 inversões (as barras mudam a cada inversão): 119 a 124 renderizações, 0,34 a 0,38 s, sem players. Com um player vivo (teto 1 ou mais), as abas escondidas renderizam de 2,5 a 3 vezes mais (304 a 410, de 1,2 a 1,9 s). Feira e Diário são as mais caras.
- Players: teto 4 contra teto 0, +26% a +46% de ms de render em `list:rua` (13409 contra 10680 e 9175; +31% é o teto 1, 11969 contra 9175), abas escondidas 353 contra 124 renderizações, 18% a 24% menos quadros (2176 contra 2663 e 2855). Teto 0 (cartões montados, com a checagem de 500 ms de cada cartão, sem WebView) custa o mesmo que as linhas ricas sem players (9175 a 10680 contra 8735 a 11680 ms; 124 contra 124 renderizações escondidas): as checagens por cartão não aparecem. O custo vem com o player vivo: as WebViews e as renderizações do app inteiro que um player vivo provoca.
- Rolagem sem inversões: não medida (a rolagem roteirizada tem 4 inversões fixas e esta tarefa não muda código).

Parado em A Rua por 75 s (ricas + players, sem rolagem): nenhuma renderização de aba escondida depois da partida; A Rua renderizou 14 vezes (188 ms) em duas descargas, a 8,1 s e a 63,1 s depois de `js-entry`. Nenhuma linha `req:`: na Vitrine os pedidos não passam pelo `request` do nó, onde `req:` é marcado, então o `moment.lookup` a cada 15 s não aparece aqui.

Partida a frio (5 execuções, ricas + players, carga 6,4 a 12,6) e a quente (5): `TotalTime` frio 730 [672-769] ms, quente (`HOT`) 100 a 131 ms em quatro das cinco e 622 ms na quinta. Marcas desde `js-entry`: `sweep-media-cache` 1 ms; `worklet-start` não sai na Vitrine (o nó não inicia); `Running "main"` 588 [577-634]; `app-commit` 691 [669-740]; `first-rows:rua` 3465 [3354-3771]. Das primeiras linhas, cerca de 2,8 s são depois do primeiro commit, quase todo o splash.

Processo até o JavaScript (3 partidas a frio com o logcat inteiro, carga 6,9): do `Start proc` do ActivityManager a `js-entry`, 2162 e 1888 ms (a primeira execução, 7328 ms, pegou o Metro montando o pacote e fica de fora); de `js-entry` a `app-commit`, 679 a 703 ms; `TotalTime` 743 e 662 ms. Num build de desenvolvimento, o trecho até `js-entry` inclui baixar o pacote do Metro pelo `adb reverse` e avaliar o JavaScript sem bytecode; num release o pacote é Hermes no aparelho. Release não medido.

#### iOS (simulador iPhone 16e, só a branch)

Mesmas variáveis, Metro na porta 8097, rolagem roteirizada de A Rua, 3 execuções por célula, carga 6,0 a 11,7 (registros do log do Metro). O simulador usa a GPU e a CPU do Mac, então os quadros saem muito melhores que no emulador Android em software; não compare ms entre as duas plataformas.

| Célula | render `list:rua` (vezes / ms) | abas escondidas (vezes / ms) | quadros n / p95 / >32 ms | linhas / montagens |
|---|---|---|---|---|
| texto | 1233 [1232-1234] / 8121 [8077-8182] | 136 [136-137] / 345 [343-378] | 3144 / 32,5 / 176 | 118 / 464 |
| ricas | 1226 [1222-1226] / 5773 [5718-5833] | 124 [124-130] / 302 [298-323] | 3206 / 31,5 / 152 | 70 / 294 |
| ricas + players (teto 4) | 1409 [1403-1409] / 6018 [5960-6071] | 130 [124-130] / 326 [302-341] | 3211 / 31,5 / 152 | 70 / 289 |

- Partida (5 a frio, uma sem leitura: o recorte do log do Metro veio vazio; e 3 aquecidas, uma por célula): `app-commit` 587 [586-588] ms, `first-rows:rua` 2769 [2765-2783] ms; aquecida 591 a 645 / 2778 a 2839 ms. `sweep-media-cache` de 1 a 17 ms (os maiores na primeira execução de cada Metro).
- A lista de A Rua custa de 5,7 a 8,2 s de render em 60 s, o mesmo número de renderizações do Android (cerca de 1230). Ms por montagem: 17,5 (texto), 19,6 (ricas), 20,8 (players).
- Com players, as abas escondidas não renderizam mais que sem eles (130 contra 124), ao contrário do Android, e a lista renderiza 15% mais vezes (1409 contra 1226). Os quadros não mudam.
- `splash-end` apareceu no log do Metro do iOS numa execução (`splash-end 7461 patience`, com `first-rows` em 2770 e `moments` em 2990 ms), o que apoia a tese do código comum com o Android; nas outras não houve a marca. A/B contra 11cdb47f no iOS: não medido. Em 11cdb47f as marcas só saem numa troca de aba, que pede um toque no simulador, e o orçamento desta tarefa não cobria os toques. A espera do splash vem de código comum (`App.js`), sem ramo por plataforma.
- Partida aquecida a quente (app em segundo plano): não medida, porque nenhuma marca é impressa sem uma partida nova do JavaScript.

#### Web, Chrome 4x (sem cabeça, 412x915, CPU 4x mais lenta)

Dois pacotes exportados para a pasta temporária (nada dentro do repositório): o de release (`npx expo export --platform web`), que não liga a Vitrine (ela só existe com `__DEV__`) e mostra a entrada com o nó do navegador pré-carregado; e o de desenvolvimento (`npx expo export --platform web --dev`) com `VITRINE=1 VITRINE_LARGE=1 VITRINE_RICH=1 PERF=1 PERF_SCROLL=rua`. Servidos por um servidor estático local, rastro do DevTools nos primeiros 12 ou 25 s, cache HTTP quente, uma execução de aquecimento que aceita os Termos. 3 execuções de cada, carga 6,0 a 8,7.

| Medida, release (entrada, 3 execuções) | ms |
|---|---|
| Primeira pintura (`firstContentfulPaint`) | 52, 50, 356 |
| Avaliação de `varanda-node.js` (um só `EvaluateScript`, uma tarefa longa) | 330, 294, 290 |
| Avaliação do pacote do app (`EvaluateScript` do `index-*.js`; os `FunctionCall` do mesmo arquivo, 149 a 154 ms, ficam de fora) | 304, 295, 300 |
| Tarefas longas (50 ms ou mais) nos primeiros 12 s | 2 / 638, 2 / 592, 3 / 821 |

| Medida, Vitrine de desenvolvimento (3 execuções) | valor |
|---|---|
| `js-entry` desde a navegação | 193, 193, 206 ms |
| `app-commit` (desde `js-entry`) | 323, 328, 338 ms |
| `first-rows:rua` (desde `js-entry`) | 2242, 2244, 2280 ms; desde a navegação 2435 a 2486 ms |
| Tarefas longas nos primeiros 25 s | 25 / 3678, 25 / 3825, 26 / 4051 ms |
| Render `list:rua` na rolagem de 60 s | 1849 / 13991, 1831 / 14176, 1834 / 14256 ms |
| Render das abas escondidas na rolagem | Espiadinha, Avisos, Comunidades e Diário 3245 a 3281 vezes cada; soma 5350, 5828, 5604 ms |
| Quadros `run=scroll` n / p95 / >32 ms | 3329 / 35,2 / 275; 3280 / 38,3 / 307; 3307 / 36,2 / 291 |

- Na web, quatro abas escondidas renderizam uma vez por quadro o tempo todo, parado inclusive (causa não identificada nesta medição): 158 a 159 renderizações cada antes de a rolagem começar e 300 a 301 por descarga de 5 s durante 40 s depois de ela acabar, cerca de 60 por segundo, em torno de 0,45 s de render a cada 5 s em 4x. Na rolagem de 60 s isso dá cerca de 3270 renderizações por aba (contra cerca de 22 no Android e no iOS), 5,4 a 5,8 s somados, cerca de 40% do render da própria lista de A Rua; os 5,4 a 5,8 s são só a janela de 60 s. No Android parado não houve renderização escondida, então isto é só da web. É o maior custo de interface da web medido aqui.
- A primeira pintura sai em cerca de 50 ms: o que vem antes dela não pesa.
- PWA instalado e nó vivo na web: não medidos (o PWA instalado pede uma instalação com conta; o caminho com conta pede passkey). O pacote de release mede a avaliação do script do nó, não a sessão dele.

#### Nó vivo

Não medido. O build de debug nativo não entra com passkey numa instalação local, e a Vitrine não inicia o nó. Por isso o `moment.lookup` a cada 15 s (marca `req:`) e o custo da sincronização no aparelho ficam de fora desta linha de base.

#### Custos em ordem

| # | Custo | Número | Onde |
|---|---|---|---|
| 1 | Apresentação inteira do splash antes do shell | primeiras linhas +1,8 s medidos (3,0 s contra 1,2 s desde `Running "main"`); cerca de 2,8 s depois do primeiro commit | Android e iOS (2,77 s desde `js-entry`) e web (2,24 s) |
| 2 | Splash da Vitrine até a paciência (teto, Vitrine) | `splash-end` 7,1 s depois de `Running "main"` (`patience`) contra 1,7 s (`grace`) em 11cdb47f, +5,4 s; até 3,9 s disso podem ser artefato da Vitrine (cerca de 3,2 s e +1,5 s se `details` assentasse com `moments`) | Android, todas as plataformas pelo código comum |
| 3 | Render da lista de A Rua na rolagem | 12,7 a 13,4 s em 60 s no Android, 5,8 a 8,1 s no iOS, 14,0 a 14,3 s na web (cerca de 1200 a 1850 commits) | todas |
| 4 | Abas escondidas renderizando | web: 5,4 a 5,8 s numa janela de 60 s (uma vez por quadro o tempo todo, parado inclusive); Android com player vivo: 1,2 a 1,9 s (x2,8); sem players: 0,3 s | web, Android |
| 5 | JavaScript antes do primeiro commit | `js-entry` a `app-commit` 691 ms no Android, 587 no iOS, 323 na web 4x; `Start proc` a `js-entry` cerca de 2,0 s no Android de debug | todas |
| 6 | Players vivos | +26% a +46% de ms de render da lista no Android, 18% a 24% menos quadros | Android |
| 7 | Avaliação do pacote e do script do nó na web | pacote `EvaluateScript` 295 a 304 ms, `varanda-node.js` 290 a 330 ms (4x) | web |

#### Portões das tarefas condicionais

- Pausa da consulta de prévias de momentos (`moment.lookup` a cada 15 s): não avaliado, portão em aberto (a Vitrine não passa por `node.request`; conferir com nó real). Parado 75 s, nenhuma renderização de aba escondida e nenhuma linha `req:`, mas a busca a cada 15 s não pôde ser vista.
- Varredura do cache de mídia fora do primeiro desenho: não roda. `sweep-media-cache` 1 a 2 ms no Android, 1 a 17 ms no iOS, 0 ms na web, abaixo do portão de 20 ms. Limite: a varredura só apagou o que as execuções da Vitrine deixaram (fotos pequenas de dados de exemplo, quantidade não registrada); na web, 0 ms é um não-op por desenho (`apps/app/src/media/display.web.js:21`); o iOS chegou a 14 a 17 ms na primeira execução de cada Metro, perto do portão. Cache de instalação real não medido.
- Inline requires no Metro: roda, mas só fica sob a regra de manutenção (TotalTime e primeiras linhas desde o processo melhoram 10% ou mais em 5 partidas frias intercaladas; build de desenvolvimento, sem bytecode). Base: de `js-entry` a `Running "main"` 588 [577-634] ms (a avaliação dos módulos, o que os inline requires adiam), cerca de 13% de `Start proc` até as primeiras linhas (cerca de 5,5 s). Conferir num release antes de mexer.
- Timer único dos players: não roda. Teto 4 contra teto 0 é material no Android (+26% a +46% de ms de render, abas escondidas x2,8), mas o teto 0 (sem players, com as checagens ligadas) custa o mesmo que as linhas sem players. Dominam as WebViews e as renderizações que um player vivo provoca; mudar quando ou quantos players carregam é decisão do mantenedor e mudaria os Termos. No iOS a diferença não aparece.
- Telas sob demanda na web: não roda. A avaliação do pacote (`EvaluateScript`, 295 a 304 ms de 2440 ms) dá 12% das primeiras linhas no release, abaixo do portão de 15% (18% só no pacote de desenvolvimento, de 429 a 449 ms sobre 2435 a 2486 ms).
- Nota de projeto do nó do navegador em worker: não roda. A tarefa longa de `varanda-node.js` (290 a 330 ms em 4x) dá de 12% a 14% das primeiras linhas (avaliação do nó), abaixo do portão de 20%.

### M5, resultados (15/11/2026, pilha perf-m5 sobre main@414e19c7)

Pergunta: a regressão nativa desde 11cdb47f acabou? Resposta curta: a rolagem e a memória não são piores que em 11cdb47f, e o custo por renderização caiu; a partida de A Rua no Android continua cerca de 1,8 s mais tarde, e isso é a apresentação do splash, que o mantenedor decidiu (PRs #553 e #597) e que fica. Detalhes e comandos em `docs/verification/docs-perf-m5.md`. Ambiente como na linha de base: builds de desenvolvimento pelo Metro, Vitrine grande, sem nó, emulador Android `varanda-perf` (GPU em software), simulador iPhone 16e, Chrome 4x; carga de 1 min de 6 a 37 (por célula naquele arquivo). Contadores, não p95 de quadro.

#### Android, A/B contra 11cdb47f (Vitrine grande só texto, mesmo método da linha de base, ABABAB, n = 3)

| Medida | 11cdb47f, mediana [faixa] | pilha (c94b5d5d), mediana [faixa] |
|---|---|---|
| `TotalTime` do `am start -W` | 836 [828-914] ms | 902 [867-1199] ms |
| De `Running "main"` às primeiras linhas | cerca de 1374 [1306-1464] ms (estimado) | 3150 [3108-3305] ms |
| De `Running "main"` ao fim do splash | 2073 [1999-2242] ms (`grace`) | 7848 [7621-7908] ms (`patience`) |
| `gfxinfo` p95 / p99 | 73 [65-77] / 113 [85-125] ms | 73 [61-109] / 109 [85-150] ms |
| `gfxinfo` quadros atrasados | 18,2% [17,4-29,5] | 20,1% [14,9-21,2] |

Onde a pilha ainda é mais lenta: a partida. As primeiras linhas saem cerca de 1,8 s depois (a linha de base mediu 1,8 s também) e o splash termina por `patience`, porque a Vitrine nunca emite `details`. As duas causas estão na linha de base: o shell só monta depois da apresentação inteira do splash (decisão do mantenedor, mantida) e até 3,9 s do `splash-end` são artefato da Vitrine. Esta rodada não separou a parcela de cada uma nem mediu com nó vivo (não medido); nada na pilha mexeu nisso. A origem das marcas de 11cdb47f é estimada (as marcas só saem no toque da aba, e contam do módulo de marcas, cerca de 0,12 s antes de `Running "main"`). Rolagem à mão: sem diferença acima do ruído (p95 73 contra 73 ms).

#### Antes e depois, por plataforma (rolagem roteirizada de 60 s de A Rua, Vitrine rica, n = 3, mediana [faixa])

Android, o antes é o PR1 (f7d08ccc) medido na mesma sessão, ABABAB; a carga subiu a 17 a 33 no fim de todas as execuções, então os ms de render são ruidosos nos dois braços.

| Medida | antes (PR1) | depois (pilha) |
|---|---|---|
| `list:rua`, renderizações / ms | 894 [763-953] / 13275 [13221-17019] | 781 [632-969] / 10625 [7367-11371] |
| renderizações por linha montada (mediana / P95) | 2 / 3 | 1 / 3 |
| abas escondidas, renderizações / ms | 124 [119-124] / 562,8 [549-645] | 80 [68-80] / 69,9 [62,0-76,8] |
| parado 60 s, `list:rua` | 5 a 14 (PR4 e seção 252) | 7 [7-8] renderizações, 103,3 [99,8-112,1] ms; abas escondidas 0 |
| `app-commit` / primeiras linhas, desde `js-entry` | 698 [693-743] / 4120 [3573-4242] ms | 728 [726-754] / 3914 [3880-5620] ms |

iOS, o antes é a seção 252 (PR1, carga 7,6 a 11,5; agora 12,4 a 16,7).

| Medida | antes | depois |
|---|---|---|
| rica, `list:rua`, renderizações / ms | 1226 / 5773 | 948 [921-956] / 4289 [4146-4369] |
| rica, abas escondidas, renderizações / ms | 124 / 302 | 86 / 41,5 |
| rica, renderizações por linha (mediana / P95) | 2 / 3 | 1 / 3 |
| só texto, `list:rua`, renderizações / ms | 1232 a 1234 / 8077 a 8182 | 829 [823-829] / 5562 [5527-5621] |
| só texto, abas escondidas, renderizações / ms | 136 a 137 / 343 a 378 | 88 / 58,4 |
| `app-commit` / primeiras linhas, rica | 605 a 627 / 2789 a 2847 ms | 617 [610-713] / 2809 [2777-3017] ms |

Web, Chrome 4x, rica, desenvolvimento (110 s de rolagem; o antes de A Rua é o PR3, `docs/verification/perf-row-mount.md`, porque o PR4 e o PR5 não mexem nela na web): `list:rua` 1604 / 11677 contra 1592 [1583-1601] / 11511 [11386-11836]; seis abas escondidas 82 renderizações e 141 a 161 ms (a linha de base mediu quatro abas em cerca de 3270 renderizações e 5,4 a 5,8 s numa janela de 60 s); renderizações por linha 1 (P95 2); primeiras linhas 2444 [2395-2491] ms desde o início da navegação. PWA instalado: não medido.

#### Memória (soaks)

| Série | início | fim | máximo | inclinação |
|---|---|---|---|---|
| Android, PSS do app, 20 min, instrumentado (`PERF`, rica, players) | 453 MB | 1226 MB | 1237 MB | cerca de +30 MB/min, sem platô, quase tudo em Native Heap (Java parado em 13 a 15 MB) |
| Android, renderizador de WebView dos players, o mesmo soak | 121 MB | 100 MB | 129 MB | sem crescimento, sem recarga nem queda |
| Android, PSS do app, 9 min no PR1, mesmo soak | 477 MB | 816 MB | | cresce igual (+339 MB contra +342 MB no tip em 9 min): anterior à pilha |
| Android, controle, `PERF` desligado, só texto, 10 min, tip a09946b9 (n = 1) | 427 MB | 488 MB | | +2,9 MB/min nos minutos 1 a 10, -1,2 nos 5 a 10; cauda parada 493, 494, 495 MB |
| Android, controle, 11cdb47f (n = 1) | 392 MB | 482 MB | | +5,5 MB/min nos minutos 1 a 10, +5,4 nos 5 a 10 |
| iOS, RSS do app, parcial | 270 MB | 476 MB | 615 MB (minuto 1) | sem tendência de alta; platô de 440 a 461 MB nos minutos 3 a 8 |
| iOS, WebContent (6 processos), parcial | 85 MB | 739 MB | 940 MB (minuto 1) | em queda, de 865 a 873 MB (minutos 3 a 8) para 720 a 745 MB (9 a 18) |

Leitura: o tip não é pior que 11cdb47f no controle sem instrumento, então os +30 MB/min do soak instrumentado vêm da instrumentação, das linhas ricas, dos players ou de uma mistura; o controle não os separa. Limites: controle de 10 min, um braço de cada, emulador com GPU em software, build de debug, carga diferente. O soak do iOS é PARCIAL: a rolagem roteirizada rodou só nos minutos 0 a 1, e dos minutos 2 a 20 (cerca de 19 min) o app ficou parado com os players carregados; não é um soak de 20 minutos de rolagem. Sem queda, ANR nem `FATAL` em nenhum.

#### O que cada PR trouxe

- PR2 (`perf/render-isolation`, `docs/verification/perf-render-isolation.md`): linhas leem contextos estreitos do nó, 27 telas são `memo`, o pulso do `Skeleton` pausa nas abas escondidas, uma só assinatura de movimento reduzido. Efeito visto na ponta: abas escondidas de 124 para 80 renderizações (Android) e 124 para 86 (iOS), e de ~3270 (quatro abas) para 82 (seis abas) na web.
- PR3 (`perf/row-mount`, `docs/verification/perf-row-mount.md`): uma renderização por linha de publicação ao montar. Efeito: renderizações por linha montada de 2 para 1 (mediana) no Android, iOS e web.
- PR4 (`perf/list-rows`, `docs/verification/perf-list-rows.md`): linhas estáveis em Espiadinha, Diário, Busca, Conversa, Membro e Mensagem, e relógio de minuto pausado nas telas escondidas. Efeito: as listas escondidas de 21 a 23 renderizações para 4 a 6 na rolagem de A Rua do Android (medido contra o PR1).
- PR5 (`perf/native-boot`, `docs/verification/perf-native-boot.md`): barra do splash no driver nativo. Efeito esperado e medido: nenhum na partida, acima do ruído (Android `TotalTime` 653 ms, iOS `app-commit` 585 ms).
- PR1 (seção 252): o instrumento e a linha de base.

#### Tarefas condicionais que não entraram

- Pausa da consulta de prévias de momentos: o portão não pôde ser avaliado, porque a Vitrine não passa por `node.request`. Precisa de um nó vivo.
- Varredura do cache de mídia fora do primeiro desenho: `sweep-media-cache` 1 a 2 ms no Android e 1 a 17 ms no iOS, abaixo do portão de 20 ms.
- Inline requires: descartado. Com carga parecida o ganho ficou abaixo da regra de 10% (`TotalTime` empatado, primeiras linhas de 0 a 9%), e os registros de limpeza (snapshots de tela, fotos guardadas) e o preload do nó web passariam a carregar tarde (`docs/verification/perf-native-boot.md`).
- Timer único dos players: dominam as WebViews e as renderizações que um player vivo provoca (+26% a +46% de ms de render no Android); mudar quando ou quantos players carregam é decisão do mantenedor e mudaria os Termos.
- Telas sob demanda na web: avaliação do pacote 12% das primeiras linhas, abaixo do portão de 15%.
- Nó do navegador em worker (nota de projeto): 12% a 14% das primeiras linhas, abaixo do portão de 20%.

#### Próximos candidatos

- Relógios de minuto que ainda rodam em A Rua atrás de uma tela empilhada (Conversa, Membro, Mensagem): 4 a 5 renderizações por minuto, cerca de 100 ms (`docs/verification/perf-list-rows.md`; `ARua.js` não entrou no PR4).
- Linhas de Conversa sem memo: `list:conversa` parada renderiza 8 vezes em 60 s (36 ms) e 2 vezes (31 ms) com o teclado aberto (`docs/verification/perf-list-rows.md`); não se mediu se uma linha de mensagem renderiza ao digitar, então não há número do ganho.
- Inline requires com um módulo de boot explícito, medido num build de release: a avaliação dos módulos (`js-entry` a `Running "main"`) é 588 [577-634] ms no debug, cerca de 13% de `Start proc` até as primeiras linhas (cerca de 5,5 s).
- Duração da apresentação do splash: +1,8 s nas primeiras linhas e +5,8 s no `splash-end` contra 11cdb47f no Android. Decisão do mantenedor (#553 e #597).
- As WebViews dos players: +26% a +46% de ms de render da lista no Android com players vivos. Decisão do mantenedor.
- Soaks da Vitrine rica sem `PERF` e dos players sem `PERF`, para achar o que cresce (cerca de +30 MB/min com instrumento, contra +2,9 MB/min no controle de texto).

### Espiadinha e Avisos com e sem descoberta (16/11/2026, branch perf/peek-leftovers sobre main@56ea00f7)

Pergunta: quanto custam `peek.read` e `notices.list` contra um semeador com descoberta (páginas de 48 candidatos) e contra um com `discovery: false`, num conjunto maior que um lote? Verificação em `docs/verification/perf-peek-leftovers.md`.

Ambiente: Node v24.22.1 neste Mac (Apple M4 Pro, 12 núcleos, 48 GB). Não é um celular: o nó é o do navegador (`createBrowserNode`, armazenamento em memória) rodando no Node, com o semeador de `@varanda/core` no mesmo processo, DHT local em 127.0.0.1 e sem Docker. Outras sessões usavam a máquina; a carga média de 1 min no início de cada execução vai na tabela.

Comando (4 leitores, 20 s; `--inventory 200` completa o conjunto com diários pequenos até 200 servidos; cada leitor segue os 20 membros do conjunto, então os outros cerca de 180 são candidatos da Espiadinha, mais que um lote de 48), intercalado com e sem descoberta, 3 execuções de cada:

```sh
node apps/cli/scripts/content-load.js --clients 4 --duration-ms 20000 --inventory 200 --json
node apps/cli/scripts/content-load.js --clients 4 --duration-ms 20000 --inventory 200 --no-discovery --json
```

Mediana das três execuções, entre colchetes o mínimo e o máximo (p50 e p95 de cada execução sobre todas as suas aberturas):

| Métrica | Com descoberta | Sem descoberta |
|---|---|---|
| Aberturas completas em 20 s | 408, 384, 412 | 164, 160, 168 |
| `peek.read` p50 (ms) | 95 [94-101] | 383 [367-388] |
| `peek.read` p95 (ms) | 111 [111-120] | 443 [435-450] |
| `peek.read` máximo (ms) | 145 [130-171] | 469 [464-469] |
| `notices.list` p50 (ms) | 17,6 [17,4-18,4] | 11,6 [11,3-11,7] |
| `notices.list` p95 (ms) | 27,6 [27,4-31,3] | 21,8 [21,1-23,7] |
| Bytes recebidos do semeador por abertura, todas as operações (KB) | 192 [192-193] | 525 [525-525] |
| Falhas, erros internos, fechamentos 1013 | 0 | 0 |
| Carga de 1 min | 5,8, 5,9, 5,7 | 6,0, 5,2, 5,3 |

Com 100 ms de ida e volta simulados (`--rtt-ms 100 --duration-ms 30000`, n = 1): `peek.read` p50 1598 ms com descoberta e 6092 ms sem (cerca de 3,8 vezes); `notices.list` p50 359 e 361 ms. Carga entre 5,2 e 6,0; a execução sem descoberta rodou junto com a suíte de testes de `packages/web-member`.

Leitura:

- Sem descoberta, `peek.read` leva cerca de 4 vezes mais (p50 383 contra 95 ms) e cada abertura recebe cerca de 2,7 vezes mais bytes do semeador (525 contra 192 KB). O hello traz o inventário inteiro, mas ele explica pouco disso (cerca de 85 bytes por diário, 17 KB para 200); o resto, ao que tudo indica, vem de blocos de mais diários, porque a leitura trabalha sobre todos os candidatos do inventário e não sobre um lote de 48. A divisão exata não foi medida.
- `notices.list` não usa a descoberta e ficou um pouco mais rápido sem ela (11,6 contra 17,6 ms). Não investigado; uma hipótese é haver menos aberturas por segundo disputando o mesmo processo.
- Uma primeira série, com carga entre 9,4 e 27,3 e ainda com a reserva de quadro tentada para a #459, deu o mesmo quadro (`peek.read` p50 432 contra 127 ms, 524 contra 196 KB por abertura).
- Reserva de quadro por pedido encadeado (tentada para a #459 e retirada): com 100 ms de ida e volta, `peek.read` p50 1798 e 1800 ms com ela, 1596 ms com os arquivos de `main` e 1598 ms só com o limite da ligação, que ficou. Cerca de duas idas e voltas a mais por leitura honesta, sem apertar o pior caso, que o limite da ligação já fixa em 16 MiB + 16 x 1 MiB. `notices.list` não mudou (359 ms nos três).

### Linha de base da cronometragem do primeiro conteúdo e portão da onda 15 (26/11/2026, branch test/content-timing, sobre main@442eac98)

Pergunta: onde o primeiro conteúdo gasta tempo na partida de uma visita de retorno, e as três varreduras da partida (diários de grupo, índice de réplicas, varredura de bloqueados) justificam uma onda própria de trabalho? Verificação em `docs/verification/test-content-timing.md`. Os números são da bancada, no Node, num Mac; nenhum é de celular, e as metas abaixo são propostas, não resultados.

Ambiente: Node v24.22.1 neste Mac (Apple M4 Pro, 12 núcleos), nó do navegador com armazenamento em memória rodando no Node, semeador de `@varanda/core` no mesmo processo, DHT local em 127.0.0.1, `--dataset-size 20x40` (padrão). Outras sessões usavam a máquina (carga de 1 min entre 4,6 e 6,2 no início de cada execução). Regra do ciclo: 3 execuções seguidas, mediana das três, entre colchetes o mínimo e o máximo; p50 e p95 de cada execução sobre todas as suas aberturas. Execuções de `content-load.js` com 4 leitores e 20 s (reduzido do padrão de 30 s e 8 leitores, para caber na máquina compartilhada), intercaladas entre 0 e 100 ms. Com 100 ms de ida e volta uma execução faz só 24 aberturas (contra 404 a 421 sem atraso), então os p95 dessa coluna vêm de poucas amostras.

```sh
node apps/cli/scripts/content-load.js --clients 4 --duration-ms 20000 --rtt-ms 0 --json
node apps/cli/scripts/content-load.js --clients 4 --duration-ms 20000 --rtt-ms 100 --json
cd packages/web-member && node scripts/startup-bench.js --follows 60 --blocks 150 --own 800 --file --issued --js-verify --steps --early-reads --reads --runs 5 --json
```

Sem `--reads` o `startup-bench.js` aborta a sincronização assim que o leitor é publicado e as etapas depois de `grupos` não aparecem; por isso a terceira linha leva `--reads`.

Aberturas completas (`content-load.js`):

| Operação | 0 ms: p50 | 0 ms: p95 | 100 ms: p50 | 100 ms: p95 |
|---|---|---|---|---|
| `first-content` (a partir de `sync.start`) | 10,7 [10,4-10,7] | 12,1 [11,9-13,2] | 13,4 [12,5-14,1] | 1047 [1047-1055] |
| `feed.read` | 6,4 [6,3-6,4] | 11,1 [10,9-11,2] | 3,5 [3,5-3,6] | 6,6 [6,6-7,7] |
| `peek.read` | 70,6 [69,2-72,0] | 102,2 [101,7-106,5] | 2022 [2017-2048] | 2070 [2045-2081] |
| `diary.peek` | 27,8 [27,1-28,2] | 49,3 [48,1-55,6] | 344 [336-345] | 1033 [1023-1037] |
| `index.member` | 3,2 [3,0-3,2] | 19,1 [15,6-19,5] | 104 [104-105] | 108 [107-109] |
| `media` | 3,5 [3,4-3,6] | 19,3 [18,2-19,4] | 104 [103-104] | 133 [130-157] |
| Linhas em cache (`cachedRowsMs`) | 10,7 | 12,0 | 12,8 | 22,3 |
| Linhas novas (`freshRowsMs`, 4 por execução) | 175 [170-185] | 245 [202-256] | 1031 [1024-1037] | 1059 [1051-1124] |
| Conexão (`connectMs`) | 18,3 [17,7-22,0] | 31,3 [30,4-35,4] | 97,3 [76,8-102,0] | 122,7 [112,4-130,5] |
| Varreduras (`sweepsMs`) | 0,03 | 0,04 | 0,04 | 0,08 |

Recusas e falhas: com 0 ms, 134, 164 e 130 respostas 503 por execução, todas do índice (`index.counts` 94, 121 e 102; `index.member` 40, 43 e 28; `media` 0), da taxa do índice (`--index-rate 32`, `--index-burst 64`) contra 400 a 420 aberturas em 20 s; com 100 ms, nenhuma. Em todas as 6 execuções: 0 respostas 429, 0 fechamentos 1013, 0 tempos esgotados, 0 outras falhas, 0 erros internos.

Etapas da partida (`startup-bench.js`, arquivos, D1 de 60 x 150, 3 execuções de 5, mediana de cada uma): leitor publicado em 6,5 a 6,6 ms; `startupSettledMs` 72,6 a 75,7 ms; `leitura do próprio diário` 25,2 a 26,2, `seguidos (abertura)` 29,9 a 30,7; as três varreduras: `diários de grupo` 0,3, `índice de réplicas` 10,8 a 11,5 e `varredura de bloqueados` 0,2, juntas cerca de 11,5 ms; `earlyFeedReadMs` 186,0 a 196,0 ms.

Leitura:

- Nesta bancada as varreduras não pesam: `sweepsMs` é 0,04 ms contra um `first-content` p50 de 13,4 ms com 100 ms de ida e volta (cerca de 0,3 %), e no conjunto D1 em arquivos as três somam cerca de 11,5 ms dos cerca de 73 ms da partida e de cerca de 190 ms até o primeiro `feed.read` (cerca de 6 %).
- O `first-content` com 100 ms de ida e volta tem p50 de 13 ms porque 20 das 24 aberturas por execução mostram linhas já em cache; os 4 leitores novos esperam cerca de 1,03 s, o que domina o p95. O `peek.read` (cerca de 2 s) é o que a ida e volta mais encarece, cerca de 20 idas e voltas.
- Limites: a bancada cronometra as varreduras localmente (do início das varreduras até o início da conexão), sem rede dentro delas, com armazenamento em memória e conjunto pequeno; o `startup-bench.js` não simula atraso de rede. Nenhum dos dois diz quanto as varreduras custam num celular com 100 ms de ida e volta e armazenamento em arquivos; só o aparelho confirma.

#### Portão da onda 15 (proposta)

G2: a onda 15 só mexe nas três varreduras da partida se, com 100 ms de ida e volta, elas levarem pelo menos 10 % do `first-content` e pelo menos 100 ms (as duas condições). Meta proposta, ainda não adotada: depois da onda, as varreduras fora do caminho do primeiro conteúdo, `first-content` p50 sem piora acima de 10 %. Resultado nesta linha de base: o portão G2 não se cumpre (0,04 ms e cerca de 0,3 % na bancada; cerca de 11,5 ms e cerca de 6 % no `startup-bench.js`), então por esta medida não há onda 15 sobre as varreduras. Isso vale para a bancada; uma medida no aparelho pode mudar a conclusão. G1 (montagem da ligação contra `peek.read`) foi retirado do escopo e não foi avaliado.

### Nomes de uma lista em lote (26/11/2026, branch feat/index-batch)

Pergunta: quanto o `GET /index/members/<chave>,...` poupa ao abrir uma lista de 25 linhas de 25 autores diferentes? Números da bancada, em loopback, no Node, num Mac; nenhum é de celular e nenhum é alegação de capacidade. Verificação em `docs/verification/feat-index-batch.md`.

Método: `content-load.js` com `--clients 4 --duration-ms 20000 --dataset-size 25x40 --names 25`, como na linha de base acima (4 leitores e 20 s, reduzidos do padrão), 3 execuções para cada caso, intercaladas entre 0 e 100 ms de ida e volta, carga de 1 min entre 3,6 e 5,3. Antes: `--names-mode single`, 25 pedidos `/index/member/` com 2 ao mesmo tempo, como o cliente antigo agendava. Depois: `--names-mode batch`, 2 pedidos `/index/members/` (16 e 9 autores), 2 ao mesmo tempo. "Pedidos ao índice por abertura" conta todos os pedidos de índice de uma abertura (os de nome mais o `/index/counts`); "nomes" é o tempo do passo todo, do primeiro pedido à última resposta (`names` do relatório). Mediana das três execuções, p50 e p95 de cada execução sobre todas as suas aberturas. Para o tempo não medir a recusa, estas execuções subiram o limite do índice (`--index-rate 1000 --index-burst 1000`); o resultado com o limite padrão está logo abaixo.

| | 0 ms antes | 0 ms depois | 100 ms antes | 100 ms depois |
|---|---|---|---|---|
| Pedidos ao índice por abertura | 26 | 3 | 26 | 3 |
| Nomes: p50 (ms) | 39,0 | 5,4 | 1339 | 103,9 |
| Nomes: p95 (ms) | 82,1 | 28,3 | 1363 | 104,4 |
| Aberturas por execução | 297 a 325 | 328 a 346 | 16 | 20 |

Com o limite padrão do índice (`--index-rate 32`, `--index-burst 64`) e 0 ms, o cliente antigo foi recusado com 503 em 7308, 7641 e 7844 dos pedidos `/index/member/` (cerca de 92 %) e nenhuma abertura conseguiu todos os nomes (0 de 318, 331 e 339); com o lote foram 156, 157 e 151 recusas de 2 pedidos por abertura e 210, 210 e 199 aberturas com nomes de 346, 343 e 327. Com 100 ms, nenhuma recusa nos dois casos, e os tempos ficaram iguais aos da tabela (p50 1347 antes e 102,7 depois). Dados brutos nos arquivos `a10-*.json` (limite padrão) e `a10u-*.json` (limite alto) da pasta de medidas.

Leitura:

- Os pedidos de nome por abertura caem de 25 para 2 e, com a contagem, de 26 para 3.
- Com 100 ms de ida e volta o passo dos nomes cai de cerca de 1,34 s para cerca de 0,10 s: 25 pedidos com 2 ao mesmo tempo são 13 idas e voltas em fila, 2 pedidos em paralelo são 1.
- Sem atraso o ganho é menor em tempo (39 para 5 ms) e grande em carga: o cliente antigo sozinho esgota a taxa padrão do índice.
- Limites: 4 leitores contra um só semeador em loopback, nomes já indexados, sem celular, rede móvel nem armazenamento em arquivos. A fila real de `names.js` (8 autores por vez, 2 espiadinhas) não roda na bancada; ela só reproduz os pedidos HTTP do índice. Com 100 ms cada execução fez só 16 ou 20 aberturas, então os p95 dessa coluna vêm de poucas amostras. Só o aparelho confirma.

### Tarefas que não entraram

- Pela regra das metas: `log.read` em janela (as páginas já custam o mesmo), releitura de A Rua por sinais (uma leitura por abertura).
- Sem como medir neste laboratório: hash nativo das fotos, verificação em lote dos bloqueados, histórico de mensagens diretas sob demanda.
- Medido e deixado de fora: memória do estado preparado por núcleo (segundo `feed.read` de 39 para 28 ms no Mac) não compensa o acoplamento a detalhes internos do Hypercore.

### Miniaturas de publicações (branch feat/post-thumbs)

Custo das leituras com `thumbs: true`, só por leitura e só quando o app pede:

- `feed.read`, `peek.read` e `diary.peek`: sem o pedido nada muda, nem em bytes nem em blocos. Com ele, o nó anexa as listas das mais novas para as mais antigas enquanto a resposta inteira (com o envelope em `MAX_ID`) cabe em `MAX_MESSAGE`; linhas e cursores nunca são cortados. Uma lista maximal de dez descritores JPEG custa cerca de 2,4 KB.
- `diary.peek` no nó do navegador: o bloco P + 1 de cada seq pedida P vai no mesmo lote paralelo da leitura de P, só até o comprimento já conhecido e nunca um bloco que a dobra local dá como apagado. No pior caso são 29 blocos a mais por chamada, dentro do mesmo prazo. Um bloco que não chega só deixa aquela publicação sem miniatura.
- Espiadinha: a janela da cauda já contém o bloco seguinte de cada publicação, então não há pedido novo; o bloco `post-thumbs` fica retido entre páginas (algumas centenas de bytes por publicação com miniatura, dentro do limite de memória do instantâneo).
- Escrita: uma publicação com miniaturas é um só append de dois blocos; apagar a publicação acrescenta de 1 a 3 lápides da lista de miniaturas no mesmo append (no máximo 6 lápides com dez fotos e dez miniaturas, abaixo do limite de 8).
- Não medido: tempo de relógio com semeador real e muitos diários.

### Miniaturas ao publicar (branch feat/thumbs-publish)

`Publicar` usa `buildPostThumbs` depois do envio das fotos, a partir dos bytes codificados que o compositor ainda guarda. Publicações pessoais e de Página enviam a lista `thumbs` junto com o post, somente quando o helper retorna uma lista não nula. Cada posição corresponde à foto original. Falha de codificação, tamanho fora dos limites ou envio recusado deixa `null` naquela posição, sem impedir o post e sem repetir o pedido. Um envio de miniatura com resultado desconhecido segue a regra dos originais: para o envio, guarda o pedido assinado e o próximo toque o reenvia, sem assinar outro.

Texto, GIFs, vídeos e fotos que já cabem nos limites da miniatura continuam sem essa chave. A preparação ocorre enquanto o envio está bloqueado, sem mudar a fila de saída nem o plano de anexos. Não foram medidos tempo de publicação, tráfego ou desempenho em aparelhos nesta tarefa. Verificação em `docs/verification/feat-thumbs-publish.md`.
