# fix/group-cap-opening-writer

Correção no limite de escritores por (grupo, diário) do nó do core (`MAX_GROUP_HELD_PER_DIARY` = 32). O caso 8 de `packages/core/test/sync-groups-2.test.js` ("a writer stored in an earlier run gives its slot to an earlier proven join listed later") falhava de vez em quando na `main`, de dois jeitos:

- asserções 4 e 6 (o último a entrar não cede e continua guardado): runs 44083587230, 44215612833, 44224107502 e 44234837809 (#786);
- asserção 7 (30 guardados em vez de 32): run 44235381694 (b60a5204), e de novo no #796 depois da primeira correção.

## Causas

Quatro caminhos levavam o limite a despejar outro escritor no lugar do último a entrar, ou a passar de 32.

1. `capHolders` conta como ocupante da vaga um escritor que passou pelo portão e ainda está abrindo (`gating` com `slot`), mas o laço de despejo só dava número de entrada aos escritores `active` e `held`. Esse escritor nunca era o escolhido: saía o anterior de entrada mais recente, e o último a entrar terminava de abrir e guardava os blocos. O código vem de 4f9c552b (grupos públicos).
2. A leitura das entradas do diário (`diaryJoins`) guarda o que já leu por diário e núcleo. Dois portões que liam o mesmo núcleo ao mesmo tempo se atropelavam: o que ficava para trás parava (`if (st.length !== seq) break`) e devolvia só as entradas lidas até ali, e o limite tomava os ocupantes além delas como não provados.
3. A leitura das entradas para no primeiro bloco que falta no diário de ligação (`presentLength`). Na segunda execução do caso 8, a réplica guardada desse diário pode estar sem os últimos blocos, porque a primeira execução terminou antes de baixá-los. O mais antigo decidia com as entradas até ali, o último a entrar contava como não provado e saía outro, de entrada anterior. Com registro temporário, o portão do mais antigo decidiu com 31 ou 32 das 33 entradas, e 10 de 24 processos falharam, sempre no primeiro teste do processo (o mais lento).
4. Um escritor ativo despejado mantinha a vaga no disco (`diskSlots`) até a limpeza dos blocos terminar e contava de novo como ocupante: um segundo portão via 33 ocupantes, escolhia o que já estava saindo e tomava a vaga sem despejar ninguém, deixando 33 guardados. A revisão do Fable achou e reproduziu esse caminho.

## O que mudou

- `packages/core/lib/sync.js`, causa 1: o laço de despejo usa o número de entrada provado de um escritor ainda abrindo (o portão já o provou antes de dar a vaga). Se ele é o de entrada mais recente, perde a vaga na hora (`yields`, fora de `capHolders` e de `diskSlots`, marcado como provado depois) e, quando as aberturas em andamento terminam, falha como `quota`, com os blocos apagados, como um ativo despejado. Apagar só depois das aberturas evita disputar com elas. Se ele sai por outro caminho nesse meio tempo (abertura que falha, bloqueio ou bifurcação que chega durante a abertura, diário que não fica, fim da execução, caixa que não confere), os blocos também são apagados, inclusive os de um esboço de cabeçalho guardado antes da execução, e uma abertura que falha registra a limpeza para que outro portão da mesma chave espere por ela. Antes da comparação, o número de entrada dele desce para a entrada mais antiga provada, como o de um ativo.
- Causa 2: as leituras das entradas de um diário revezam (uma fila por entrada do cache), cada uma a partir de onde a anterior parou, e todo portão recebe a lista completa. Novo gancho só de teste, `joinsHook(key, seq)`, chamado antes de cada bloco lido.
- Causa 3: antes de comparar, o portão que encontra (grupo, diário) cheio espera, até o prazo do próprio portão, pelos blocos do diário de ligação que ainda faltam abaixo do comprimento (`awaitJoins`), e lê as entradas de novo. Só espera quando a vaga está cheia, e um bloco que não chega no prazo deixa a decisão como antes.
- Causa 4: o despejo de um ativo tira a vaga dele no disco na hora (`dropSlotOf`), como já fazia o de um escritor ainda abrindo.
- `docs/protocol.md` ("Bounds on hints"): o escritor que ainda está abrindo também cede, o despejado tem os blocos apagados tenha sido guardado nesta execução ou antes, o portão lê as entradas até o comprimento do diário esperando pelos blocos que faltam, as leituras revezam, e a vaga do despejado sai na hora.

## Testes (`packages/core/test/sync-groups-2.test.js`)

- `a writer still opening on the last slot gives it to an earlier proven join, not the next latest holder` (causa 1): um `openHook` segura o último escritor no meio da abertura, com a vaga 32 dele, e lista nesse momento o escritor de entrada mais antiga. Confere que o mais antigo baixa, que o último é recusado por `quota` e nunca baixa, que o anterior a ele continua guardado e que ficam 32.
- `a gate whose join read another gate overtook still sees every join before the cap evicts` (causa 2): o diário que liga os escritores é seguido, então os portões leem o mesmo núcleo. Na segunda execução só o mais antigo e o último estão listados; o `joinsHook` para a leitura do mais antigo no primeiro bloco até a do último passar três blocos à frente. Confere que o último cede e é apagado, que o segundo mais antigo continua guardado e que ficam 32.
- `a gate about to evict waits for the joins its stored binding diary still lacks` (causa 3): os 32 escritores mais recentes ficam guardados antes da execução com uma réplica do diário de ligação só com o bloco 0 e a entrada mais antiga, e só o mais antigo é listado. Confere que ele é admitido, que o último cede e é apagado, que o penúltimo continua guardado e que ficam 32.
- `an evicted active holder still purging no longer holds its slot on disk` (causa 4): o último escritor ativo é despejado pelo mais antigo, um `purgeHook` segura a limpeza dele e o segundo mais antigo é listado nesse momento. Confere que o segundo mais antigo é admitido, que o penúltimo cede e que ficam 32.

## Falha sem a correção

- Causa 1: sem a correção, o primeiro teste novo falha (asserções 4 a 7: o último escritor baixa e fica guardado, o anterior sai).
- Causa 2: sem a fila (com a leitura e o `break` antigos, mantido o gancho), o segundo teste novo falha nas duas execuções (4/7 asserções: o último não cede, o segundo mais antigo sai).
- Causa 3: sem a espera, o terceiro teste novo falha nas duas execuções (3/5 asserções: nenhum ocupante tem entrada provada e o mais antigo é recusado).
- Causa 4: sem o `dropSlotOf`, o quarto teste novo falha nas duas execuções (2/5 asserções: o penúltimo não cede e ficam 33), e o caso 8 falhou numa delas.
- Com as quatro correções: o arquivo passa (31/31 testes, 122 asserções), e o caso 8 repetido 144 vezes em 24 processos (12 em paralelo de cada vez) passou em todas. Com só as causas 1 e 2 corrigidas, a mesma carga deu 10 falhas em 144; antes delas, 4 em 72.

## Comandos

```sh
npx standard packages/core/lib/sync.js packages/core/test/sync-groups-2.test.js
node packages/core/test/sync-groups-2.test.js
```

A suíte inteira roda no GitHub CI (Node 20 e 24).
