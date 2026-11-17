# Grupos de envelopes nas mensagens diretas (#351, item 1)

Branch `feat/dm-pool-buckets`. O conjunto de envelopes de mensagens diretas e o das Visitas deixam de ser um só por semeador e passam a ter até 64 grupos (buckets). Protocolo em `docs/protocol.md`, seção 11, "Buckets".

## Decisões

- Número de grupo: os 6 bits de cima do primeiro byte de `BLAKE2b-256('varanda/dm-bucket/v1' || chave pública de mensagens)`. Vetor fixo no teste: chaves de bytes 1 a 32 dão 36.
- O semeador escolhe os bits pela contagem de diários servidos: 0 abaixo de 1.000, 1 de 1.000 a 1.999, mais um a cada dobro, 6 a partir de 32.000. Cada grupo tem cerca de 500 pessoas ou mais.
- Canais novos `'varanda/dm/2'` e `'varanda/visit/2'`; os canais v1 não mudam um byte. O semeador abre com os seus bits no handshake e o aparelho abre com 0.
- Marca no armazenamento: byte de cima do `receivedAt` de cada registro (0 é sem marca; senão `(1 << bits) | grupo`). Vale nos dois sentidos entre bits diferentes (`m = min(bits da entrada, bits do pedido)`), e um envelope sem marca serve a qualquer pedido.
- Quem envia põe a cópia do destinatário no grupo do destinatário e a cópia própria no grupo de quem envia. Quem lê e não cuida de nenhuma Página pede só o próprio grupo. Decisão da rodada 5 (mantenedor): um aparelho que cuida de qualquer Página pede todos os grupos em todo pedido, no pull e no pull de Visitas, decidido pelas Páginas que guarda (não por as leituras delas abrirem). Pedir só os grupos de uma Página entregaria ao semeador qual Página roda naquela conexão. Pelo mesmo motivo, os envelopes lacrados para a caixa de uma Página por quem cuida dela (as mudanças das conversas dela e a cópia própria das respostas dela) não vão no grupo da Página (a rodada 9 trocou "sem grupo" por um grupo sorteado, abaixo).
- Decisão da rodada 7 (mantenedor): a cópia própria e as mudanças das conversas próprias de quem cuida de uma Página continuam no grupo próprio. O risco que isso deixa está em "Riscos que ficam".
- Decisão da rodada 9 (mantenedor): os envelopes lacrados para a caixa de uma Página por quem cuida dela vão com um grupo sorteado pelo gerador criptográfico, uma vez por envelope, e guardado com ele (na fila de mudanças e na entrada da resposta), para que uma nova tentativa repita o mesmo grupo. O sorteio é uniforme entre os 64 grupos e nunca sai de algo que o semeador vê nem do grupo próprio ou do da Página. Sem grupo, eles se destacariam como envelopes de Página e chegariam a todos os aparelhos; no grupo próprio, ligariam a Página ao grupo de quem cuida dela. Quem cuida pede todos os grupos, então a entrega não muda. Uma mudança que já estava na fila antes desta versão não tem grupo sorteado e continua sem grupo.
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
- Rodada 7: o pedido de todos os grupos diz ao semeador que o aparelho cuida de alguma Página, e a cópia própria e as mudanças próprias desse aparelho vão no grupo próprio. Cruzando horário e endereço de internet com os rosters públicos (os `dm-key`s dos admins ele consegue pôr em grupos), um semeador poderia descobrir qual Página o aparelho cuida. Como a lista de quem cuida de cada Página é pública, isso diz também de quem são as mensagens da Página. O grupo sorteado da rodada 9 não piora isso.
- Rodada 9, semeador que também junta os envios por endereço: a segunda marca de uma resposta da Página de quem cuida não é o grupo próprio 63 vezes em 64, então ele distingue esses envios dos envios próprios e fica sabendo o grupo de quem recebe e o horário de cada resposta da Página. Sem marca ele sabia o mesmo.
- Rodada 9: um canal com três ou mais envios cujas marcas são todas diferentes só vem de uma fila de mudanças de Página esvaziada num canal só (uma fila própria é `(X, X, X)`, um envio são dois). O semeador fica sabendo que aqueles envelopes são mudanças de Página e que um aparelho que cuida de Página está atrás do canal, não qual Página nem qual grupo.
- Rodada 9, semeador alterado que anuncia 6 bits numa rede pequena: muitos grupos ficam sem nenhuma caixa (cerca de e^(-N/64) deles com N contas), e um envio num grupo vazio só pode ser cópia de Página. Um semeador honesto só liga os grupos acima de 1.000 diários, onde cada grupo tem centenas de caixas.

## Nota para quem opera

Atualize os semeadores antes do app. Um app novo num semeador antigo usa o v1 (sem grupo); um app antigo num semeador novo usa o v1 e baixa tudo. O texto legal mudou (Termos e Privacidade); `LEGAL_VERSION` e `TERMS_VERSION` sobem para 74 (depois da 72 da `feat/dm-retention-14-days`, com os 14 dias, e da 73 da `feat/sync-once-notices`), com o digest de `apps/app/test/legal.test.js` e as páginas do site geradas de novo. Quem já aceitou aceita de novo. O texto da Privacidade agora diz "a partir de 1.000 contas", "grupos de até 1/64 das contas", que quem cuida de uma Página pede todos os grupos, que as cópias das respostas da Página e das mudanças nas conversas dela vão com um número de grupo sorteado, para parecerem um envelope qualquer, e que um semeador que observe horário e endereço de internet poderia descobrir de qual Página o aparelho cuida e, como a lista de quem cuida de cada Página é pública, que essas mensagens são de quem cuida.

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

`apps/app/test/legal.test.js`: 48/49 na época, só o digest fixo falhava; depois do merge da `main` e da versão 74, 51/51.

## Terceira rodada de correções da revisão (2026-11-16)

Em `packages/web-member/lib/dm.js`:

- Rodada 9: as mudanças de uma Página e a cópia própria de uma resposta da Página vão com um grupo sorteado (`randomPrefix`, `sodium.randombytes_buf`, 6 bits). A fila de mudanças guarda itens `{ b, p }`, com `p` sorteado uma vez quando a mudança entra na fila (`pageSend`); `flushCtlQueue` põe com esse `p`, e o carimbo regravado o mantém. A cópia própria da resposta leva o grupo em `prefixes` da entrada, que `deliver` reusa a cada nova tentativa. Um item da fila de antes desta versão (sem `p`) continua sem grupo e não ganha sorteio. As mudanças, cópias próprias e reações próprias continuam no grupo próprio; a mensagem de um membro para uma Página continua no grupo da Página.
- P3-1: quando uma passada chega ao fim do conjunto, as leituras de Página que ficaram abaixo do cursor próprio sobem até ele, então a recuperação não volta a ser pedida.
- P3-2 (só documento) e P3-3: "Limites conhecidos", "Riscos que ficam", o fragmento do changelog e a seção 11 de `docs/protocol.md` agora falam da Página atrasada que espera as mensagens próprias, da adoção como momento que liga o aparelho à Página e da troca da própria `dm-key`.
- Privacidade (`apps/app/src/legal.js`, página do site renderizada de novo) e a linha de `docs/design.md` dizem que essas cópias vão com um número de grupo sorteado e que a lista de quem cuida de cada Página é pública.
- Testes de grupo saíram de `page-dm.test.js` para `packages/web-member/test/page-dm-buckets.test.js`; o que os dois usam foi para `test/helpers/page-dm.js`.

| Arquivo | Testes novos | Resultado | Sem a correção |
|---|---|---|---|
| `packages/web-member/test/page-dm-buckets.test.js` | "drops sealed to a Página box go with a random group drawn per drop..." (substitui o teste "untagged"; 10 sorteios; na quarta rodada passou a 6 mudanças e 5 respostas, com as marcas de cada caminho em listas separadas, ver a quarta rodada) | 16/16 (101 asserções), 2,8 s | sorteio trocado por `null` (comportamento antigo): este e os dois seguintes falham, 10 asserções. Grupo próprio no lugar do sorteio nos dois caminhos ao mesmo tempo: 2 asserções falham ("not one fixed group", "not the holder's own bucket"); só num dos dois caminhos esta versão do teste passava, ver a quarta rodada |
| idem | "a Página drop whose put failed goes out again with the group drawn the first time" | idem | sorteio novo a cada put (na fila e na cópia própria): 2 asserções falham |
| idem | "a second holder files the Página reply copy and the Página ctl a holder put with random groups" | idem | falha com `null` (acima) |
| idem | "a catch-up that reaches the pool end with nothing left brings the Página cursor up to the own one" | idem | sem a subida no fim do conjunto (P3-1): 2 asserções falham |
| idem | "two Páginas, one caught up and one behind: no cursor moves backwards across budget-limited pulls" | idem | sem a guarda `after > p.cursor.after`: falha (o cursor da Página em dia voltava para trás) |
| idem | "a holder whose Página scan fails still asks every bucket" | idem | `asksAll` tirado das leituras de Página: falha |
| idem | "a budget stop in the own pass asks no catch-up on that pull" | idem | sem `!incomplete`: falha (a recuperação era pedida no mesmo pull) |
| idem | "a lock and an unlock while a Página ctl flush opens its link put each ctl once, with its group" (duas mudanças na fila, bloqueio e desbloqueio durante a abertura do link) | idem | checagem do `flushCtlQueue` só com `!unlocked()` (sem a geração), ou tirada: 3 puts em vez de 2 |
| idem | "a lock during the Página catch-up writes nothing for the Página" | idem | passa com qualquer das checagens de bloqueio da passada tirada: o armazenamento da Página recusa sozinho quando bloqueado. Fica como guarda do comportamento |
| idem | "a lock as the Página catch-up reaches the pool end leaves its cursor at the last item it read" | idem | falha (sem `LOCKED`, cursor da Página em 3 em vez de 2) só com as três checagens tiradas juntas: a da geração depois dos itens, a do fim do conjunto e a de `movePageCursor`. Tirando uma ou duas, as outras seguram |

Os testes de grupo movidos sem mudança (6 testes, 45 asserções) passam no arquivo novo como passavam no antigo. `page-dm.test.js` sem eles: 19/19 (213 asserções, as mesmas dos 19 testes de antes), 68 s. `packages/web-member/test/dm.test.js` (a fila de mudanças mudou de formato): 74/74 (751 asserções), 110 s. `apps/app/test/legal.test.js`: 48/49, só o digest fixo falha (esperado).

## Quarta rodada de correções da revisão (2026-11-16)

Sem mudança em `packages/web-member/lib/dm.js` (as mutações abaixo foram feitas no arquivo e desfeitas; `git diff` dele vazio no fim).

- P2-1: o teste do grupo sorteado separa os dois caminhos. As mudanças de Página (6) e as cópias próprias das respostas da Página (5) ficam em listas à parte; em cada lista confere-se mais de um valor, que nem todos são o grupo próprio de quem cuida e que nem todos são o grupo da Página. A carteira tem 20 senhas (`DM_STAMP_WALLET`), então 8 de cada não cabem; com 5 ou 6 sorteios por lista, uma falha falsa é cerca de 64^-4 por asserção.
- Teste novo: uma mudança de Página que ficou na fila antes desta versão (item `{ b }` sem `p`, um sem carimbo e outros já carimbados) sai sem grupo no put que falha e de novo no seguinte; itens com `p` guardado fora de 0..63 (`64`, `'5'`, `-1`) também saem sem grupo, e um `p` guardado válido (5) é mantido.
- P3-1 e P3-2 (só documento): `docs/protocol.md` (onde fica a marca da resposta e da mudança, o que um semeador que junta os envios por endereço aprende, o formato de `dmCtlQueue` com `p`, e dois riscos novos: canal com três ou mais marcas diferentes e semeador alterado numa rede pequena) e "Riscos que ficam" acima.

`packages/web-member/test/page-dm-buckets.test.js`: 17/17 (124 asserções), 2,7 s (antes: 16/16, 101 asserções); mais cinco rodadas seguidas, todas 17/17 e 124/124.

| Teste | Mutação em `dm.js` (feita e desfeita) | Resultado |
|---|---|---|
| grupo sorteado | cópia própria da resposta com o grupo próprio de quem cuida | falha: "Página reply self copy: not one fixed group" e "not always the holder's own bucket" |
| idem | cópia própria da resposta com o grupo da Página | falha: "Página reply self copy: not one fixed group" e "not always the Página's bucket" |
| idem | mudança de Página com o grupo próprio de quem cuida | falha: "Página ctl: not one fixed group" e "not always the holder's own bucket" |
| idem | mudança de Página com o grupo da Página | falha: "Página ctl: not one fixed group" e "not always the Página's bucket" |
| fila de antes da mudança | `ctxPrefix` sorteia um grupo para item sem `p` | falha: "the first put, refused" e a lista de grupos dos itens antigos |
| idem | `readQueue` sorteia um `p` para item sem `p` | falha: as mesmas duas |
| idem | `isPrefix` aceita qualquer valor (`x !== undefined`) | falha: a lista de grupos dos itens antigos |
| idem | `isPrefix` sem o limite `< 64` | falha: a lista de grupos dos itens antigos |

## Limites conhecidos (não corrigidos)

- Depois de uma troca pública de geração de uma Página, quem cuida dela começa a recuperação do pull seguinte em `after: 0`, e quem cuida de outras Páginas não. Um semeador que acompanhe o diário da Página pode ligar esses aparelhos a ela. Já era assim antes dos grupos.
- Uma recuperação a partir de 0 relê o conjunto em vários pulls, um orçamento por pull. As mensagens próprias não esperam por ela, porque a passada própria vem antes em cada pull.
- O contrário vale também: enquanto as mensagens próprias atrasadas ocupam o orçamento, as mensagens novas de uma Página atrasada esperam por elas.
- Adotar uma Página é outro momento que liga o aparelho a ela: o aparelho passa a pedir todos os grupos e faz uma recuperação a partir de `after: 0`, perto da mudança pública do roster.
- Depois de trocar a própria `dm-key`, um aparelho que não cuida de Página muda de grupo, num momento que o diário mostra com data.

- Um aparelho que abre v1 e v2 ao mesmo tempo ganha o dobro de orçamento de páginas e de puts por canal; as senhas de postagem continuam limitando os puts.
- Um byte de cima corrompido no carregamento de um registro vira "sem marca": inofensivo (o envelope é servido a todos).

## Conferência no aparelho (2026-11-16)

Na Vitrine (dados fixos, sem semeador), depois do merge da `main` com os Termos 72: em Ajustes, "Termos e privacidade" mostra "Você aceitou a versão 73" e, na Política, o parágrafo "Envelopes das mensagens diretas" com "por até 14 dias" e o texto dos grupos (a partir de 1.000 contas, grupo de cerca de 500 pessoas, Páginas pedem todos os grupos, grupo sorteado nas cópias da Página, 1/64 das contas). Conferido no Android (emulador, `app.varanda.debug`), depois no simulador iOS (iPhone 17 Pro) e por fim na web. Depois disso a `main` subiu para a versão 73 (`feat/sync-once-notices`) e este PR passou para a 74, sem mudar o parágrafo conferido.

O pedido por grupo no semeador real não aparece na tela: fica coberto pelos testes acima e pela linha do #224 (semeador antes do app).
