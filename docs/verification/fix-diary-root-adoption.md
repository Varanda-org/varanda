# Escritor novo e buraco no diário na adoção de raízes (branch fix/diary-root-adoption)

Parte da #350 (itens deixados pelo PR #319).

## O que mudou

`packages/web-member/lib/sync.js`, na adoção das raízes que o próprio diário liga (`adoptDiaryGroups`):

- Escritor novo numa raiz que já é réplica: a varredura guarda os escritores com `group-join` `on: true` vistos (mesma regra de último join por escritor de `groupJoins`). Um escritor novo de uma raiz já adotada, ainda sem núcleo aceito, pagina a raiz na hora (o grupo vai à frente da passada, `l.pageFirst`) e de novo após 2, 5 e 10 s (`NEW_WRITER_PAGE_DELAYS`) enquanto a página não o lista. Depois disso vale a passada normal (`groupPageMs`). Respeita `l.paging`/`l.pageAgain`, `ending`, chaves bloqueadas e o espaçamento `GROUP_REQUEST_MS`. Numa execução `once` o grupo só volta a ser objetivo não cumprido (`pagedOn = null`) e é paginado, sem temporizadores.
- Entrada do diário pulada: um bloco que ainda não baixou (e não foi apagado) ou cuja leitura lançou erro vai para um conjunto limitado (`DIARY_HOLES_MAX`, 256), é relido em toda varredura seguinte, quando baixa (evento `download` do diário) e, depois de uma leitura que falhou, num temporizador (`DIARY_READ_RETRY_MS`, 5 s, no máximo `DIARY_READ_RETRIES`, 6 vezes por bloco, só em execução contínua). Um bloco que passa a apagado sai do conjunto. Os joins seguintes são adotados sem esperar.

## Ajustes da revisão

- A busca do escritor novo pagina só o grupo dele: com uma passada em andamento só entra em `l.pageFirst` (sem nova passada), parado roda uma passada só dele (`pageGroupNow`) e não mexe no temporizador.
- A primeira varredura do run só preenche `diaryWriters`: nenhum escritor que o run já conhecia é buscado.
- A busca respeita o teto de 8 escritores por diário (`liveDiaryWriters`) e pára quando o escritor deixa de estar ligado (`diaryLive`, atualizado a cada varredura), é listado ou fica guardado.
- O evento `download` de um buraco espera `checkOwnSync` enquanto o diário está atrás do semeador; a falha de leitura é registrada uma vez por varredura.

## Como verificar

```sh
cd packages/web-member
node test/sync-diary-roots.test.js
npm run lint
```

Testes novos em `packages/web-member/test/sync-diary-roots.test.js`:

- `a writer the diary newly binds to a root already held as a replica is fetched at once`: o aparelho B já guarda a raiz como réplica, com `groupPageMs` de 600 s; A sai da comunidade e entra de novo (escritor novo W2) e B aceita W2 em segundos.
- `a diary block the join scan could not read is read again and its root adopted in the same run`: a leitura do bloco do join falha uma vez (injeção, ver abaixo) e a raiz é adotada pelo temporizador de nova tentativa, sem o comprimento do diário mudar.
- `a diary block missing at a scan does not hide its group-join from the next scan`: o bloco "não está" na primeira varredura; um bloco posterior dispara outra varredura e a raiz é adotada.

- `a diary block that downloads after the scan skipped it is read at once, the length unchanged`: o evento `download` do próprio diário (emitido na sessão vista em `has`) basta para adotar a raiz.
- `a new writer pages only its own group, and a run start chases no writer it already knew`: conta os pedidos de página no semeador. Um escritor ligado que o semeador nunca lista faz 2 a 3 pedidos a mais só da raiz dele, nenhum de outra, e um novo run que já o tem no diário não faz pedido extra. O primeiro teste também confere que nenhuma página da raiz vem depois de o escritor ser aceito.

Os três de buraco usam uma injeção de teste: `Hypercore.prototype.has/get` respondem "ausente" ou lançam erro só para o seq do join e só quando a pilha passa por `adoptDiaryGroups`/`readDiaryJoin`. Uma rede real não reproduz isso de forma determinística (o comprimento presente do diário para num buraco comum).

## Regressão

Com só `lib/sync.js` revertido para antes de tudo isto, 3 de 6 passavam (falhavam W2, nova leitura e varredura posterior). Com a correção: `node test/sync-diary-roots.test.js` 8 de 8, 79 de 79 asserções; `node test/sync-groups.test.js` 16 de 16, 112 de 112.

Os ajustes da revisão contra o `sync.js` do primeiro commit: 6 de 8; falham `no page of CE once W2 is held`, `Geral was not asked by the chase` e `no chase for a writer the run started with`.

## Não verificado / limites conhecidos

- O teste do evento `download` também passa contra o primeiro commit (o ouvinte já existia); ele cobre o caminho, não uma mudança dele.
- Se o conjunto de buracos passar de 256 blocos, os excedentes voltam ao comportamento antigo (pulados).
- Se o semeador demorar mais de cerca de 17 s para listar o escritor novo, vale a passada normal (cerca de 30 s).
- Não rodei a suíte inteira, só este arquivo e o lint.
