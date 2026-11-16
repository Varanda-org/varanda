# Aparelho novo admitido sozinho (branch feat/auto-admit-new-device)

Parte da #350 (item vindo do PR #320: "Numa comunidade com aprovação, os grupos do aparelho novo de um membro comum esperam um administrador").

Decisão do dono (Rodrigo, 16/11/2026): a admissão do membro cobre os aparelhos novos do mesmo diário enquanto ele não sair nem for banido. Nenhum administrador precisa agir por causa de um aparelho novo.

## O que mudou

- `packages/core/lib/group.js` (`foldCore`): um `group-admit` positivo guarda a sua posição causal, e depois do laço principal o fold dá a ele um corte automático (`auto`, separado de `cuts`) para cada escritor do diário que ele não lista e que é da geração do próprio admit. Cada admit é julgado na sua geração (`admitGen`, as saídas que os cortes dele observaram), nunca na geração atual do diário. A geração do escritor vem do cabeçalho e da saída que ele nomeia (`writerGen`): 0 sem `rejoin`; com um `rejoin` que nomeia uma saída L do diário, as saídas que os cortes da própria L observaram, contando L; um `rejoin` que não nomeia saída do diário não ganha cobertura. Um admit cujo corte passa de uma saída que fica depois dele na ordem (`sawPrefix` maior que a geração dele) não cobre ninguém que não lista. Num grupo de comunidade, além disso o CW do escritor não está aposentado em C, e o admit só conta se os seus cortes listarem um escritor de G do mesmo diário ligado a um CW da mesma geração de cabeçalho em C que o CW do escritor (`genOfC`, exportado pelo fold da comunidade); numa comunidade, um CW contado e não aposentado, da geração de cabeçalho igual à do admit. Tudo isso lê só cabeçalhos, os cortes das saídas e os cortes do admit, nunca posições na ordem de G nem datas: depois de sair de C e voltar, o CW novo é de uma geração posterior à de todo CW que um admit anterior lista, sejam quais forem as datas. Um admit anterior nunca cobre um escritor de uma geração posterior (o aparelho novo depois de uma volta espera um admit da geração nova), e um admit posterior nunca cobre um aparelho de antes de uma saída. Uma saída posterior encerra a cobertura dali em diante exatamente como a de um escritor listado (a retirada pela saída, e um registro depois da saída só conta admits da geração dele ou posteriores): os posts e marcas de tópico de antes da saída continuam visíveis depois que o diário sai, como os de um escritor listado.
- O corte automático é o seq do primeiro registro do escritor depois do admit na ordem causal, ou o próximo seq dele (o seq do último registro guardado + 1, ou 1 sem registro): o corte que um administrador que listasse esse escritor teria escrito. Os posts que o aparelho escreveu antes da admissão (pendente, ou durante uma retirada) continuam escondidos; o que escreve depois conta.
- Registros laterais (reações, votos, marcas de tópico, enquete e evento) não entram na ordem causal, então o corte automático não vale para eles: de um escritor coberto automaticamente, contam a partir do seq 1, como com um admit que o listasse com corte 1 (`layerAt` com `side`). Todas as outras condições continuam valendo: o diário membro agora (reações e votos), banimento, retirada posterior, as regras de saída, a geração do escritor e, num grupo de comunidade, a geração do CW e o CW aposentado. Um aparelho novo que só reage tem as reações contadas, e um post depois não muda isso.
- `layerAt` usa o corte automático quando o evento não lista o escritor. Assim todos os lugares que julgam a admissão pela camada de admits passam a usá-lo: posts e reações (`admittedAt`), `requests` (`uncovered`), escritores aposentados sem registro, escritores com direito a chaves (regra 3, com e sem saída) e os `admittedCws` da comunidade. `sawPrefix`, `observedLeaves` e `admitGen` continuam lendo só `cuts`: um corte automático nunca prova que um admit viu uma saída.
- Sem mudança: retirada de admissão (`on: false`) cobre todos os escritores desde o seq 0; banimento cobre todos; desbanimento continua pulando escritores que não lista; cargos de administrador continuam listando os escritores (o aparelho novo de um administrador precisa de um cargo novo, e um administrador que só tem cargo, sem admit, não ganha cobertura automática para um aparelho ou CW novo). A passada aberta de um grupo privado reaproveita os eventos da passada em texto claro, com os cortes automáticos.
- Nós: um admit `on: true` continua listando todos os escritores contados que o nó tem. Na web, o plano de manutenção do aparelho (`deviceUpkeepPlan`) não mudou: numa comunidade com aprovação, o CW novo é escrito numa passada e os grupos entram na passada seguinte (`community-first` é transitório), quando o fold já mostra o CW admitido. Só o comentário de `parentAdmits` mudou.
- `rejoin` do aparelho novo: os dois nós (core `foldRejoin` e web `latestLeaveOf`) escrevem no cabeçalho do escritor novo de um grupo a última saída causal do diário quando ela existe, então o aparelho novo depois de uma volta é da geração atual.
- Documentos: `docs/protocol.md` seção 10 ("Admits list their writers", "Entitled writers" regra 3 e o texto de escritor pendente, "Only admitted community writers count", inscrição automática de aparelho) e `docs/rpc.md` (`group.requests`, inscrição automática em 5.63).

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node packages/core/test/group.test.js
node packages/core/test/group-private.test.js
node packages/core/test/community-fold.test.js
node packages/web-member/test/device-upkeep-ops.test.js
node packages/web-member/test/community-devices.test.js
node packages/web-member/test/group-ops.test.js
node packages/core/test/group-member-5.test.js
```

Testes desta mudança:

- `group.test.js`: "a device the admit covers keeps its records from before a leave, as a listed one; a rejoin needs a new admit" (saindo pelo escritor listado ou pelo coberto, o que saiu mantém o post e a marca de tópico de antes da saída, e as reações somem nos dois casos porque exigem um membro agora; depois da volta, o admit antigo não cobre o aparelho novo, e um admit da geração nova cobre os dois aparelhos novos sem tirar o post antigo); "a new device that only reacts has its reactions counted, also once it posts, until the diary leaves" (registros laterais a partir do seq 1, e nada depois que o diário sai); "a writer created after the admit is covered by it"; "a new device counts from the admission on: earlier records, withdrawals and re-admits"; "after a leave only a writer whose rejoin names it is covered, by an admit of the new generation"; "a new device during a ban stays banned, also after an unban that does not list it"; e "an approval group hides posts before the admit cut" (o diário deixa de estar em `requests` por causa do escritor antigo não listado).
- `group-private.test.js`: "a new device of an admitted diary is entitled without a new admit"; "a covered device that leaves keeps its earlier posts and is not entitled; the next generation needs a new admit" (o mesmo num grupo privado: o post selado de antes da saída continua, o aparelho que saiu não recebe chaves, o aparelho da geração nova só com um admit dela; e um admit cujo corte passa de uma saída posterior a ele não dá chaves a um aparelho antigo depois da volta); "a new device of a diary not admitted or banned is never entitled"; "after leaving C, a G admission entitles only writers of the CW generation it lists, whatever the dates" (a geração do CW, com a saída de C datada antes dos admits, e um escritor num CW aposentado).
- `community-fold.test.js`: "gate: a new CW of an admitted member is admitted, and its group writers count" (grupo aberto e grupo com aprovação da comunidade); "gate: after leaving C, a G admission covers only writers of the CW generation it lists, whatever the dates" (o mesmo num grupo público; um escritor num CW aposentado continua sem cobertura e em `requests`; a reação de um aparelho do CW novo que só reage conta, e a de um escritor no CW aposentado não).
- `device-upkeep-ops.test.js`: "approval community: a plain member's second device writes one CW, then enters its groups without an admin" (o segundo aparelho entra em Geral e Feira, posta, o administrador vê o post sem aceitar nada e nenhum pedido aparece).
- `community-devices.test.js`: "approval community: a second device of an admitted member writes in the community and in Geral".
- `group-ops.test.js` e `group-member-5.test.js` (nó do core): "an admitted member's writer the admit did not list is covered by it, and a new admit lists it".

Continuam passando, sem mudança: "a member back in the community enters G only on a new writer an admit lists" (`group-private.test.js`) e "property: a group under its community folds the same for every delivery order" (`community-fold.test.js`): sair da comunidade encerra a admissão nos grupos dela.

Na raiz, na ordem da CI, `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo` têm de passar.

## Regressão

Com os testes no lugar e só `packages/core/lib/group.js` revertido, falharam: em `group.test.js` os quatro testes novos e o ajustado (140/144); em `group-private.test.js` "a new device of an admitted diary is entitled without a new admit" (112/113); em `community-fold.test.js` o teste novo do portão (98/99); em `community-devices.test.js` o teste do segundo aparelho (9/10); e em `device-upkeep-ops.test.js` o teste da comunidade com aprovação (o plano não inclui os grupos, e o post do segundo aparelho é recusado com `sem permissão no grupo`). Com a correção de volta, todos passam: 144/144, 113/113, 99/99, 10/10, 23/23, e `group-ops.test.js` 57/57.

Segunda rodada (teste da geração do CW): com o `group.js` do primeiro commit (que comparava posições na ordem de G), falham os testes da geração do CW em `group-private.test.js` e em `community-fold.test.js` (113/114 e 99/100). Sem só o ramo do CW aposentado em `autoEligible`, falham as asserções de `requests` desses dois testes (o escritor no CW aposentado ganharia cobertura automática e sairia de `requests`).

Terceira rodada (registros laterais a partir do seq 1): com o `group.js` do segundo commit (que julgava os registros laterais pelo corte automático), falham o teste das reações em `group.test.js` (144/145: as reações de um aparelho que só reage não contam, nem depois de ele postar) e o teste da geração do CW em `community-fold.test.js` (99/100: a reação do aparelho do CW novo). Com a correção, 145/145, 114/114 e 100/100.

Quarta rodada (cada admit na sua geração): com o `group.js` do terceiro commit (que só cobria escritores da geração atual do diário), falham os dois testes novos: em `group.test.js` (145/146) o post, a marca de tópico do aparelho coberto que saiu e o post dele depois da volta; em `group-private.test.js` (114/115) o post selado de antes da saída. Sem só a verificação de `sawPrefix`, falha a última asserção do teste novo de `group-private.test.js` (o aparelho antigo receberia chaves depois da volta). Com a correção, 146/146 e 115/115.

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Registrar aparelho, sistema e, na web, o navegador. O que exige conta se confere com o APK de preview do EAS.

- [ ] Comunidade com aprovação: a pessoa admitida entra com a mesma passkey num segundo aparelho; depois da sincronização, o segundo aparelho entra na comunidade e, numa sincronização seguinte, nos grupos, sem ninguém aceitar nada em Pedidos. Pendente.
- [ ] Do segundo aparelho, um post num grupo da comunidade aparece para as outras pessoas, sem "mensagem escondida". Pendente.
- [ ] Em Pedidos, da comunidade e do grupo, o pedido dessa pessoa não reaparece por causa do aparelho novo. Pendente.
- [ ] Grupo privado da comunidade: o segundo aparelho lê as mensagens novas depois da rotação de chave, sem novo aceite. Pendente.

## Não verificado / limites conhecidos

- Desbanimento: um aparelho criado durante ou depois de um banimento continua banido até um desbanimento que o liste (o desbanimento segue pulando escritores não listados). Fica fixado no teste "a new device during a ban stays banned, also after an unban that does not list it".
- O aparelho novo de um administrador ainda precisa de um cargo novo para ter autoridade: a camada de cargos não mudou. Ele entra como membro pela admissão, se a conta foi admitida antes; uma conta que só tem cargo, sem admissão, não ganha cobertura automática (numa comunidade com aprovação, o CW novo de quem só tem cargo raiz, sem admit, espera um cargo novo ou um admit).
- Registros que o aparelho escreveu antes da admissão continuam escondidos; um escritor de antes de uma saída nunca volta por uma nova admissão. Nesses casos a conta continua em Pedidos, e uma nova admissão (que lista todos os escritores) resolve.
- Sair da comunidade encerra a admissão nos grupos dela: depois de voltar, o aparelho novo precisa de uma nova admissão no grupo que liste um escritor do CW novo; a partir dela, os aparelhos seguintes do mesmo CW (ou de outro CW da mesma geração) entram sozinhos. Um admit que não lista nenhum escritor de G do diário naquela geração de CW não cobre ninguém dela automaticamente.
- Registros laterais de um aparelho novo coberto automaticamente contam desde o seq 1, também os escritos antes da admissão (como com um admit que o listasse com corte 1); só os posts seguem o corte automático.
- Depois que o diário sai, as reações e votos de qualquer aparelho, listado ou coberto, deixam de contar (exigem um membro agora); posts e marcas de tópico de antes da saída continuam.
- Ao sair da comunidade, o aparelho coberto automaticamente cujo CW foi aposentado continua sem cobertura (regra do CW aposentado mantida), então os posts dele de antes da saída de C deixam de contar, ao contrário dos de um escritor listado nesse CW (conferido com um teste temporário, já removido). A saída de C não tem ligação causal com a ordem de G, então nada separa um aparelho desse CW criado antes da saída de um criado depois dela; sem a regra, um aparelho antigo poderia criar escritores novos nesse CW e datar a saída para depois dos posts deles.
- Na web, numa comunidade com aprovação, os grupos do segundo aparelho entram uma passada de manutenção depois do CW, não na mesma.
- Não conferido em aparelho.
