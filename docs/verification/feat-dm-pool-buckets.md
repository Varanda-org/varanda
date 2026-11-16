# Grupos de envelopes nas mensagens diretas (#351, item 1)

Branch `feat/dm-pool-buckets`. O conjunto de envelopes de mensagens diretas e o das Visitas deixam de ser um só por semeador e passam a ter até 64 grupos (buckets). Protocolo em `docs/protocol.md`, seção 11, "Buckets".

## Decisões

- Número de grupo: os 6 bits de cima do primeiro byte de `BLAKE2b-256('varanda/dm-bucket/v1' || chave pública de mensagens)`. Vetor fixo no teste: chaves de bytes 1 a 32 dão 36.
- O semeador escolhe os bits pela contagem de diários servidos: 0 abaixo de 1.000, 1 de 1.000 a 1.999, mais um a cada dobro, 6 a partir de 32.000. Cada grupo tem cerca de 500 pessoas ou mais.
- Canais novos `'varanda/dm/2'` e `'varanda/visit/2'`; os canais v1 não mudam um byte. O semeador abre com os seus bits no handshake e o aparelho abre com 0.
- Marca no armazenamento: byte de cima do `receivedAt` de cada registro (0 é sem marca; senão `(1 << bits) | grupo`). Vale nos dois sentidos entre bits diferentes (`m = min(bits da entrada, bits do pedido)`), e um envelope sem marca serve a qualquer pedido.
- Quem envia põe a cópia do destinatário no grupo do destinatário e a cópia própria no grupo de quem envia. Quem lê e não cuida de nenhuma Página pede só o próprio grupo. Decisão da rodada 5 (mantenedor): um aparelho que cuida de qualquer Página pede todos os grupos, numa só passada a partir do mais antigo dos seus cursores (o próprio e o de cada Página); cada leitura arquiva só o que está acima do seu cursor e, no fim, todos os cursores ficam no mesmo ponto. Pedir só os grupos de uma Página entregaria ao semeador qual Página roda naquela conexão.

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

Atualize os semeadores antes do app. Um app novo num semeador antigo usa o v1 (sem grupo); um app antigo num semeador novo usa o v1 e baixa tudo. O texto legal mudou (Termos e Privacidade); a versão dos Termos não foi subida neste PR e o digest de `apps/app/test/legal.test.js` falha até a manutenção subir `LEGAL_VERSION` e `TERMS_VERSION`. Digest novo: `b59b35b113078c64a4a69129caf6c49ad0cef25dce7e2183111b506b592cd3b8`. O texto da Privacidade agora diz "a partir de 1.000 contas", "grupos de até 1/64 das contas" e que quem cuida de uma Página pede todos os grupos.

## Testes

Cada arquivo rodado sozinho com `node <arquivo>` no diretório do pacote. "Sem a correção" é a mesma regressão com a correção tirada de propósito e depois devolvida.

| Arquivo | Testes novos | Resultado | Sem a correção |
|---|---|---|---|
| `packages/core/test/dm.test.js` | vetor do `bucketPrefix`, tabela do `bucketBits` | 61/61 | não aplicável (função nova) |
| `packages/core/test/dm-pool.test.js` | 4: marca, página por grupo, combinação entre bits, sem marca | 26/26 | filtro da página removido: 18 asserções falham |
| `packages/core/test/dm-net.test.js` | 7 do canal v2 | 25/25 | truncamento do prefixo removido: o arquivo cai com saída 1 |
| `packages/core/test/visit-lane.test.js` | 3: bits pela contagem servida, put e página por grupo nos dois canais, `--no-dm` | 7/7 | não aplicável |
| `packages/web-member/test/dm.test.js` | 6 de grupo | 73/73 | sem os prefixos na leitura própria, "pull baixa só o próprio grupo" falha (servidos 6, 12, ... em vez de 1, 3, 6) |
| `packages/web-member/test/dm-store.test.js` | prefixo na fila de visitas | 32/32 | não aplicável |
| `packages/web-member/test/page-dm.test.js` | 1 (substitui o antigo, que usava um aparelho aleatório e falhava em cerca de 5% das rodadas): sem Página pede 1 grupo; com Página, todos os grupos, uma passada por pull (inclusive depois de mudar a geração), cada envelope baixado e arquivado uma vez | 20/20 (231 asserções), determinístico (não depende de sorteio) | com a leitura anterior (`dm.js` do commit revisado): 19/20, 9 asserções falham (filtro de grupo presente, 2 pedidos por pull em vez de 1) |
| `packages/web-member/test/dm.test.js` | 2: um semeador que abre o v2 com 7 bits cai para o v1 e a mensagem chega; um bloqueio durante a abertura do link do pull dá a mensagem de bloqueio (`UsageError`), não um `TypeError` | 73/73 (746 asserções) | v1: sem a recusa de mais de 6 bits no aparelho, 2 asserções falham (puts marcados, página no canal de 7 bits). Bloqueio: sem a checagem de `box === null`, 2 falham (`TypeError: Cannot read properties of null`) |

Sem alteração e verdes: `packages/core/test/seeder-dm.test.js` 11/11, `dm-wake.test.js` 3/3, `packages/web-member/test/dm-link.test.js` 6/6, `visits-e2e.test.js` 2/2.

## Rodada de correções da revisão (2026-11-16)

- P1: a leitura de quem cuida de Página pede todos os grupos (`packages/web-member/lib/dm.js`, `pull`); `pagePrefixes` saiu. A passada única também resolve o custo de um pedido extra por Página a cada pull. Se o orçamento (`incomplete`) corta a passada, os cursores param no mesmo ponto.
- Teste instável (um aparelho aleatório podia cair no grupo de outro, 3 em 64): o teste novo não depende de sorteio.
- `docs/protocol.md`: o aparelho trunca (`prefix >> (6 - bits)`), não o semeador; o pull de um destinatário nunca pede o grupo de quem envia de propósito; a seção 11 explica por que quem cuida de Página pede tudo.
- Privacidade: "a partir de 1.000 contas", "grupos de até 1/64 das contas" e a nota sobre Páginas; páginas do site renderizadas de novo.
- Bloqueio durante um pull: `pull` e `pullVisits` checam `box === null` depois de abrir o link e lançam `LOCKED`; `ctxPrefix` devolve `null` sem a caixa.
- Comentário de `dm-link.js` corrigido: um v2 que trava custa até um prazo de pedido antes do prazo do v1 (cerca de o dobro), ainda dentro do prazo do link.
- Sem teste: troca dos bits do semeador entre o put e a página no nível do aparelho (a lógica do conjunto já tem teste); bloqueio dentro de `flushCtlQueue` (o erro é engolido, sem efeito visível).

## Limites conhecidos (não corrigidos)

- Um aparelho que abre v1 e v2 ao mesmo tempo ganha o dobro de orçamento de páginas e de puts por canal; as senhas de postagem continuam limitando os puts.
- Um byte de cima corrompido no carregamento de um registro vira "sem marca": inofensivo (o envelope é servido a todos).
