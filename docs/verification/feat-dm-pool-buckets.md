# Grupos de envelopes nas mensagens diretas (#351, item 1)

Branch `feat/dm-pool-buckets`. O conjunto de envelopes de mensagens diretas e o das Visitas deixam de ser um só por semeador e passam a ter até 64 grupos (buckets). Protocolo em `docs/protocol.md`, seção 11, "Buckets".

## Decisões

- Número de grupo: os 6 bits de cima do primeiro byte de `BLAKE2b-256('varanda/dm-bucket/v1' || chave pública de mensagens)`. Vetor fixo no teste: chaves de bytes 1 a 32 dão 36.
- O semeador escolhe os bits pela contagem de diários servidos: 0 abaixo de 1.000, 1 de 1.000 a 1.999, mais um a cada dobro, 6 a partir de 32.000. Cada grupo tem cerca de 500 pessoas ou mais.
- Canais novos `'varanda/dm/2'` e `'varanda/visit/2'`; os canais v1 não mudam um byte. O semeador abre com os seus bits no handshake e o aparelho abre com 0.
- Marca no armazenamento: byte de cima do `receivedAt` de cada registro (0 é sem marca; senão `(1 << bits) | grupo`). Vale nos dois sentidos entre bits diferentes (`m = min(bits da entrada, bits do pedido)`), e um envelope sem marca serve a qualquer pedido.
- Quem envia põe a cópia do destinatário no grupo do destinatário e a cópia própria no grupo de quem envia. Quem lê e não cuida de nenhuma Página pede só o próprio grupo. Decisão da rodada 5 (mantenedor): um aparelho que cuida de qualquer Página pede todos os grupos em todo pedido, no pull e no pull de Visitas, decidido pelas Páginas que guarda (não por as leituras delas abrirem). Pedir só os grupos de uma Página entregaria ao semeador qual Página roda naquela conexão. Pelo mesmo motivo, os envelopes lacrados para a caixa de uma Página por quem cuida dela (as mudanças das conversas dela e a cópia própria das respostas dela) vão sem grupo.
- Decisão da rodada 7 (mantenedor): a cópia própria e as mudanças das conversas próprias de quem cuida de uma Página continuam no grupo próprio. O risco que isso deixa está em "Riscos que ficam".
- O pull de quem cuida de Página lê primeiro as mensagens próprias: uma passada a partir do cursor próprio, com as Páginas em dia indo junto. Depois, se o orçamento não acabou e alguma Página está atrás (adoção, geração nova, importação antiga), uma passada de recuperação a partir do mais antigo desses cursores. Uma leitura só entra numa passada se o seu cursor está no início dela ou acima; arquiva só o que está acima do seu cursor, e o cursor vai até o último item lido, nunca para trás. As duas passadas dividem o orçamento: onde ele corta, cada cursor fica no último item que a sua leitura viu, e a recuperação continua no pull seguinte, depois da passada própria.

## Desvios aceitos em relação ao desenho

- `bucketBits` segue a tabela (1.000 a 1.999 dá 1 bit, 32.000 ou mais dá 6), não a fórmula do rascunho, que a contradizia.
- Um semeador que anuncia mais de 6 bits é tratado como sem suporte ao v2: o aparelho fecha o canal e usa o v1.
- Em `dm-link`, a espera pela abertura do v2 é limitada pelo prazo de pedido; passado o prazo, o aparelho usa o v1.

## Riscos que ficam

- O semeador liga o grupo de quem recebe ao grupo de quem envia, por mensagem (horário e mesma conexão).
- Um semeador alterado pode anunciar mais bits, até 6, e dividir o conjunto em grupos menores. Os aparelhos não conferem a contagem honesta.
- Envelopes postos por versões anteriores não têm marca e continuam baixados por todos.
- Com mais de 6 bits anunciados, o aparelho volta ao v1.
- Rodada 7: o pedido de todos os grupos diz ao semeador que o aparelho cuida de alguma Página, e a cópia própria e as mudanças próprias desse aparelho vão no grupo próprio. Cruzando horário e endereço de internet com os rosters públicos (os `dm-key`s dos admins ele consegue pôr em grupos), um semeador poderia descobrir qual Página o aparelho cuida.

## Nota para quem opera

Atualize os semeadores antes do app. Um app novo num semeador antigo usa o v1 (sem grupo); um app antigo num semeador novo usa o v1 e baixa tudo. O texto legal mudou (Termos e Privacidade); a versão dos Termos não foi subida neste PR e o digest de `apps/app/test/legal.test.js` falha até a manutenção subir `LEGAL_VERSION` e `TERMS_VERSION`. Digest novo: `0c55d9c43f5753ecd9d03f2152173a410187146c8f99b17769139d63d0dc6bb6`. O texto da Privacidade agora diz "a partir de 1.000 contas", "grupos de até 1/64 das contas", que quem cuida de uma Página pede todos os grupos, que as cópias das respostas da Página e das mudanças nas conversas dela vão sem grupo, e que um semeador que observe horário e endereço de internet poderia descobrir de qual Página o aparelho cuida.

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
| `packages/web-member/test/page-dm.test.js` | 1 (substitui o antigo, que usava um aparelho aleatório e falhava em cerca de 5% das rodadas): sem Página pede 1 grupo; com Página, todos os grupos em todo pedido; um pedido por pull enquanto o conjunto cabe numa página (até 8 envelopes); nenhum envelope repetido na conversa, o que vem da remoção de repetidos por id nos armazenamentos, não da correção. Na rodada 2, depois de mudar a geração, o teste espera a passada própria a partir do cursor próprio e a recuperação a partir de 0 | 20/20 (231 asserções) na rodada 1, determinístico (não depende de sorteio) | com a leitura anterior (`dm.js` do commit revisado): 19/20, 9 asserções falham (filtro de grupo presente, 2 pedidos por pull em vez de 1) |
| `packages/web-member/test/dm.test.js` | 2: um semeador que abre o v2 com 7 bits cai para o v1 e a mensagem chega; um bloqueio durante a abertura do link do pull dá a mensagem de bloqueio (`UsageError`), não um `TypeError` | 73/73 (746 asserções) | v1: sem a recusa de mais de 6 bits no aparelho, 2 asserções falham (puts marcados, página no canal de 7 bits). Bloqueio: sem a checagem de `box === null`, 2 falham (`TypeError: Cannot read properties of null`) |

Sem alteração e verdes: `packages/core/test/seeder-dm.test.js` 11/11, `dm-wake.test.js` 3/3, `packages/web-member/test/dm-link.test.js` 6/6, `visits-e2e.test.js` 2/2.

## Rodada de correções da revisão (2026-11-16)

- P1: a leitura de quem cuida de Página pede todos os grupos (`packages/web-member/lib/dm.js`, `pull`); `pagePrefixes` saiu. A passada única também resolve o custo de um pedido extra por Página a cada pull. Se o orçamento (`incomplete`) corta a passada, os cursores que estavam abaixo do corte param nele; um cursor próprio à frente do corte fica onde estava. A rodada 2 trocou a passada única por duas (veja abaixo).
- Teste instável (um aparelho aleatório podia cair no grupo de outro, 3 em 64): o teste novo não depende de sorteio.
- `docs/protocol.md`: o aparelho trunca (`prefix >> (6 - bits)`), não o semeador; o pull de um destinatário nunca pede o grupo de quem envia de propósito; a seção 11 explica por que quem cuida de Página pede tudo.
- Privacidade: "a partir de 1.000 contas", "grupos de até 1/64 das contas" e a nota sobre Páginas; páginas do site renderizadas de novo.
- Bloqueio durante um pull: `pull` e `pullVisits` checam `box === null` depois de abrir o link e lançam `LOCKED`; `ctxPrefix` devolve `null` sem a caixa.
- Comentário de `dm-link.js` corrigido: um v2 que trava custa até um prazo de pedido antes do prazo do v1 (cerca de o dobro), ainda dentro do prazo do link.
- Sem teste: troca dos bits do semeador entre o put e a página no nível do aparelho (a lógica do conjunto já tem teste). O bloqueio dentro de `flushCtlQueue` ganhou teste e correção na rodada 2.

## Segunda rodada de correções da revisão (2026-11-16)

Em `packages/web-member/lib/dm.js`:

- P1-1: os envelopes lacrados para a caixa de uma Página vão sem grupo: `ctxPrefix` devolve `null` para as mudanças de uma Página, e a cópia própria de uma resposta da Página vai com `[grupo do destinatário, null]`. A cópia própria e as mudanças próprias de quem cuida de Página continuam no grupo próprio (rodada 7).
- P1-2: o pull de Visitas de quem cuida de Página pede todos os grupos, como o pull.
- P2-2: as mensagens próprias vêm primeiro. O pull faz a passada própria a partir do cursor próprio e, se sobrar orçamento, a recuperação a partir do mais antigo dos cursores de Página atrasados (regras em "Decisões"). Antes, um cursor de Página em 0 fazia a passada única começar no início do conjunto, e uma mensagem própria nova podia esperar vários pulls.
- P3-1: `asksAll` vem de `pages.pages().length > 0`, lido antes das leituras das Páginas: uma leitura que falha não faz o aparelho pedir só o próprio grupo.
- P3-2: `flushCtlQueue` confere a geração e o bloqueio depois de abrir o link, antes de `dm.sending` e do put. Um bloqueio nessa hora não põe nada; a mudança fica na fila para o próximo desbloqueio.
- P2-1: Privacidade (`apps/app/src/legal.js`, página do site renderizada de novo), a linha de `docs/design.md`, o fragmento do changelog e a seção 11 de `docs/protocol.md` dizem que os envelopes da Página vão sem grupo, que o pull de Visitas também pede todos os grupos e o risco da rodada 7.

| Arquivo | Testes novos | Resultado | Sem a correção |
|---|---|---|---|
| `packages/web-member/test/page-dm.test.js` | "drops sealed to a Página box go untagged; the own self copy and the own ctl keep the own bucket" (aparelho real, semeador com 6 bits) | 26/26 (264 asserções) | P1-1 tirada (`ctxPrefix` e a cópia própria da resposta com o grupo da Página): 2 asserções falham ("a Página ctl goes untagged", "a Página reply: the recipient bucket, then its self copy untagged") |
| idem | "a Página adopted after the own cursor passed its drop files that drop on the next pull" | idem | sem a passada de recuperação: o teste antigo "page secrets" já cai (asserções 14 e 15, depois um `TypeError` que para o arquivo); este teste rodado sozinho (`test.solo` numa cópia temporária): 1 de 5 asserções falha. Passa com o `dm.js` do commit revisado (a passada única começava no cursor da Página): é guarda do desenho novo |
| idem | "the visit pull of a device that holds a Página asks every bucket; one that holds none asks its own" | idem | P1-2 tirada: 1 asserção falha ("a holder: every bucket") |
| idem | "a new own message is filed on the first pull while a Página catches up from 0" | idem | com o início antigo (passada única a partir do menor cursor): 4 asserções falham neste teste (mensagem nova não arquivada, cursor próprio em 10 em vez de 11, pedidos `[0]` em vez de `[10, 0]`), e também 3 no teste de grupos antigo, 2 no de orçamento e 1 no de leitura repetida, 10 ao todo |
| idem | "where the budget stops a holder pull, each cursor stays at the last item its scan saw and the next pull goes on from there" | idem | sem a guarda do cursor próprio (`after > cursor`): 2 asserções falham aqui e 1 no teste da mensagem nova (o cursor próprio voltava para trás). Com o início antigo: o cursor próprio ficava em 9 por 4 pulls |
| idem | "a message the own scan skipped stays unfiled when a Página catch-up reads it again" | idem | sem o filtro `item.seq > cursor` da leitura própria: 2 asserções falham (a mensagem de um remetente bloqueado era arquivada depois do desbloqueio) |
| idem | teste de grupos antigo: depois de mudar a geração, 2 pedidos (a passada própria a partir do cursor próprio, a recuperação a partir de 0), em vez de 1 | idem | com o início antigo: 3 asserções falham |
| `packages/web-member/test/dm.test.js` | "a lock while a ctl flush opens its link puts nothing; the stamped ctl goes out at the next unlock" | 74/74 (751 asserções) | P3-2 tirada: 2 asserções falham ("no dm.sending and no put after the lock", "still queued") |

Com todo o `dm.js` do commit revisado (9f07f89f) e os testes novos: `page-dm.test.js` 20/26 (13 asserções falham; só o teste da adoção passa), `dm.test.js` 73/74 (2 falham).

`apps/app/test/legal.test.js`: 48/49, só o digest fixo falha (esperado, a versão dos Termos fica com a manutenção).

## Limites conhecidos (não corrigidos)

- Depois de uma troca pública de geração de uma Página, quem cuida dela começa a recuperação do pull seguinte em `after: 0`, e quem cuida de outras Páginas não. Um semeador que acompanhe o diário da Página pode ligar esses aparelhos a ela. Já era assim antes dos grupos.
- Uma recuperação a partir de 0 relê o conjunto em vários pulls, um orçamento por pull. As mensagens próprias não esperam por ela, porque a passada própria vem antes em cada pull.

- Um aparelho que abre v1 e v2 ao mesmo tempo ganha o dobro de orçamento de páginas e de puts por canal; as senhas de postagem continuam limitando os puts.
- Um byte de cima corrompido no carregamento de um registro vira "sem marca": inofensivo (o envelope é servido a todos).
