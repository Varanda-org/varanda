# Aparelho novo admitido sozinho (branch feat/auto-admit-new-device)

Parte da #350 (item vindo do PR #320: "Numa comunidade com aprovação, os grupos do aparelho novo de um membro comum esperam um administrador").

Decisão do dono (Rodrigo, 16/11/2026): a admissão do membro cobre os aparelhos novos do mesmo diário enquanto ele não sair nem for banido. Nenhum administrador precisa agir por causa de um aparelho novo.

## O que mudou

- `packages/core/lib/group.js` (`foldCore`): um `group-admit` positivo guarda a sua posição causal, e depois do laço principal o fold dá a ele um corte automático (`auto`, separado de `cuts`) para cada escritor do diário que ele não lista e que é da geração atual pelo próprio cabeçalho: num grupo, o diário não tem saída e o escritor não tem `rejoin`, ou o `rejoin` dele nomeia a última saída causal do diário; num grupo de comunidade, além disso o CW dele não está aposentado em C, e só um admit depois da última saída do diário da comunidade conta; numa comunidade, um CW contado e não aposentado. Só admits da geração atual ganham cortes automáticos.
- O corte automático é o seq do primeiro registro do escritor depois do admit na ordem causal, ou o próximo seq dele (o último seq + 1, ou 1 sem registro): o corte que um administrador que listasse esse escritor teria escrito. O que o aparelho escreveu antes da admissão (pendente, ou durante uma retirada) continua escondido; o que escreve depois conta.
- `layerAt` usa o corte automático quando o evento não lista o escritor. Assim todos os lugares que julgam a admissão pela camada de admits passam a usá-lo: posts e reações (`admittedAt`), `requests` (`uncovered`), escritores aposentados sem registro, escritores com direito a chaves (regra 3, com e sem saída) e os `admittedCws` da comunidade. `sawPrefix`, `observedLeaves` e `admitGen` continuam lendo só `cuts`: um corte automático nunca prova que um admit viu uma saída.
- Sem mudança: retirada de admissão (`on: false`) cobre todos os escritores desde o seq 0; banimento cobre todos; desbanimento continua pulando escritores que não lista; cargos de administrador continuam listando os escritores (o aparelho novo de um administrador precisa de um cargo novo). A passada aberta de um grupo privado reaproveita os eventos da passada em texto claro, com os cortes automáticos.
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

- `group.test.js`: "a writer created after the admit is covered by it"; "a new device counts from the admission on: earlier records, withdrawals and re-admits"; "after a leave only a writer whose rejoin names it is covered, by an admit of the new generation"; "a new device during a ban stays banned, also after an unban that does not list it"; e "an approval group hides posts before the admit cut" (o diário deixa de estar em `requests` por causa do escritor antigo não listado).
- `group-private.test.js`: "a new device of an admitted diary is entitled without a new admit"; "a new device of a diary not admitted or banned is never entitled".
- `community-fold.test.js`: "gate: a new CW of an admitted member is admitted, and its group writers count" (grupo aberto e grupo com aprovação da comunidade).
- `device-upkeep-ops.test.js`: "approval community: a plain member's second device writes one CW, then enters its groups without an admin" (o segundo aparelho entra em Geral e Feira, posta, o administrador vê o post sem aceitar nada e nenhum pedido aparece).
- `community-devices.test.js`: "approval community: a second device of an admitted member writes in the community and in Geral".
- `group-ops.test.js` e `group-member-5.test.js` (nó do core): "an admitted member's writer the admit did not list is covered by it, and a new admit lists it".

Continuam passando, sem mudança: "a member back in the community enters G only on a new writer an admit lists" (`group-private.test.js`) e "property: a group under its community folds the same for every delivery order" (`community-fold.test.js`): sair da comunidade encerra a admissão nos grupos dela.

Na raiz, na ordem da CI, `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo` têm de passar.

## Regressão

Com os testes no lugar e só `packages/core/lib/group.js` revertido, falharam: em `group.test.js` os quatro testes novos e o ajustado (140/144); em `group-private.test.js` "a new device of an admitted diary is entitled without a new admit" (112/113); em `community-fold.test.js` o teste novo do portão (98/99); em `community-devices.test.js` o teste do segundo aparelho (9/10); e em `device-upkeep-ops.test.js` o teste da comunidade com aprovação (o plano não inclui os grupos, e o post do segundo aparelho é recusado com `sem permissão no grupo`). Com a correção de volta, todos passam: 144/144, 113/113, 99/99, 10/10, 23/23, e `group-ops.test.js` 57/57.

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Registrar aparelho, sistema e, na web, o navegador. O que exige conta se confere com o APK de preview do EAS.

- [ ] Comunidade com aprovação: a pessoa admitida entra com a mesma passkey num segundo aparelho; depois da sincronização, o segundo aparelho entra na comunidade e, numa sincronização seguinte, nos grupos, sem ninguém aceitar nada em Pedidos. Pendente.
- [ ] Do segundo aparelho, um post num grupo da comunidade aparece para as outras pessoas, sem "mensagem escondida". Pendente.
- [ ] Em Pedidos, da comunidade e do grupo, o pedido dessa pessoa não reaparece por causa do aparelho novo. Pendente.
- [ ] Grupo privado da comunidade: o segundo aparelho lê as mensagens novas depois da rotação de chave, sem novo aceite. Pendente.

## Não verificado / limites conhecidos

- Desbanimento: um aparelho criado durante ou depois de um banimento continua banido até um desbanimento que o liste (o desbanimento segue pulando escritores não listados). Fica fixado no teste "a new device during a ban stays banned, also after an unban that does not list it".
- O aparelho novo de um administrador ainda precisa de um cargo novo para ter autoridade: a camada de cargos não mudou. Ele entra como membro pela admissão, se a conta foi admitida antes; uma conta que só tem cargo, sem admissão, não ganha cobertura automática.
- Registros que o aparelho escreveu antes da admissão continuam escondidos; um escritor de antes de uma saída nunca volta por uma nova admissão. Nesses casos a conta continua em Pedidos, e uma nova admissão (que lista todos os escritores) resolve.
- Sair da comunidade encerra a admissão nos grupos dela: depois de voltar, o aparelho novo precisa de uma nova admissão no grupo.
- Na web, numa comunidade com aprovação, os grupos do segundo aparelho entram uma passada de manutenção depois do CW, não na mesma.
- Não conferido em aparelho.
