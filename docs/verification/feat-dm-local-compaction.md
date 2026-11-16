# Conversas apagadas saem da memória do aparelho (branch feat/dm-local-compaction)

Este arquivo confere a faxina local das conversas apagadas (issue #351, item 3). Até aqui, "Apagar conversa" gravava só uma operação `deleted` e a dobra (`packages/core/lib/dm-fold.js`) escondia as mensagens; os blocos cifrados e as fotos guardadas ficavam para sempre no aparelho. Agora o nó do navegador (`packages/web-member`, o mesmo do worklet do app instalado) faz duas coisas, sem rede e sem repetir nenhum pedido:

- **Fotos guardadas**: as fotos do cache de mídia das mensagens que uma operação `deleted` esconde são apagadas na hora, de qualquer idade (`dropDeletedMedia`).
- **Blocos**: as linhas `msg` e `rx` escondidas por um `deleted` são liberadas do núcleo local (`core.clear`) quando `now - filedAt > DM_RETENTION_MS + 86400000` (`compact`). As linhas `ctl` nunca são liberadas, porque a dobra as usa como corte.

## Decisão do mantenedor

Liberar os blocos de mensagens apagadas, mas só quando elas já não podem voltar do semeador. O semeador guarda um envelope por `DM_RETENTION_MS` (7 dias hoje; outro PR sobe para 14), e o prazo é esse mais um dia de folga de relógio (15 dias com retenção de 14). Esperar é o ponto: o cursor do `dm.pull` nunca relê um envelope, mas a cópia própria de uma mensagem enviada é arquivada na hora do envio e o envelope dela só é puxado depois, e `hasMessage(from, id)` é o que a reconhece. Com a linha já liberada, essa cópia tardia seria arquivada de novo com um `filedAt` novo, depois do `deleted`, e a mensagem apagada reapareceria. As fotos guardadas não esperam: nunca mais são mostradas, e uma linha arquivada de novo só as buscaria outra vez enquanto o semeador as tiver.

Quando roda (`packages/web-member/lib/dm.js`, `housekeep`): depois que as linhas carregam no desbloqueio; logo depois de um `deleted` arquivado (por `dm.set`, vindo de outro aparelho da mesma passkey no `dm.pull`, ou o `ctl` de uma Página); e no máximo uma vez por hora a partir de um `dm.pull`. As lojas das Páginas têm o mesmo tratamento: rodam quando a loja abre (depois de carregar as linhas) e entram na passagem horária e na de um `deleted` puxado. Uma falha vira o aviso "limpeza local das conversas apagadas não concluída" e nunca quebra o `dm.pull` nem o `dm.set`.

Texto novo para a pessoa: a confirmação "Apagar esta conversa?" (`apps/app/src/screens/Mensagem.js`), a folha de ajuda de Conversas (`apps/app/src/help.js`) e uma frase na Política de Privacidade (`apps/app/src/legal.js`, texto das fotos das mensagens diretas), dizendo que as fotos saem da memória dos aparelhos na hora e o texto na primeira vez que o app abre depois de 15 dias (a faxina só roda com o app aberto), e que a outra pessoa continua com a cópia dela. O botão do menu passou de "Apagar conversa neste aparelho" para "Apagar conversa" (`LABELS.delete` em `apps/app/src/dm.js`). A versão dos Termos e o resumo fixado em `apps/app/test/legal.test.js` são subidos no pouso, não aqui.

Limite conhecido, também em `docs/protocol.md` (seção 11, "Riscos residuais (DM)"): `core.clear` zera os bytes nos armazenamentos deste nó, mas o IndexedDB do navegador ou a memória flash do aparelho podem guardar cópias antigas até compactarem por conta própria. A promessa é "em até 15 dias", não "provado apagado do meio físico".

## Conferido por testes

Cada arquivo sozinho, a partir de `packages/web-member`. Os testes novos do núcleo usam `COMPACT_AFTER_MS` (exportado por `lib/dm-store.js`) em vez de contar dias, e os do motor usam o relógio do limite `limits.now`.

| Teste | O que prova | Sem a correção |
|---|---|---|
| `dm-store.test.js`: "compact frees the blocks of a deleted conversation older than the bound, and a reload reads the same fold" | os blocos passam a ler `null` com `wait: false`, a recarga sobe sem as linhas, as `ctl` ficam, a dobra dá o mesmo resultado | falha (`compact` sem efeito) |
| "compact keeps hidden rows inside the bound until they age, then frees them" | linha escondida mais nova que o prazo fica, e é liberada quando passa; linha visível e outro par nunca | falha (`compact` sem efeito; sem prazo, libera cedo demais) |
| "compact frees reactions of the deleted conversation and nothing of a conversation without a delete op" | `rx` do par apagado sai; um par só bloqueado, não | falha (`compact` sem efeito) |
| "compact is a no-op while locked, and a lock during it leaves the store consistent" | trancado, nada; um bloqueio no meio deixa as linhas intactas | passa sem a correção (garante a ausência de dano, não o efeito) |
| "the cached photos of a deleted conversation go at once, whatever their age; others stay" | fotos de mensagens escondidas saem na hora (dentro e fora do prazo), as de depois do `deleted` e as de outro par ficam, o índice fica coerente, idempotente, e vale depois de reabrir | falha (`dropDeletedMedia` sem efeito) |
| "compact drops the cached photos of the rows it frees, and the entry items are zeroed in kv" | a liberação leva junto o cache da linha e zera os itens no kv | falha (`compact` sem efeito) |
| "a self copy of a recent own message pulled after the delete is still recognized, so it is not filed again" | dentro do prazo a linha segue conhecida por `hasMessage` (a cópia tardia não é arquivada de novo); só depois do prazo é liberada | falha com `COMPACT_AFTER_MS = 0` |
| `dm.test.js`: "dm.set deleted compacts the own store, but only past the pool retention; a reload and an hourly pull free aged rows" | passagem ao carregar, ao apagar e uma por hora num `dm.pull`; dentro do prazo os blocos ficam; depois, só o bloco da mensagem é liberado e a `ctl` fica | falha (`housekeep` sem efeito) |
| "a reload frees the rows of a deleted conversation that aged while the device was locked" | desbloquear depois do prazo libera ao carregar | falha (`housekeep` sem efeito) |
| "without a delete op nothing is freed, however old the rows" | sem `deleted`, nada é liberado, por mais velho que seja | falha na contagem de passagens (`housekeep` sem efeito) |
| "a delete op pulled from another own device compacts too" | o `deleted` de outro aparelho da passkey também dispara a passagem, e a cópia própria arquivada no mesmo `dm.pull` é liberada | falha (`housekeep` sem efeito) |
| "a failing compaction is a warning: dm.set and the pull still succeed" | falha da faxina é só aviso | falha (`housekeep` sem efeito) |

Sem a correção, medido assim: `compact` devolvendo 0 cedo, `dm-store.test.js` passa de 37/37 para 32/37 (falham 5 testes); `dropDeletedMedia` devolvendo 0, para 36/37; `COMPACT_AFTER_MS = 0`, para 34/37; `housekeep` devolvendo cedo, `dm.test.js` passa de 70/70 para 65/70 (falham os 5 testes novos do motor). Depois de cada ensaio o arquivo voltou ao estado final e os testes foram rodados de novo.

### Revisão da PR (correções)

Testes novos ou mudados na rodada de revisão, cada um conferido desfazendo a correção, rodando o arquivo e restaurando:

| Arquivo | Teste | Correção desfeita | Sem a correção |
|---|---|---|---|
| `dm-store.test.js` | "the wait covers a 14-day seeder retention plus a day..." | `COMPACT_AFTER_MS = DM_RETENTION_MS + 86400000` | falha |
| `dm-store.test.js` | "a pass issues at most COMPACT_RANGES_MAX clear ranges..." | sem o teto de 256 faixas | falha |
| `dm-store.test.js` | "a legacy row with an old filedAt but a recent at..." | sem a checagem do `at` da linha legada | falha |
| `dm-store.test.js` | "a delete op with a filedAt outside the fold range is no cutoff" | sem `Math.abs(filedAt) <= 8.64e15` | falha |
| `dm-store.test.js` | "hiddenByDelete is true only for..." e "one pass clears several ranges (hidden, visible, hidden)..." | sem efeito a desfazer: cobrem o auxiliar novo e o caso de várias faixas e o resumo, que já funcionavam; o auxiliar é exercitado também pelo teste do motor abaixo | passam (não é regressão de uma correção) |
| `dm-store.test.js` | teste "photos of a deleted conversation..." (itens `dmMedia/<n>/0` leem null) e renomeado "a lock before the queued task runs..." | só asserções e nome | n/a |
| `dm.test.js` | "a photo still downloading when its conversation is deleted is not cached afterwards" | sem `hiddenByDelete` em `runOpen` | falha |
| `dm.test.js` | "a delete op pulled from another own device compacts too" (agora: relógio do irmão adiantado antes do desbloqueio, `counts.compact === 1` e depois `=== 2` exatos) | sem o gatilho do caminho do pull | falha |
| `page-dm.test.js` | "a deleted Página conversation is compacted when the page store opens and by the hourly pass" | passagem horária só do armazenamento próprio; sem a faxina na abertura da loja da Página | falha nos dois casos (tempo esgotado esperando os blocos) |

Resultados desta rodada: `dm-store.test.js` 43/43 (306 asserções), `dm.test.js` 71/71 (739), `page-dm.test.js` 20/20 (219). O resumo (`summaryFor`) fica igual depois da compactação (teste novo). O teste fixado de `apps/app/test/legal.test.js` falha como esperado, porque a frase da Privacidade mudou e a versão dos Termos não sobe aqui; o resumo novo é `f1cd96eeab6fc46cab7d8060668af84b81008d9e511e1126914e209b6dcbb1e8`.

Itens da revisão não feitos, como limites conhecidos: (7) a ordem da deduplicação ao arquivar, inofensiva; e os casos de queda do armazenamento no meio de um `core.clear`, além do que está dito em `docs/protocol.md` (o que o núcleo confirmou é esquecido e o resto é tentado de novo na passagem seguinte). A faxina só roda com o app aberto, e a Política de Privacidade diz isso.

Resultados da primeira rodada: `dm-store.test.js` 37/37 (278 asserções), `dm.test.js` 70/70 (736 asserções). Os demais arquivos conferidos para não regredir, cada um sozinho: `dm-summary.test.js`, `dm-memo.test.js`, `page-dm.test.js`, `dm-e2e.test.js`, `session-dm-unlock.test.js`, `resume.test.js`, `apps/app/test/help.test.js`, `apps/app/test/chatActions.test.js`, `apps/app/test/dm.test.js` e `apps/site/test/legal.test.js` (a página do site foi gerada de novo com `node apps/site/scripts/render-legal.js`).

As lojas das Páginas usam a mesma faxina e agora têm teste próprio (`page-dm.test.js`).

## Para conferir à mão num aparelho

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Registrar aparelho, sistema e, na web, o navegador, e o resultado de cada item.

- [ ] Apagar uma conversa com fotos abertas: a foto some do cache na hora (reabrir uma conversa nova com a mesma pessoa não a mostra), e a conversa some da lista. Android, iOS, web, PWA: pendente.
- [ ] A confirmação "Apagar esta conversa?" mostra o texto novo (sai dos seus aparelhos, texto e fotos saem da memória em até 15 dias, a outra pessoa continua com a cópia dela). Pendente.
- [ ] Segundo aparelho da mesma passkey: depois de um `dm.pull`, a conversa some e a faxina roda sem erro no registro. Pendente.
- [ ] Depois do prazo (adiantar o relógio do aparelho de teste), reabrir o app e conferir que a lista de Conversas segue igual e que nenhuma mensagem apagada volta. Pendente.
- [ ] Termos e Privacidade: a frase nova aparece na Política de Privacidade, no app e na página do site. Pendente (depende da versão subida no pouso).

Na raiz, na ordem da CI, `npm run lint`, `npm test` (ou `npm test -- --affected=origin/main`) e `npm run demo` têm de passar. A demo termina com `DEMO OK`.
