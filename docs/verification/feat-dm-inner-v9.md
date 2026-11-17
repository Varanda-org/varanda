# feat/dm-inner-v9

Parte de #352 (paridade do nó core). Só leitura: nenhum nó escreve v9 ou v10 neste PR.

## O que mudou

- `packages/rpc/lib/dm-budget.js` e `packages/rpc/index.js`: `DM_INNER_KEYS_V9` (as chaves v2 com `signer` logo depois de `from`) e `DM_INNER_KEYS_V10` (as chaves v4 com `signer`), no mapa de `canonicalInnerJson`. `dmTextBudget({ v: 9 })`, ou com qualquer `signer`, mede o inner v9.
- `packages/core/lib/dm.js`: domínios `'varanda-dm-v9\n'` e `'varanda-dm-v10\n'`. `validBody` aceita v9 com as regras de forma do v3 e v10 com as do v4, e exige `isDiaryOfSigner(from, signer)`. `openInner` confere a assinatura com `signer` só no v9 e no v10; todo o resto (certificado de `from`, `to`, cópia própria, ctl só para o próprio diário, alvos e respostas vinculadas) segue com `from`. `buildInner(fields, keyPair, { diary })` escreve v9 ou v10; sem `diary` escreve os mesmos bytes de antes, e um `diary` presente que não é diário do assinante (inclusive `null`) ou um terceiro argumento que não é objeto é recusado, para um chamador com o diário ainda nulo não assinar um ctl que nunca abre.
- `packages/web-member/lib/dm.js`: sem mudança. O nó do navegador decide por `kind`, então v9 e v10 entram como v2 e v4, com a linha em nome do diário.
- `docs/protocol.md`: seção 1 (`isDiaryOfSigner`), seção 11 ("Inner v9", "Inner v10", "Bound replies", "Pull checks", "Riscos residuais (DM)").

## Orçamento de texto (`DM_INNER_BYTES` 5120, certificado v2, o maior)

- `signer` ocupa 76 bytes de JSON.
- v9 só texto: 4006 bytes de texto (v1 só texto: 4115; v2 com encaminhamento: 4082). Cabem os 1000 caracteres de 4 bytes.
- v9 com resposta vinculada: 3819 bytes; com esse texto exato o frame enche os 5120 bytes, e um byte a mais dá `mensagem longa demais` antes de selar.

## Testes

- `packages/core/test/dm.test.js` (78/78 testes, 1715/1715 asserções): nove testes novos `inner v9 ...` e `inner v9 and v10 ...`: constantes, abertura com `from` = diário (msg, foto, encaminhamento, resposta, ctl) e v10; recusas, cada uma com sua asserção (assinante que não dá `from`, assinatura de outra chave, assinante de outro diário, v9 no domínio v2 e v10, v2 renomeado v9 e o inverso, chave do navegador com `signer === from`, v10 nos domínios v4 e v9, v4 renomeado v10); regras de forma e o escritor recusando momento, visita, cópia e reivindicação; leitor antigo; resposta vinculada e reação v10 a um v9 (o resumo sem `signer` não confere); bytes de `buildInner` sem `diary` fixados por sha256 calculado com o código de `origin/main` 5128101c (v1, v2 com encaminhamento, resposta vinculada, ctl, reação), com `{}` e `{ diary: undefined }` dando os mesmos bytes e `{ diary: null }`, `''` e argumentos que não são objeto recusados; orçamento.
- `packages/rpc/test/dm-budget.test.js` (17/17, 275/275): listas de chaves, ordem canônica e os números acima.
- `packages/web-member/test/dm.test.js` (84/84, 819/819): `a core node writes v9 and v10: filed and shown from its diary key, not its signer`, com semeador local, um v9 e um v10 postos no pool, puxados e mostrados na conversa com o diário, a reação no lugar, nada sob a chave do assinante.

## Falha sem a correção

Com `openInner` conferindo a assinatura com `from`, como antes, o v9 não abre (`openInner` devolve `null`) e o teste quebra na primeira leitura:

```
# inner v9: a msg and a ctl from a manifest diary open with from = the diary
TypeError: Cannot read properties of null (reading 'v')
```

E o `openInner` de `origin/main` 5128101c, com um ctl v9 do escritor novo: `null`. Restaurada a correção, 78/78.

## Comandos

```sh
npx standard packages/rpc/lib/dm-budget.js packages/rpc/index.js packages/core/lib/dm.js packages/core/test/dm.test.js packages/rpc/test/dm-budget.test.js packages/web-member/test/dm.test.js
node packages/core/test/dm.test.js
node packages/rpc/test/dm-budget.test.js
node packages/web-member/test/dm.test.js   # Node 20.19 ou mais novo
```
