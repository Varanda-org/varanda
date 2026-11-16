# Retenção de 14 dias no semeador (branch feat/dm-retention-14-days)

Issue #351, item 2: um aparelho que ficava mais de 7 dias sem abrir o app perdia os envelopes das mensagens diretas e a mídia que o semeador já tinha varrido. O semeador passa a guardar tudo por 14 dias.

## O que muda

- `DM_RETENTION_MS` (`packages/core/lib/dm.js`): 7 para 14 dias. `DM_POOL_MAX`: 20000 para 40000 envelopes (o conjunto de visitas, `VISIT_POOL_MAX`, fica em 20000 e os pings de visita continuam 3 dias, `VISIT_RETENTION_MS`).
- `BLOB_RETENTION_MS` (`packages/core/lib/blob.js`): 7 para 14 dias, para todo o conjunto de blobs: fotos, GIFs e mensagens de voz das conversas e a mídia dos Momentos, que dividem o mesmo conjunto. `BLOB_POOL_BYTES`: 2 GiB para 4 GiB (padrão de `seed --blob-bytes`).
- O resumo de cada selo gasto continua 14 dias: a retenção padrão dos tokens deixa de ser `2 * retenção` e passa a ser `STAMP_TOKEN_RETENTION_MS` (14 dias, a janela de aceitação de uma chave, `packages/core/lib/dm.js`), nunca menos que a retenção dos registros. Vale para os conjuntos de mensagens e de blobs e para o de visitas (`VISIT_TOKEN_RETENTION_MS`). Sem isso o resumo passaria a 28 dias, e a Política teria de prometer mais tempo de guarda; com 14, a frase dela não muda. Um resumo sai na mesma varredura que tira o envelope, quando a chave dele já não é aceita.
- `DM_V3_STALE_MS = DM_RETENTION_MS + 1 dia` passa de 8 para 15 dias: uma mensagem de Página assinada por um administrador removido ainda é aceita até 15 dias depois. É consequência direta de uma mensagem viver 14 dias no semeador (com 8, uma mensagem legítima de 9 a 14 dias seria descartada), e alarga na mesma medida a janela em que um administrador removido pode usar assinaturas guardadas. Builds nativos antigos continuam com 8 dias: neles, uma mensagem de Página com mais de 8 dias é descartada até a atualização.
- Invariante da chave de selos (`docs/protocol.md` seção 11, "Selos"): a janela de aceitação de uma chave (`MAX_AGE_MS`, 14 dias) não passa da retenção dos tokens gastos. Continua valendo (14 contra 14), e `apps/cli/test/seed-ops.test.js` passa a conferir contra `STAMP_TOKEN_RETENTION_MS` e `VISIT_TOKEN_RETENTION_MS`.
- Não mudam: rotação da chave de selos (7 dias), contagem diária de selos (`dm-stamps.json` guarda 7 dias de contagens), convites (7 dias), troca de @nome, dias de visita, adiamento da exclusão de conta.
- Textos: Termos e Política (`apps/app/src/legal.js`), ajuda do app (`help.js`), nota do Momento (`OWN_NOTE`), `docs/protocol.md`, `docs/rpc.md`, `docs/design.md` (tabela de retenção da seção LGPD), `docs/app.md`, README e `HELP` da CLI (`--blob-bytes`, padrão 4294967296). As páginas do site foram geradas de novo com `node apps/site/scripts/render-legal.js`.

## Decisão

Do mantenedor (Rodrigo), para a issue #351, item 2: "um aparelho offline por mais de 7 dias perde o que o semeador varreu" se resolve guardando por 14 dias, e não com um aviso. Escolhas dele: envelopes das mensagens diretas 14 dias com o conjunto em 40000; todo blob (conversas e Momentos) 14 dias, já que o conjunto é um só, com 4 GiB de teto padrão.

## Testes automáticos

Cada arquivo rodado sozinho com `node <arquivo>`.

| Arquivo | Testes | Asserções | Sem a correção (retenção de volta a 7 dias) |
|---|---|---|---|
| `packages/core/test/dm-pool.test.js` | 23 | 205 | `on its defaults a drop is served at 10 days and swept past 14, with its spent token` falha (aos 10 dias o envelope já foi varrido). Com a retenção dos tokens de volta a `2 * retenção`, falham esse teste (o resumo fica depois da varredura) e `the visit pool keeps pings 3 days but remembers stamps as long as the dm pool` |
| `packages/core/test/blob-pool.test.js` | 34 | 388 | `on its defaults a blob is served at 10 days and swept past 14, with its spent tokens` falha (aos 10 dias o blob já foi varrido); com a retenção dos tokens de volta a `2 * retenção`, falha o mesmo teste (o selo continua gasto depois da varredura) |
| `packages/core/test/dm.test.js` | 59 | 1066 | `constants` falha (`DM_RETENTION_MS`, `DM_POOL_MAX`) |
| `packages/core/test/blob.test.js` | 9 | 112 | `constants` falha (`BLOB_RETENTION_MS`, `BLOB_POOL_BYTES`) |
| `packages/core/test/blob-net.test.js` | 11 | 64 | usa `BLOB_RETENTION_MS`, passa nos dois casos |
| `packages/core/test/seeder-dm.test.js` | 11 | 109 | passa nos dois casos |
| `packages/core/test/dm-net.test.js` | 18 | 133 | passa nos dois casos |
| `packages/core/test/dm-stamp-net.test.js` | 21 | 148 | passa nos dois casos |
| `packages/core/test/dm-fold.test.js` | 33 | 561 | passa nos dois casos |
| `packages/core/test/visit-lane.test.js` | 4 | 46 | passa nos dois casos |
| `apps/cli/test/seed-ops.test.js` | 15 | 202 | passa nos dois casos (a invariante vale com 7 e com 14) |
| `apps/cli/test/cli.test.js` | 5 | 1336 | o `HELP` com 2147483648 falha contra o texto novo |
| `apps/cli/test/readme-help.test.js` | 1 | 2 | idem |
| `apps/cli/test/blob-seeder.test.js` | 5 | 101 | passa nos dois casos |
| `apps/app/test/legal.test.js` | 49 | passa | o digest (`published text is pinned to its acceptance version`) falha sem os textos novos; Termos e Política na versão 68 |
| `apps/app/test/help.test.js` | 15 | 541 | falha sem o texto novo |
| `apps/app/test/momentosScreen.test.js` | 167 | 1362 | falha sem o texto novo (`OWN_NOTE`) |
| `apps/site/test/legal.test.js` | 7 | 115 | falha se as páginas não forem geradas de novo |
| `packages/web-member/test/page-dm.test.js` | 19 | 213 | passa nos dois casos |
| `packages/web-member/test/dm.test.js` | 65 | 713 | passa nos dois casos |
| `packages/web-member/test/blob.test.js` | 43 | 364 | passa nos dois casos |
| `packages/web-member/test/dm-store.test.js` | 30 | 238 | passa nos dois casos |

`npm run lint` passa.

## Operador

- Os semeadores precisam ser reimplantados para os 14 dias valerem. Os envelopes e blobs que já estão no disco simplesmente passam a viver mais tempo: a varredura compara o `receivedAt` de cada um com a retenção nova, então nada precisa ser migrado e nada que já estava no conjunto é apagado antes da hora.
- Um semeador iniciado com `--blob-bytes` mantém o teto dele; o padrão de 4 GiB vale só sem a opção.
- Conferir o disco livre: até cerca de 4 GiB de blobs (`<dados>/blobs/`; com os arquivos de controle, perto de 4,5 GiB no disco) mais cerca de 220 MB do conjunto de mensagens (40000 envelopes de 5501 bytes), fora o resto dos dados. A compactação do conjunto de mensagens reescreve o `log.bin` inteiro num arquivo novo antes de trocar: com o conjunto cheio, precisa de mais uns 220 MB livres nesse momento.
- `head.json` guarda um resumo por selo gasto: com o conjunto cheio, cerca de 40000 entradas (uns 4 MB), reescrito a cada varredura que remove algo.
- Um aparelho que abre o app depois de 14 dias fora baixa o conjunto inteiro na primeira leitura (até cerca de 220 MB, o dobro de hoje), em páginas de 8.
- Partida do semeador com o conjunto de blobs cheio: a carga lê os pedaços guardados para recuperar os selos (`tokens.json` e os registros de confirmação); com 4 GiB isso leva mais tempo que com 2 GiB. A espera do `/health` no deploy é de 180 s. Fica no #224 medir uma partida com o conjunto cheio antes de confiar nesse prazo.
- Os resumos de selos gastos continuam 14 dias em `head.json` e `tokens.json`, sem mudança de formato.

## Termos

`TERMS_VERSION` (`packages/core/lib/terms.js`) e `LEGAL_VERSION` (`apps/app/src/legal.js`) sobem para 68, com o digest de `apps/app/test/legal.test.js` e as páginas do site geradas de novo. Quem já aceitou a versão 67 vê o pedido de aceite de novo.

## Conferência em aparelho

Conferido em 16/11/2026 com a demonstração (`EXPO_PUBLIC_VARANDA_VITRINE=1`, Metro do branch), no Android 16 no emulador (build de debug `app.varanda.debug`), no iOS 26.2 no simulador iPhone 17 Pro e na web no navegador embutido do Claude (Chromium):

- A ajuda das conversas diz que a associação guarda os envelopes lacrados por 14 dias: Android e iOS, ok.
- A nota do Momento ("O momento sai dos servidores em até 14 dias."): Android e web, ok. No iOS não foi capturada, porque o visor avança sozinho antes do toque.
- O que depende do semeador de verdade (envelopes e mídia que duram 14 dias, o teto de 40000 envelopes e 4 GiB) fica para a lista do operador (#224).
