# feat/core-conversas-pessoais

Parte de #352 (PR 6): Conversas pessoais enviadas do nó core, só texto. Sobre o PR 5 (feat/core-conversas-pagina), que já inclui o #774 (leitores dos inners v9 e v10).

## Ordem de implantação

Este PR só entra depois que o #774 sair numa versão hospedada da web e numa versão do app. Os leitores vêm antes: um app antigo descarta em silêncio uma mensagem de um membro core (inner v9 ou v10), sem erro para ninguém.

Sem mudança nos Termos: a frase do PR 5 (Termos e Privacidade 88) já cobre as chaves das Conversas do próprio nó guardadas num arquivo naquele aparelho.

## O que mudou

- `packages/web-member/lib/dm.js`: opção `innerDiary` do motor. Com ela, os `dm.buildInner` de mensagem, reação e `ctl` recebem `{ diary }` e saem como v9 e v10. Sem ela, nada muda: o navegador escreve v1, v2 e v4 como antes, byte a byte. Uma recusa de `innerDiary` chega ao cliente como ela mesma, nunca como `mensagem inválida`. `dm.set` monta e sela o `ctl` antes de guardá-lo: se a montagem falha, nada é guardado nem posto na fila.
- `packages/web-member/lib/core-dm.js`: `dm.send`, `dm.react` e `dm.set` com o par do assinante do diário. `innerDiary` lê o diário do assinante e recusa (`Conversas ainda não ativadas neste aparelho`) se ele foi zerado no meio, nunca cai para as versões do navegador. Mídia e cartão (`mídia disponível só na versão web`) e `moment` (`reação a momento disponível só na versão web`) são recusados antes de desbloquear, buscar a chave, assinar ou gastar selo. `dm.set` com `page` responde `use dm.pageDraft`. Uma reação a uma Página guardada aqui é recusada antes de assinar, como no navegador. Sem visitas e sem cópia de histórico: um nó core é um aparelho só.
- `packages/core/lib/session.js`: `dm.send`, `dm.react` e `dm.set` entram em `DM_CORE_METHODS`. `dm.reportSign`, `group.seal` e `group.read` com `page` continuam recusados (PR 7). Sem a fábrica, toda recusa fica igual.
- Docs: `docs/rpc.md` (introdução das Conversas, 5.75, 5.79, 5.119), `docs/protocol.md` (seção 11, "Multi-device").

## Regressão

Antes da mudança (o `session.js` do commit 4ffc92ff, com a fábrica):

```
dm.send -> USAGE "mensagens diretas disponíveis só no navegador"
dm.react -> USAGE "mensagens diretas disponíveis só no navegador"
dm.set -> USAGE "mensagens diretas disponíveis só no navegador"
```

Depois, o mesmo script (sem semente de Conversas) chega ao motor:

```
dm.send -> USAGE "Conversas ainda não ativadas neste aparelho"
dm.react -> USAGE "Conversas ainda não ativadas neste aparelho"
dm.set -> USAGE "Conversas ainda não ativadas neste aparelho"
```

O teste `a throwing innerDiary reaches the client as itself` (`packages/web-member/test/dm.test.js`) falha sem cada correção do motor. Com o `innerDiary()` de volta dentro do `try` do envio: `not ok 2 - not mensagem inválida` (`actual: mensagem inválida`). Com o `ctl` guardado antes da montagem: `not ok 9 - nothing filed` e `not ok 10 - the conversation is still there` (`actual: 0`), porque o `deleted` guardado apagou a conversa.

## Tamanho

Só texto, com certificado v2 (emitido), o inner v9 cabe com o texto mais longo (1000 caracteres de 4 bytes, 4000 bytes; orçamento 4006). Uma resposta com o texto mais longo não cabe (orçamento 3976 com id solto, 3819 com resposta ligada) e é recusada como `mensagem longa demais` antes de qualquer selo, como já acontece no navegador com uma resposta ligada v2 e certificado v2 (orçamento 3895).

## Testes

Cada arquivo rodou sozinho (`node <arquivo>`, Node 24.22.1):

- `packages/web-member/test/core-dm-personal-e2e.test.js` (novo): 4/4, 54 asserções, 81,5 s (limite do arquivo 150 s, abaixo dos 180 s da CI). Sessão core com a fábrica, semeador local (DHT presa a 127.0.0.1), dois nós do navegador. Core para navegador e navegador para core, resposta ligada, reação nos dois sentidos, o texto mais longo, a resposta longa demais sem gastar selo (carteira exatamente igual), mídia, cartão e momento recusados com a carteira igual e nada assinado. Um `dm.set` (`accepted`) num pedido de um terceiro; depois, com `<dataDir>/private/dm` apagado e a sessão reaberta, o `dm.pull` traz de volta as cópias próprias (mensagens v9 como `mine`, a reação v10) e o `ctl` v9, que mantém a conversa na caixa de entrada. O motor do navegador continua escrevendo v2 (resposta ligada), v4 (reação) e v1 (texto), sem `diary`. Um nó core com a semente e sem `dm-key` registrada (um `dm.enable` interrompido): o primeiro `dm.send` publica a `dm-key` uma vez só, e a mensagem chega; sem semente, o envio é recusado com `Conversas ainda não ativadas neste aparelho`. Uma sessão sem a fábrica recusa `dm.send`, `dm.react` e `dm.set` como antes.
- `packages/web-member/test/core-dm-e2e.test.js`: 9/9, 70 asserções, 50,3 s. As duas recusas antigas viraram uma asserção de `dm.set` com `page`, e entrou a de `dm.react` a uma Página. As linhas de `dm.send`, `dm.react` e `dm.set` com a fábrica passam a chegar ao motor (semente corrompida: `arquivo das Conversas corrompido neste aparelho`); `dm.set` com `page` responde `use dm.pageDraft`. O nó core, como membro, reage a uma mensagem da Página que guarda: `conversas com uma Página não têm reações` (a checagem por `ops.pageRead`).
- `packages/core/test/dm-session-refuse.test.js`: 2/2, 54 asserções, sem mudança (sessão sem a fábrica).
- `packages/core/test/dm.test.js`: 78/78, 1715 asserções.
- `packages/web-member/test/dm.test.js`: 85/85, 833 asserções, com o teste novo de `innerDiary` que falha (envio, reação e `dm.set` sem selo gasto, sem envio e sem nada guardado).
- `npx standard` nos arquivos tocados.
