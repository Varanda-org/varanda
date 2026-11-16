# Grupos de envelopes nas mensagens diretas (#351, item 1)

Branch `feat/dm-pool-buckets`. O conjunto de envelopes de mensagens diretas e o das Visitas deixam de ser um só por semeador e passam a ter até 64 grupos (buckets). Protocolo em `docs/protocol.md`, seção 11, "Buckets".

## Decisões

- Número de grupo: os 6 bits de cima do primeiro byte de `BLAKE2b-256('varanda/dm-bucket/v1' || chave pública de mensagens)`. Vetor fixo no teste: chaves de bytes 1 a 32 dão 36.
- O semeador escolhe os bits pela contagem de diários servidos: 0 abaixo de 1.000, 1 de 1.000 a 1.999, mais um a cada dobro, 6 a partir de 32.000. Cada grupo tem cerca de 500 pessoas ou mais.
- Canais novos `'varanda/dm/2'` e `'varanda/visit/2'`; os canais v1 não mudam um byte. O semeador abre com os seus bits no handshake e o aparelho abre com 0.
- Marca no armazenamento: byte de cima do `receivedAt` de cada registro (0 é sem marca; senão `(1 << bits) | grupo`). Vale nos dois sentidos entre bits diferentes (`m = min(bits da entrada, bits do pedido)`), e um envelope sem marca serve a qualquer pedido.
- Quem envia põe a cópia do destinatário no grupo do destinatário e a cópia própria no grupo de quem envia. Quem lê pede o próprio grupo e o das páginas que tem ou lê junto, nunca o de quem escreveu.

## Desvios aceitos em relação ao desenho

- `bucketBits` segue a tabela (1.000 a 1.999 dá 1 bit, 32.000 ou mais dá 6), não a fórmula do rascunho, que a contradizia.
- Um semeador que anuncia mais de 6 bits é tratado como sem suporte ao v2: o aparelho fecha o canal e usa o v1.
- Em `dm-link`, a espera pela abertura do v2 é limitada pelo prazo de pedido; passado o prazo, o aparelho usa o v1.

## Riscos que ficam

- O semeador liga o grupo de quem recebe ao grupo de quem envia, por mensagem (horário e mesma conexão).
- Um semeador alterado pode anunciar mais bits, até 6, e dividir o conjunto em grupos menores. Os aparelhos não conferem a contagem honesta.
- Envelopes postos por versões anteriores não têm marca e continuam baixados por todos.
- Com mais de 6 bits anunciados, o aparelho volta ao v1.

## Nota para quem opera

Atualize os semeadores antes do app. Um app novo num semeador antigo usa o v1 (sem grupo); um app antigo num semeador novo usa o v1 e baixa tudo. O texto legal mudou (Termos e Privacidade); a versão dos Termos não foi subida neste PR e o digest de `apps/app/test/legal.test.js` falha até a manutenção subir `LEGAL_VERSION` e `TERMS_VERSION`. Digest novo: `4159ca721ed5aee7add74a03c475c92e07c7375edad2c82787610b3064ce7997`.

## Testes

Cada arquivo rodado sozinho com `node <arquivo>` no diretório do pacote. "Sem a correção" é a mesma regressão com a correção tirada de propósito e depois devolvida.

| Arquivo | Testes novos | Resultado | Sem a correção |
|---|---|---|---|
| `packages/core/test/dm.test.js` | vetor do `bucketPrefix`, tabela do `bucketBits` | 61/61 | não aplicável (função nova) |
| `packages/core/test/dm-pool.test.js` | 4: marca, página por grupo, combinação entre bits, sem marca | 26/26 | filtro da página removido: 18 asserções falham |
| `packages/core/test/dm-net.test.js` | 7 do canal v2 | 25/25 | truncamento do prefixo removido: o arquivo cai com saída 1 |
| `packages/core/test/visit-lane.test.js` | 3: bits pela contagem servida, put e página por grupo nos dois canais, `--no-dm` | 7/7 | não aplicável |
| `packages/web-member/test/dm.test.js` | 6 de grupo | 71/71 | sem os prefixos na leitura própria, "pull baixa só o próprio grupo" falha (servidos 6, 12, ... em vez de 1, 3, 6) |
| `packages/web-member/test/dm-store.test.js` | prefixo na fila de visitas | 32/32 | não aplicável |
| `packages/web-member/test/page-dm.test.js` | página em posse varre só os grupos das suas caixas, junto e sozinha | 20/20 (224 asserções) | sem `prefixes: pagePrefixes(p)` na leitura da página: o teste falha (4 asserções, entre elas "nunca o grupo de quem envia") |

Sem alteração e verdes: `packages/core/test/seeder-dm.test.js` 11/11, `dm-wake.test.js` 3/3, `packages/web-member/test/dm-link.test.js` 6/6, `visits-e2e.test.js` 2/2.
