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

### Marcas de tempo

Só em desenvolvimento e só no aparelho: as marcas viram linhas `perf: <nome> <ms>` no console e nunca são enviadas nem guardadas. Nomes: `config`, `sync.status`, `identity.status`, `ready`, `req:<método>`, `first-rows`, `details`, `moments`, `splash-end` (com `feedReady`, detalhes e Momentos assentados, ou `patience`, o teto de 5 s; `grace` deixou de ser emitido), `rows-snapshot` e `rows-live` (com sufixo `:diario`, `:membro`, `:conversas` ou `:comunidades` nas telas), `preview-shown`, `media-hash`, `frames` e `tab:<id>`.

### Lista nativa sem conta

Para a Vitrine grande, sem conta, com 200 linhas extras no feed:

```sh
EXPO_PUBLIC_VARANDA_VITRINE=1 EXPO_PUBLIC_VARANDA_VITRINE_LARGE=1 EXPO_PUBLIC_VARANDA_PERF=1
```

Essas variáveis valem para o Metro. Depois:

- Emulador Android: `adb shell am start -n app.varanda.debug/app.varanda.MainActivity`
- Simulador iOS: `xcrun simctl launch booted app.varanda`

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
| Chrome 4x, laboratório: até as linhas de A Rua | <= 2,5 s (o mínimo de 1,5 s do splash vale só para carregando, conectando ou introdução e Termos a seguir; a rodada M0 media com ele) | 5,8 s (build de produção), 6,5 s (desenvolvimento) |
| Chrome 4x, laboratório: troca de aba | <= 400 ms | a medir |
| Chrome 4x, laboratório: perfil | <= 500 ms | a medir |
| Chrome 4x, laboratório: rajada de 2 minutos | nenhum "pedidos demais em andamento" e nenhum "pedido lento" | a medir |
| Vitrine grande nativa: primeiro commit da lista | <= 300 ms | M0 iOS: linhas 2,05 s depois de o JavaScript carregar (desenvolvimento). M4: iOS 681 a 690 ms, Android 1070 ms (desenvolvimento), meta não atingida |
| Vitrine grande nativa: p95 de quadro, rolagem de 60 s | <= 32 ms | M4: iOS 17,1 a 17,3 ms (atingida); Android 31,75 e 38,21 ms (atingida numa execução, não na outra; carga alta) |

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

Caso `--dm-rows 5000` (arquivos): `dmUnlockMs` 175,5 e `dmListMs` 11,1 (mediana das três medianas). Antes (E2, `e2-before-E10.json`, outro conjunto de execuções, 3 execuções): o desbloqueio não era medido nesse arquivo; as notas do E2 registram 184 ms com 5000 linhas. O desbloqueio continua terminando depois da carga completa; o resumo selado só tira a espera da primeira página (não medida em separado).

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

- `peek.read` e `notices.list` contra um semeador com descoberta (páginas de candidatos) e contra um com `discovery: false`, no mesmo conjunto: o medidor de carga não tem opção para desligar a descoberta e o conjunto do E8 tem menos de 48 diários, então o lote não corta nada. Fica por medir com um conjunto maior que 48 diários e as duas configurações do semeador.

- Chrome com CPU 4x, segunda abertura no laboratório: não rodado nesta tarefa.
- `rows-snapshot`, `preview-shown` e a tarefa de segundo plano de um membro com conta: o build de debug do emulador e do simulador não entra com passkey em produção ("Limites"). Ficam para o aparelho depois do deploy.
- Medidas em celular de verdade: só depois do deploy.
- O caso de grupos no commit da ponta, acima.
- Tarefas que não rodaram por regra: E11 (a leitura do próprio diário é 8,5% da partida, abaixo de 25%) e E25 (acima). O PR8 foi removido e seu conteúdo está nos PRs de descoberta.

Metas atingidas e não atingidas no nó, com estas medidas: atingidas, leitor publicado, primeiro `feed.read` e `log.read`; não atingidas, segundo `feed.read` (34 contra 15 ms), `profile.read` de 61 autores (201 contra 120 ms, na verificação em JavaScript puro) e leitura depois da concessão (270 contra 100 ms). Nenhuma meta de Chrome 4x ou de celular foi reavaliada.

### Tarefas que não entraram

- Pela regra das metas: `log.read` em janela (as páginas já custam o mesmo), releitura de A Rua por sinais (uma leitura por abertura).
- Sem como medir neste laboratório: hash nativo das fotos, verificação em lote dos bloqueados, histórico de mensagens diretas sob demanda.
- Medido e deixado de fora: memória do estado preparado por núcleo (segundo `feed.read` de 39 para 28 ms no Mac) não compensa o acoplamento a detalhes internos do Hypercore.
