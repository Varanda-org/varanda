# fix/group-cap-opening-writer

Correção no limite de escritores por (grupo, diário) do nó do core (`MAX_GROUP_HELD_PER_DIARY` = 32).

## Causa

`capHolders` conta como ocupante da vaga um escritor que passou pelo portão e ainda está abrindo (`gating` com `slot`), mas o laço de despejo só dava número de entrada aos escritores `active` e `held`. Esse escritor nunca era o escolhido para sair: com a vaga cheia e uma entrada mais antiga chegando, saía o escritor anterior de entrada mais recente, e o último a entrar terminava de abrir, ficava ativo e guardava os blocos. O código vem de 4f9c552b (grupos públicos). O caso 8 de `packages/core/test/sync-groups-2.test.js` ("a writer stored in an earlier run gives its slot to an earlier proven join listed later") cai nessa janela quando a máquina está carregada, e falhava na `main` (runs 44083587230, 44215612833, 44224107502 e 44235381694).

## O que mudou

- `packages/core/lib/sync.js`: o laço de despejo usa o número de entrada provado de um escritor ainda abrindo (o portão já o provou antes de dar a vaga). Se ele é o de entrada mais recente, perde a vaga na hora (`yields`, fora de `capHolders` e de `diskSlots`, marcado como provado depois) e, quando as aberturas em andamento terminam, falha como `quota`, com os blocos apagados, como um ativo despejado. Apagar só depois das aberturas evita disputar com elas. Se ele sai por outro caminho nesse meio tempo (abertura que falha, bloqueio ou bifurcação que chega durante a abertura, diário que não fica, fim da execução, caixa que não confere), os blocos também são apagados, inclusive os de um esboço de cabeçalho guardado antes da execução, e uma abertura que falha registra a limpeza para que outro portão da mesma chave espere por ela. Antes da comparação, o número de entrada dele desce para a entrada mais antiga provada, como o de um ativo.
- `docs/protocol.md` ("Bounds on hints"): o escritor que ainda está abrindo também cede.

## Teste (`packages/core/test/sync-groups-2.test.js`)

- `a writer still opening on the last slot gives it to an earlier proven join, not the next latest holder`: um `openHook` segura o último escritor no meio da abertura, com a vaga 32 dele, e lista nesse momento o escritor de entrada mais antiga. Confere que o mais antigo baixa, que o último é recusado por `quota` e nunca baixa, que o anterior a ele continua guardado e que ficam 32.

## Falha sem a correção

Sem a correção em `sync.js`, o teste novo falha (27/28 testes; as asserções 4 a 7 dele falham: o último escritor baixa e fica guardado, o anterior sai). Com a correção, passa (28/28 testes, 104 asserções).

## Comandos

```sh
npx standard packages/core/lib/sync.js packages/core/test/sync-groups-2.test.js
node packages/core/test/sync-groups-2.test.js
```

A suíte inteira roda no GitHub CI (Node 20 e 24).
