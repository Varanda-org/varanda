# Copiar conversas para outro aparelho (feat/dm-history-copy, #351 item 5)

## Decisões

- Começa só por toque, no aparelho antigo. Leva texto e fotos guardadas (cache), lacrados com a chave da própria conta; todo aparelho da mesma passkey importa.
- Um aviso (inner v7, `from === to ===` dono) aponta para o manifesto, que aponta para os pedaços. Fotos viram blobs novos (chave nova); o blob original nunca é reaproveitado.
- Selo `copy`: um selo de blob com cota semanal própria (8192 por diário e semana de Brasília, `copy-stamps.json`). Semeador antigo não responde: texto e manifesto caem para a cota diária; fotos nunca.
- Importação: linhas entram abaixo de tudo o que o aparelho tem (como `legacyHorizon`), com dedupe (mensagem por remetente e id, ctl por id, reação por remetente e id). Marcas de visto importadas não disparam a sincronização de vistos.
- Conversa apagada no aparelho de origem fica fora (só linhas que a dobra ainda mostra, mais os ctl). Páginas: o armazém da Página entra no aparelho que a guarda; senão espera cifrado (kv `dmCopyPend`) até a Página ser adotada ou até a retenção.
- Resultado: `{ id, messages, photos, notCached, leftOut }`. Sem bump de Termos (texto atualizado na versão 67).

## O que muda

`packages/rpc` (inner v7, eventos, método), `packages/core` (v7, selo `copy`, cota semanal no semeador), `packages/web-member` (`dm-copy.js`, blob com `copySource`, kv, sessão), `apps/app` (linha e folha em Conversas, aviso de importação), docs (`protocol.md` seção 11, `rpc.md` 5.151, `design.md`), Termos e Política.

## Testes

| Arquivo | Resultado | Sem a correção |
|---|---|---|
| `packages/rpc/test/dm-budget.test.js` | 15/15 | |
| `packages/core/test/dm.test.js` | 63/63 | |
| `packages/core/test/dm-stamp-net.test.js` | 26/26 | |
| `packages/core/test/seeder-dm.test.js` | 13/13 | |
| `packages/core/test/activity.test.js` | 9/9 | |
| `packages/web-member/test/dm-copy-e2e.test.js` | 52 asserções, 3 testes (~128 s) | com a importação desligada, o teste 1 espera `dm.copyImported` e estoura em 170 s (falha, como exigido) |
| `dm-copy-e2e.test.js`, teste "the conversations of a Página come along" | 20 asserções (~35 s) | sem o arquivamento dos pendentes (`settle` nunca arquiva): `tempo esgotado: copyImported after adoption`; sem guardar o armazém de uma Página não adotada (`hold` sem efeito): falha em "its conversations wait sealed" e depois no mesmo tempo esgotado |
| `packages/web-member/test/blob.test.js` | 46 testes, 399 asserções (eram 43 e 364) | ver as três linhas abaixo |
| `blob.test.js`, "a copy source buys copy stamps in batches..." | 16 asserções | pedindo selo `blob` em vez de `copy`: falham 4 asserções (contagem de selos de cópia e "the daily blob allowance was never asked", "still no daily stamp") |
| `blob.test.js`, "a copy source whose weekly allowance ends..." | 11 asserções | sem marcar `exhausted` no `teto`: falham 8 asserções (mensagem do limite semanal, `exhausted`, `bought`) |
| `blob.test.js`, "a copy source on a seeder from before the copy kind..." | 8 asserções | sem a falha pegajosa (`failure = err`): falha em "the key is not asked again" |
| `apps/app/test/historyCopy.test.js` | 5/5 (40 asserções) | |
| `apps/app/test/help.test.js`, `platformGate.test.js`, `conversas*.test.js`, `legal.test.js` | passam | |

O seeder de teste do `blob.test.js` ganhou a opção `copyBudget` (nulo é um semeador de antes do tipo `copy`, que não responde). O teste do semeador antigo cobre a falha de `copySource` e o selo diário que passa a pagar o blob.

Não coberto por teste: o `dm-copy.js` inteiro contra um semeador sem o tipo `copy` (texto e manifesto na cota diária, fotos de fora). O e2e de cota esgotada exercita o recuo dos textos, mas com um semeador que oferece o tipo.

## Conferências no aparelho (pendentes)

- Copiar de um aparelho com fotos para um segundo aparelho da mesma passkey e abrir a conversa.
- Cota esgotada: texto inteiro, fotos mais antigas de fora, mensagem de resultado correta.
- Conversa apagada no aparelho de origem não aparece no destino.

## Operador

Implante o semeador antes do app. O semeador cria `copy-stamps.json` ao primeiro pedido de selo `copy`; sem ele, um app novo recua para a cota diária de blobs nos textos e deixa as fotos de fora.
