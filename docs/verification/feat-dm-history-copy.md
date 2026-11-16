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

Revisão da PR 5 (correções, cada teste novo conferido sem a sua correção):

| Arquivo | Testes novos / contagem | Sem a correção |
|---|---|---|
| `packages/web-member/test/dm-copy-unit.test.js` | 4 testes, 37 asserções | `cleanRow` sem as checagens estritas (texto, hora ISO, `mine`, `peer`, bloqueio): falham 11 asserções do teste 1 e as 2 do teste 2; `checkLimits` vazio: falham 4 asserções do teste 4; a validação de `shownAt` (teste 3) não foi conferida removendo-a |
| `packages/web-member/test/dm-copy-e2e-2.test.js` | 2 testes, 27 asserções (~78 s) | Página vazia sem a correção do armazém vazio: estoura `copyImported` (P1); foto pagando com a cota diária: falham "no photo", "left out" e "not re-put"; sem `shownAt` na criação das linhas: falham "shown as on the maker" e "a received message too"; marcas de visto na ordem errada: falha "own marks stay last" |
| `packages/web-member/test/dm-copy-e2e-3.test.js` | 2 testes, 12 asserções (~88 s) | falha de pedaço tratada como final (sem `Soft`): falham 3 asserções do teste 1; aviso anotado depois do cursor: o teste 2 estoura `copyImported after unlock` |
| `packages/core/test/dm-fold.test.js` | 34 testes, 566 asserções (era 33) | sem `shownAt` na dobra: falham 2 asserções do teste novo |
| `packages/web-member/test/dm-copy-e2e.test.js` | asserção nova: o próprio aviso não busca nada | |
| `apps/app/test/historyCopy.test.js` | 5/5, 43 asserções | os textos novos (fotos de Página, cota de cópia, duração) falham sem a troca |

Importação em um só trabalho: a remoção da junção em `importAll` não foi pega pelo teste 2 do `dm-copy-e2e-2` (a contagem de avisos continuou 1, porque o dedupe também a segura); o teste vale como regressão do resultado, não do mecanismo.

O seeder de teste do `blob.test.js` ganhou a opção `copyBudget` (nulo é um semeador de antes do tipo `copy`, que não responde). O teste do semeador antigo cobre a falha de `copySource` e o selo diário que passa a pagar o blob.

O `dm-copy-e2e-2` cobre a falha do selo `copy` no semeador real (o selo lança erro): fotos de fora, texto inteiro, descritor original intacto. Parte e manifesto ainda recuam para a cota diária nesse caso, para a cópia completar com um semeador antigo; só as fotos nunca gastam a cota diária.

Limites conhecidos (não corrigidos de propósito):

- Se várias fotos de uma mensagem batem no limite no meio, todas contam como de fora.
- Selos de cópia comprados e não usados se perdem numa nova tentativa que falha antes de usá-los (uma nova tentativa na mesma sessão reaproveita os quadros e não compra outro).
- O ganho de custo do dedupe com `Set` na importação e a chamada de `checkLimits` dentro de `run` não têm teste de comportamento próprio (só pelo e2e e pelo teste unitário de `checkLimits`).
- Quem tem o segredo da caixa abre o histórico inteiro, e o aviso é lacrado só para a geração atual da caixa (ver `docs/protocol.md`, riscos residuais).

## Conferências no aparelho (pendentes)

- Copiar de um aparelho com fotos para um segundo aparelho da mesma passkey e abrir a conversa.
- Cota esgotada: texto inteiro, fotos mais antigas de fora, mensagem de resultado correta.
- Conversa apagada no aparelho de origem não aparece no destino.

## Operador

Implante o semeador antes do app. O semeador cria `copy-stamps.json` ao primeiro pedido de selo `copy`; sem ele, um app novo recua para a cota diária de blobs nos textos e deixa as fotos de fora (as fotos nunca usam a cota diária).

O selo `copy` é um selo de blob: 8192 por conta e semana, pagos pelo semeador. Dimensione `--blob-bytes` para isso: uma cópia completa de uma conta com muitas fotos consome essa cota inteira de blobs, e os avisos de cópia têm o próprio balde de erros (`issues.copy`).
