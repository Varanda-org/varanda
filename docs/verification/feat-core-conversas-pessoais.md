# feat/core-conversas-pessoais

Parte de #352 (PR 6): Conversas pessoais enviadas do nó core, só texto. Sobre o PR 5 (feat/core-conversas-pagina), que já inclui o #774 (leitores dos inners v9 e v10).

## Ordem de implantação

Este PR só entra depois que o #774 sair numa versão hospedada da web e numa versão do app. Os leitores vêm antes: um app antigo descarta em silêncio uma mensagem de um membro core (inner v9 ou v10), sem erro para ninguém.

Sem mudança nos Termos: a frase do PR 5 (Termos e Privacidade 88) já cobre as chaves das Conversas do próprio nó guardadas num arquivo naquele aparelho.

## O que mudou

- `packages/web-member/lib/dm.js`: opção `innerDiary` do motor. Com ela, os `dm.buildInner` de mensagem, reação e `ctl` recebem `{ diary }` e saem como v9 e v10. Sem ela, nada muda: o navegador escreve v1, v2 e v4 como antes, byte a byte. Uma recusa de `innerDiary` chega ao cliente como ela mesma, nunca como `mensagem inválida`. `dm.set` monta e sela o `ctl` antes de guardá-lo: se a montagem falha, nada é guardado nem posto na fila.
- `packages/web-member/lib/core-dm.js`: `dm.send`, `dm.react` e `dm.set` com o par do assinante do diário. `innerDiary` lê o diário do assinante e recusa (`Conversas ainda não ativadas neste aparelho`) se ele foi zerado no meio, nunca cai para as versões do navegador. Mídia e cartão (`mídia disponível só na versão web`) e `moment` (`reação a momento disponível só na versão web`) são recusados antes de desbloquear, buscar a chave, assinar ou gastar selo. `dm.set` com `page` responde `use dm.pageDraft`. Uma reação a uma Página segue o caminho pessoal, como no navegador desde o #786 (sem consulta à Página guardada). Sem visitas e sem cópia de histórico: um nó core é um aparelho só.
- `packages/core/lib/session.js`: `dm.send`, `dm.react` e `dm.set` entram em `DM_CORE_METHODS`. `dm.reportSign` continua recusado. `group.seal` e `group.read` com `page` dobram o grupo como a Página desde o #793. Sem a fábrica, toda recusa fica igual.
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
- `packages/web-member/test/core-dm-e2e.test.js`: 11/11, 77 asserções, 44,9 s (depois de receber a `main` com o #786 e o #793). As duas recusas antigas viraram uma asserção de `dm.set` com `page`, e entrou a de `dm.react` a uma Página. As linhas de `dm.send`, `dm.react` e `dm.set` com a fábrica passam a chegar ao motor (semente corrompida: `arquivo das Conversas corrompido neste aparelho`); `dm.set` com `page` responde `use dm.pageDraft`. Desde o #786 uma reação a uma Página segue o caminho pessoal, como no navegador: o nó core, como membro, reage à resposta que a Página mandou para outra pessoa e recebe `mensagem não encontrada`, porque ela não está na conversa dele com a Página. A reação v10 de um nó core chega à loja da Página pelo mesmo `openInner` da v4 (`validReaction` aceita as duas).
- `packages/web-member/test/core-dm-e2e.test.js`, depois do teste novo `a core member writes to a Página and reacts to its reply; the Página files both (v9, v10)`: 12/12, 81 asserções, cerca de 82 s (o teste novo, cerca de 29 s; limite da CI por arquivo 180 s). Um membro core, que não é delegado, escreve à Página (v9) e a dona, num nó do navegador, lê a mensagem em `dm.thread` com `page`; a Página responde por `dm.pageDraft` e `dm.pageSend`, o nó core reage à resposta (v10) e a loja da Página arquiva a reação (`mine: false`). Com `body.v === 10` acrescentado ao `return null` que segue o `openInner` em `openPageItem` (`packages/web-member/lib/dm.js`), ou seja, com a loja da Página descartando a v10, o teste falha em `v10 filed by the Página` (tempo esgotado), depois de a parte v9 passar. Sem o `b.v === 10` de `validInner` (`packages/core/lib/dm.js`), ele falha antes, no envio: `dm.react` do nó core responde `mensagem inválida`.
- `packages/core/test/dm-session-refuse.test.js`: 2/2, 54 asserções, sem mudança (sessão sem a fábrica).
- `packages/core/test/dm.test.js`: 78/78, 1715 asserções.
- `packages/web-member/test/dm.test.js`: 85/85, 833 asserções, com o teste novo de `innerDiary` que falha (envio, reação e `dm.set` sem selo gasto, sem envio e sem nada guardado).
- `npx standard` nos arquivos tocados.

## No aparelho

Simulador iOS (iPhone 17), build de debug desta branch, com o laboratório hospedado (`apps/cli/scripts/hosted-lab.js`, DHT local presa a 127.0.0.1) e o Metro com `EXPO_PUBLIC_VARANDA_INSTALLATION=http://localhost:8080`. O app entrou no modo core por Conexão, Avançado (associação e bootstrap do laboratório), com o certificado de `varanda assoc certify` colado em "Liberar sua conta", e seguiu pela Busca um membro do laboratório num nó do navegador (o motor de `packages/web-member`, por script).

No modo core o app não tem tela que abra uma conversa pessoal: a aba Conversas, o botão de mensagem do perfil, o "Conversar" de uma Página (`canConverseWithPage`) e a Feira pedem `node.hosted`. Por isso as chamadas saíram do próprio cliente do app (`currentClient()` de `apps/app/src/client/native.js`), pelo inspetor do Metro, até o worklet:

- antes de ativar, `dm.list` responde `Conversas ainda não ativadas neste aparelho`; `dm.enable` publica a `dm-key` (`gen: 1`);
- a mensagem do membro chega ao app (`dm.pull`, `dm.thread`, pasta `inbox`);
- o app responde com `replyTo` (v9), reage com 👍 (v10) e grava `dm.set` `accepted` (`ctl` v9); as três chamadas dão certo, e o `dm.list` do app, depois de um `dm.pull`, mostra a conversa;
- no membro, `dm.thread` traz a resposta ligada (`replyTo` com o id dele, `mine: false`) e a reação 👍 (`mine: false`).

Emulador Android (AVD `varanda-api36`, API 36, arm64-v8a), build de debug desta branch (`./gradlew assembleDebug`), com o Metro e o laboratório hospedado por `adb reverse` (8081 e 8080). O emulador não alcança o loopback do Mac por UDP, então a DHT de teste e o semeador do laboratório ligaram no endereço de rede local do Mac, com a sondagem de firewall do hyperdht desligada, como faz o `gate-server.js --platform android` (`docs/ios-gate.md`, "Android emulator"). Como o `hosted-lab.js` só liga em loopback, isso rodou por um lançador fora do repositório que troca só esses dois endereços; o HTTP, o WebSocket e o serviço de conta ficaram em loopback. A configuração core (associação e bootstrap do laboratório) foi gravada pelo `saveConfig` do app, e o app foi reaberto. A identidade, o certificado do laboratório (`cert.add`), o perfil e o seguir saíram do cliente do app pelo inspetor do Metro; a tela dos Termos ficou aberta, sem aceite, porque as chamadas vão direto ao nó. Mesmo roteiro do iOS, mesmo resultado:

- antes de ativar, `dm.list` responde `Conversas ainda não ativadas neste aparelho`; `dm.enable` publica a `dm-key` (`gen: 1`), e o primeiro `dm.send` do membro já a encontra pelo semeador;
- a mensagem do membro chega ao app (`dm.pull`, `dm.thread`, pasta `inbox`);
- o app responde com `replyTo` (v9), reage com 👍 (v10) e grava `dm.set` `accepted`; as três chamadas dão certo;
- no membro, `dm.thread` traz a resposta ligada (`replyTo` com o id dele, `mine: false`) e a reação 👍 (`mine: false`), e `dm.list` mostra a conversa com a prévia da resposta.

Não conferido: um toque na interface, porque no modo core nenhuma tela abre uma conversa pessoal, e um aparelho Android de verdade.
