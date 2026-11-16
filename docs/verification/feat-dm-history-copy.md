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
| `packages/web-member/test/dm-copy-e2e.test.js` | 32 asserções, 2 testes (~97 s) | com a importação desligada, o teste 1 espera `dm.copyImported` e estoura em 170 s (falha, como exigido) |
| `apps/app/test/historyCopy.test.js` | 5/5 (40 asserções) | |
| `apps/app/test/help.test.js`, `platformGate.test.js`, `conversas*.test.js`, `legal.test.js` | passam | |

Não coberto por teste: importação de armazém de Página (adotada e pendente) e testes unitários de `copySource` em `blob.js`, incluindo o recuo para o semeador antigo.

## Conferências no aparelho (pendentes)

- Copiar de um aparelho com fotos para um segundo aparelho da mesma passkey e abrir a conversa.
- Cota esgotada: texto inteiro, fotos mais antigas de fora, mensagem de resultado correta.
- Conversa apagada no aparelho de origem não aparece no destino.

## Operador

Implante o semeador antes do app. O semeador cria `copy-stamps.json` ao primeiro pedido de selo `copy`; sem ele, um app novo recua para a cota diária de blobs nos textos e deixa as fotos de fora.
