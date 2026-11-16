# Testes intermitentes sob carga (#357)

Branch `test/flaky-under-load`. Cada arquivo da lista da #357 está corrigido, com a causa, ou descartado, com o motivo. Um teste mostrou uma corrida real em `packages/core/lib/sync.js`, corrigida aqui com teste de regressão.

## Como foi medido

Máquina: macOS, 12 núcleos, Node 24.22.1. "20 sob carga" quer dizer 4 rodadas de 5 cópias simultâneas do mesmo arquivo, um arquivo depois do outro, cada cópia com o seu diretório temporário e a sua DHT local:

```sh
for r in 1 2 3 4; do
  for i in 1 2 3 4 5; do node packages/core/test/group-seen.test.js > "$TMPDIR/r$r-$i.log" 2>&1 & done
  wait
done
```

Cinco cópias de um arquivo de rede pesado deixam a máquina mais ocupada que o `npm test` local (até 4 arquivos ao mesmo tempo). As contagens vêm das linhas `# tests` e `# pass` da saída TAP, comparadas com o mesmo arquivo na `main` rodando sozinho.

## Corrida real no código

`sync-groups.test.js`, teste "two members and a seeder: each sees the other's posts after sync --once, a blocked diary's writer is purged": 3 de 20 cópias pulavam um escritor com `group-skipped` `timeout`, mesmo com `gateTimeoutMs` de 35 s (a verificação esperava o prazo inteiro).

- Causa: o Hypercore aceita um só canal por núcleo em cada conexão. A primeira verificação de grupo abria o diário de vínculo de B na loja principal; até ele entrar em `groupDiaries`, `mainReplica(B)` era nulo, e uma segunda verificação, que já tinha escolhido ler B pela quarentena, replicava o núcleo da quarentena sem canal: zero pares e `REQUEST_TIMEOUT` no fim do prazo.
- Correção: `openMain(key)` põe a abertura do diário na loja principal na mesma fila por chave das leituras em quarentena (espera as que estão em andamento, e também uma liberação ou limpeza da chave em andamento) e guarda a sessão em `mainOpened` até ela fechar; `mainReplica` também devolve essa sessão. As duas aberturas de diário de vínculo e a abertura de um diário seguido usam `openMain`. Uma leitura cuja réplica fecha no meio passa para a próxima réplica aberta, ou para a quarentena, enquanto houver prazo. Com a sincronização terminando, uma verificação de grupo não abre mais nada: o núcleo que ela criou é fechado e limpo, como no fim já existente de `onGroupGate`; o caminho do seguido continua abrindo e limpando, como antes. Depois da abertura, o caminho do diário guardado repete as conferências de bloqueio, bifurcação e divergência, e um diário bloqueado recriado pela abertura é limpo. `docs/protocol.md`, "Binding diary comparison (core node)", ganhou uma frase.
- Regressão: `packages/core/test/sync-groups-6.test.js` (novo, 1 teste, 5 asserções) usa o gancho de teste `quarantineHook` para abrir o diário na loja principal enquanto uma leitura em quarentena está parada. Sem a correção (as chamadas a `openMain` dos dois caminhos de grupo trocadas por `openReplica`) falha com `not ok 3 - nothing skipped` (`group-skipped`, `timeout`), 3 de 5 asserções, depois dos 30 s da verificação; com ela passa em cerca de 4 s. O teste cobre a fila; a leitura pela sessão de `mainOpened` numa janela em que nada a segura ainda não tem teste próprio.
- Testes do mesmo código rodados uma vez com a versão final: `sync`, `sync-groups` (e `-2` a `-6`), `sync-delete`, `sync-communities`, `sync-page-migrate`, `session`, `session-sync`, `session-groups`, `delete-session` e `seeder` de `packages/core`, todos passando.

## Arquivos da lista

| Arquivo | Causa | O que mudou | Testes/asserções (main → branch) | 20 sob carga |
|---|---|---|---|---|
| `core/test/sync-groups.test.js` | Teste 34: a página que despeja o último escritor podia chegar antes do download dele (#275). Teste 30: a listagem honesta sob outro grupo podia chegar antes de a errada ser refutada. Teste 31: o escritor honesto crescia depois de 3,5 s fixos. Teste 1: a corrida acima. O arquivo levava 237 a 271 s com 5 cópias, acima do limite de 180 s por arquivo do `npm test` | Testes 30, 31 e 34 esperam por evento (a página, a listagem e o crescimento são liberados pelo estado da sincronização, sem pausa); arquivo dividido em `sync-groups.test.js` (testes 1 a 16), `sync-groups-4.test.js` (17 a 30) e `sync-groups-5.test.js` (31 a 38) | 38/143 → 16/75 + 14/49 + 8/19 = 38/143 | 20/20 em cada parte, e no `-6` |
| `core/test/private-member.test.js` | Arquivo de até 280 s com 4 cópias, acima de 180 s | Dividido em `private-member.test.js` e `-2` a `-4`, com o código comum em `helpers/private-member.js` | 20/227 → 20/227 | 20/20 em cada parte |
| `core/test/group-private.test.js` | Não se reproduz: os estouros do #290 vinham da carga dos arquivos acima | Nada; descartado | sem mudança | 20/20 |
| `core/test/sync-communities.test.js` | Idem | Nada; descartado | sem mudança | 20/20 |
| `core/test/seeder-delete.test.js` | Corrigido no #649 (`mediaRead`) | Nada | sem mudança | 20/20 |
| `core/test/community-member.test.js` | O helper `sync` abria e fechava as duas lojas a cada par e fazia a troca entre todos os pares duas vezes: mais de 1 s por par, e um teste com várias sincronizações estourava 30 s até sozinho (#416) | `sync` abre cada loja uma vez e junta tudo pela primeira pessoa; `t.timeout(90000)` nos testes 5, 6, 7, 11 e 25, que levam de 13 a 30 s com a máquina ocupada | 25/262 → 25/262 | 20/20 (o mais lento: 143 s) |
| `core/test/community-member-leave.test.js` | Arquivo acima de 180 s sob carga, sem nenhum `not ok` (#526) | Dividido em `community-member-leave.test.js` e `-2` a `-5`; usa o novo `sync` | 46/336 → 46/336 | 20/20 em cada parte |
| `core/test/group-member.test.js` | Cerca de 279 s contra 180 s (#421, #526) | Dividido em `group-member.test.js` e `-2` a `-6`, com o código comum em `helpers/group-member.js` | 57/463 → 57/463; com o teste de fórum que a `main` acrescentou depois, 58/466, no `-6` | 20/20 em cada parte |
| `core/test/sync-delete.test.js` | Corrigido no #649 ("D lacks block 3 after its scan") | Nada | sem mudança | 20/20 |
| `web-member/test/sync-groups.test.js` | Corrigido no #482 ("more than one page of writers is paged in full", "paged, root and its community fetched") | Nada | sem mudança | 20/20 |
| `web-member/test/e2e-delete-purge.test.js` | Corrigido no #413 | Nada | sem mudança | 20/20 |
| `web-member/test/devices-auto-e2e.test.js` | Não se reproduz | Nada; descartado | sem mudança | 20/20 |
| `core/test/group-seen.test.js` | O teste 3 escrevia 100 posts com `member.groupPost`, que abre e fecha a loja (com `fsync`) a cada post: cerca de 450 ms por post sob carga, acima de 30 s | Novo helper `postMany` escreve os mesmos registros por uma loja só | 6/75 → 6/75 | 20/20 |
| `core/test/seeder-feira.test.js` | Vaga da Feira corrigida no #612. Na rodada final, 3 de 20 cópias falharam no teste 12: o `mediaRead` vinha antes de a conferência local do bloco 0 da mídia (`_gateMedia`, assíncrona depois do download) marcar `headerOk`, e devolvia nulo. O teste 5 tem a mesma espera faltando. É a causa que o #649 corrigiu em `seeder-delete` | Testes 5 e 12 esperam `mediaGated` antes do `mediaRead`. Com a conferência atrasada 1,5 s em memória (`seeder.js` intacto no disco), os dois falham sem a espera (24/26 testes) e passam com ela (26/26) | 26/157 → 26/157 | 17/20 antes; 20/20 depois |
| `cli/test/account-pages-notices.test.js` | Não se reproduz | Nada; descartado | sem mudança | 20/20 |
| `core/test/deletion.test.js` | "deletedRanges" comparava o tempo com 400 ms fixos (#267) | Compara com o caminho ingênuo na mesma máquina, melhor de 3: o otimizado tem de ser mais de 3 vezes mais rápido | 57/920 → 57/920 | 20/20 |
| `core/test/sync-groups-3.test.js` | Não se reproduz | Nada; descartado | sem mudança | 20/20 |
| `web-member/test/private-e2e.test.js` | Não se reproduz | Nada; descartado | sem mudança | 20/20 |
| `web-member/test/sync-groups-2.test.js` | Corrigido no #649 | Nada | sem mudança | 20/20 |
| `cli/test/ai-embedder.test.js` | Falha quando o caminho tem "sharp": ambiente, não intermitência | Nada; descartado | sem mudança | não se aplica |

## Encontrados no caminho

| Arquivo | Causa | O que mudou | Testes/asserções | 20 sob carga |
|---|---|---|---|---|
| `core/test/seeder.test.js` | Teste "equivocation without truncation": depois de os dois clientes dividirem o tópico, o núcleo do autor podia ser truncado pelo conflito antes da comparação de comprimento | Lê o comprimento antes de o gêmeo existir | 29/163 → 29/163 | 20/20 |
| `app/test/vitrine.test.js` | Teste "review shots": o caso de 1000 colisões abre um subshell por nome e passava dos 5 s do `spawnSync` com a máquina ocupada (status `null`) | Prazo de 120 s, só como proteção contra travamento | 34/3532 → 34/3532 | 20/20 |
| `core/test/sync.test.js` | Roda o mesmo código de `sync.js` | Nada | sem mudança | 20/20 |
| `core/test/sync-groups-2.test.js` | Idem | Nada | sem mudança | 20/20 |
| `core/test/seeder-media.test.js` | O teste "a declared media core with a header naming the diary is admitted, listed, downloaded and readable" também não esperava `headerOk`, ao contrário do teste de leitura do mesmo arquivo; não falhou nas medições | Espera o cabeçalho conferido, como o outro teste do arquivo | 9/84 → 9/84 | 20/20 |

## Checagens

- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`: PENDENTE.
- Nenhuma pausa fixa nova: as esperas trocadas por eventos estão nos testes 30, 31 e 34 de `sync-groups`; os `t.timeout` novos têm o tempo medido num comentário.
