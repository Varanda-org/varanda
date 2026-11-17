# Páginas: ler Conversas ocupado e agir como Página que não é mais da pessoa (branch fix/paginas-agir-estado)

Parte da #352. Só o app muda (`apps/app`). Não muda formato, RPC nem Termos.

- **Conversas da Página sem "ocupado".** No navegador, `page.read` é uma leitura de diário e responde `ocupado` enquanto os espaços de leitura do nó estão tomados. `PageInboxNote` (`apps/app/src/screens/Mensagens.js`) mostrava a palavra crua com "tentar de novo". Agora a leitura passa por `readRetryingBusy` (`apps/app/src/busyRetry.js`), pelo limitador `diaryPeekSlots` e tenta de novo algumas vezes com espera crescente. Se continuar ocupado, o cartão fica no estado quieto de leitura (ou no último bom) e uma releitura marcada (uma só, depois de `KEYS_REREAD_MS`, que o app desfaz ao sair da tela ou ao começar outra leitura) pergunta de novo, para o dono não ficar sem o cartão de ativar. Um `ocupado` vindo do `dm.pageSecrets` (a leitura dentro do nó, fora do espaço do app) também fica quieto. Fora essa releitura, o gatilho na prática é o pull de 5 minutos ou um pull manual. Outros erros continuam sendo mostrados. `isBusy` e as constantes de espera saíram de `Conversa.js` para `busyRetry.js`; `Conversa.js` continua exportando `isBusy`.
- **Agir como Página que a pessoa deixou de tocar.** `pagesList` (`apps/app/src/pages.js`) volta a identidade para a pessoa, na hora e sem recarregar, quando a resposta mais nova da lista mostra que a Página em que o aparelho age está encerrada, mudou de chave (a chave antiga vem encerrada com `movedTo`) ou não está mais entre as que a pessoa toca (`actingPageStopped`, `apps/app/src/pageSecrets.js`). A chave nova depois de uma mudança continua. Vale também para a Página que o compositor de Momento deixou de lado (`dropPage`, `actingAs.js`): ela não volta ao fechar o compositor. A identidade é comparada com a de quando a leitura começou: uma lista pedida antes de a pessoa passar a agir como a Página não a derruba. Uma leitura que falhou, uma resposta malformada ou uma resposta mais antiga que chega depois não muda nada.

Como verificar, a partir da raiz:

- `node apps/app/test/busyRetry.test.js`: "readRetryingBusy: a busy read is asked again..." falha sem a distinção do `ocupado` (o erro sobe em vez de virar estado quieto). O segundo teste cobre a passagem pelo `diaryPeekSlots`.
- `node apps/app/test/busyRetry.test.js` também cobre uma tela que saiu enquanto esperava o espaço: a leitura não é feita e o resultado é "ocupado", nunca `null`.
- `node apps/app/test/actingAs.test.js`: "dropPage ..." falha sem limpar a Página deixada de lado.
- `node apps/app/test/pageSecrets.test.js`: "actingPageStopped: ..." cobre a função pura.
- `node apps/app/test/pages.test.js`: "pagesList sets the acting identity back to the person..." falha sem a chamada de `actingPageStopped` em `pagesList` (a identidade fica na Página encerrada, trocada de chave ou removida).
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

Caminhada no aparelho (Android primeiro, depois iOS, depois web), ainda não feita:

- [ ] Android: abrir Conversas agindo como Página com o nó ocupado: sem "ocupado" cru, o cartão carrega sozinho.
- [ ] Android: encerrar a Página em outro aparelho e abrir Páginas: este aparelho volta a agir como a pessoa, sem "sem chave da página".
- [ ] Android: mudar a chave da Página em outro aparelho: o aparelho que agia na chave antiga volta para a pessoa.
- [ ] Android: remover a pessoa como admin em outro aparelho: ao abrir Páginas, volta a agir como a pessoa.
- [ ] iOS: os mesmos quatro passos.
- [ ] Web: os mesmos quatro passos.

Limites:

- A identidade só volta quando Páginas ou Publicar leem a lista; até lá o aparelho continua agindo como a Página.
- Com o nó ocupado por muito tempo, o cartão de Conversas fica em leitura e relê a cada `KEYS_REREAD_MS` (15 s) mais as esperas da tentativa, nunca mais rápido.
