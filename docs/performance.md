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

Só em desenvolvimento e só no aparelho: as marcas viram linhas `perf: <nome> <ms>` no console e nunca são enviadas nem guardadas. Nomes: `config`, `sync.status`, `identity.status`, `ready`, `req:<método>`, `first-rows`, `details`, `splash-end` (com `feedReady` ou `patience`) e `tab:<id>`.

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
| Leitor publicado (`medianMs`) | <= 450 ms | 567 ms em IndexedDB, cerca de 260 ms em arquivos |
| Primeiro `feed.read` | <= 70 ms | 131 ms em IndexedDB, 235 a 341 ms em arquivos |
| Segundo `feed.read` | <= 15 ms | 124 ms em IndexedDB, 202 a 232 ms em arquivos |
| `profile.read` de 61 autores | <= 120 ms | 193 ms em IndexedDB, 284 a 333 ms em arquivos |
| `log.read`, página 8 | <= 1,5x a página 1 | 4 ms em IndexedDB e 18 a 26 ms em arquivos, as duas páginas iguais |
| Leitura depois do fim da concessão (`leaseGapReadMs`, arquivos) | <= 100 ms | 390 a 476 ms |
| Chrome 4x, laboratório: até as linhas de A Rua | <= 2,5 s (inclui o mínimo de 1,5 s do splash) | 5,8 s (build de produção), 6,5 s (desenvolvimento) |
| Chrome 4x, laboratório: troca de aba | <= 400 ms | a medir |
| Chrome 4x, laboratório: perfil | <= 500 ms | a medir |
| Chrome 4x, laboratório: rajada de 2 minutos | nenhum "pedidos demais em andamento" e nenhum "pedido lento" | a medir |
| Vitrine grande nativa: primeiro commit da lista | <= 300 ms | iOS: linhas 2,05 s depois de o JavaScript carregar (desenvolvimento); Android: não medido |
| Vitrine grande nativa: p95 de quadro, rolagem de 60 s | <= 32 ms | a medir |

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
