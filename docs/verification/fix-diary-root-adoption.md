# Escritor novo e buraco no diário na adoção de raízes (branch fix/diary-root-adoption)

Parte da #350 (itens deixados pelo PR #319).

## O que mudou

`packages/web-member/lib/sync.js`, na adoção das raízes que o próprio diário liga (`adoptDiaryGroups`):

- Escritor novo numa raiz que já é réplica: a varredura guarda os escritores com `group-join` `on: true` vistos (mesma regra de último join por escritor de `groupJoins`). Um escritor novo de uma raiz já adotada, ainda sem núcleo aceito, pagina a raiz na hora (o grupo vai à frente da passada, `l.pageFirst`) e de novo após 2, 5 e 10 s (`NEW_WRITER_PAGE_DELAYS`) enquanto a página não o lista. Depois disso vale a passada normal (`groupPageMs`). Respeita `l.paging`/`l.pageAgain`, `ending`, chaves bloqueadas e o espaçamento `GROUP_REQUEST_MS`. Numa execução `once` o grupo só volta a ser objetivo não cumprido (`pagedOn = null`) e é paginado, sem temporizadores.
- Entrada do diário pulada: um bloco que ainda não baixou (e não foi apagado) ou cuja leitura lançou erro vai para um conjunto limitado (`DIARY_HOLES_MAX`, 256), é relido em toda varredura seguinte, quando baixa (evento `download` do diário) e, depois de uma leitura que falhou, num temporizador (`DIARY_READ_RETRY_MS`, 5 s, no máximo `DIARY_READ_RETRIES`, 6 vezes por bloco, só em execução contínua). Um bloco que passa a apagado sai do conjunto. Os joins seguintes são adotados sem esperar.

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

Os dois últimos usam uma injeção de teste: `Hypercore.prototype.has/get` respondem "ausente" ou lançam erro só para o seq do join e só quando a pilha passa por `adoptDiaryGroups`/`readDiaryJoin`. Uma rede real não reproduz isso de forma determinística (o comprimento presente do diário para num buraco comum).

## Regressão

Com só `lib/sync.js` revertido (`git stash push`), `node test/sync-diary-roots.test.js`: 3 de 6 passam; falham os três novos (`tempo esgotado: W2 accepted by B`, `tempo esgotado: C adopted after the retry`, `tempo esgotado: C adopted by a later scan`). Com a correção: 6 de 6, 67 de 67 asserções.

## Não verificado / limites conhecidos

- O caminho do evento `download` (bloco que chega depois de pulado) não tem teste próprio: o teste de buraco usa uma varredura disparada por um bloco posterior.
- Se o conjunto de buracos passar de 256 blocos, os excedentes voltam ao comportamento antigo (pulados).
- Se o semeador demorar mais de cerca de 17 s para listar o escritor novo, vale a passada normal (cerca de 30 s).
- Não rodei a suíte inteira, só este arquivo e o lint.
