# A página web só roda o nó da própria versão (branch fix/sw-node-release-pair, parte da #539)

A #539 junta as sobras do carregamento instantâneo. Esta parte fecha a janela de implantação que o PR #478 deixou registrada: um 5xx no `index.html` enquanto `/varanda-node.js` carrega, em que uma página antiga guardada fala com um nó novo até a próxima recarga. O dono do produto decidiu fechar a janela, não só documentar.

## O problema

O deploy troca os arquivos de `www` no lugar enquanto o Caddy segue servindo. Com o service worker da versão N ativo:

- Uma recarga no meio da troca recebe 404 ou 5xx no `index.html`, e o worker responde com o `index.html` guardado da versão N. Essa página pedia `/varanda-node.js`, que o worker busca primeiro na rede: se o servidor já tinha o nó da versão N+1, a página N rodava o nó N+1 (por exemplo, pedindo 27 itens a um nó que só aceita 26).
- O contrário também acontecia: uma página N+1 vinda da rede cujo pedido de `/varanda-node.js` falhava (404, 5xx, HTML, sem rede) recebia a cópia guardada do nó N.

`VarandaWebNode.version` não cobre isso: só muda numa quebra do nó ou do IndexedDB, não a cada mudança de limites de página.

## O que muda

- **Nome do nó por versão.** `apps/app/scripts/finish-web.js` copia `dist/varanda-node.js` para `dist/varanda-node-<versão>.js` (a mesma versão de 16 hex da marca `varanda-release` e do `sw.js`). A versão continua calculada sobre `varanda-node.js` com o nome simples, e a cópia de uma rodada anterior não entra na lista nem no hash: rodar duas vezes dá arquivos idênticos, e uma cópia de outra versão é apagada.
- **A página carrega a cópia da sua versão.** `apps/app/src/client/browser.js` lê a marca `varanda-release` e carrega `/varanda-node-<versão>.js` (`nodeScriptUrl`). Sem a marca (servidor de desenvolvimento) ou com uma marca fora do formato, carrega `/varanda-node.js` como antes.
- **O worker guarda só a cópia.** O precache traz `/varanda-node-<versão>.js` no lugar de `/varanda-node.js`, e esse arquivo é servido como um bundle com hash: primeiro o cache conferido por SHA-256, sem precisar da rede. A rota especial de `/varanda-node.js` (rede primeiro, cópia guardada como reserva) saiu: esse nome não está mais no precache, então só a rede responde, e um 404, um 5xx ou HTML chegam à página como falha, nunca como o nó de outra versão. Um nome de outra versão também é uma falta no cache e vai só para a rede.
- **Sem mudança no deploy.** `varanda-node.js` continua em `dist` e em `www`: as sondas de `deploy.sh`, `update.sh`, `build-web.sh` e `Dockerfile.web` seguem conferindo esse nome. O deploy já copia a pasta inteira, então a cópia por versão vai junto.

Resultado: a página guardada da versão N, servida durante a troca, roda o nó guardado da versão N (inclusive sem rede); uma página N+1 pede o nome N+1 ao servidor e, se ele ainda não existe, a carga do nó falha e o app mostra o erro de conexão com "Tentar de novo", em vez de rodar o nó N.

Documentos atualizados: `README.md` (exportação web), `docs/app.md` ("Abrir sem rede, instalado ou numa aba"), `docs/development.md` (o que `npm run export:web` deixa em `dist`) e a linha "Mixed releases" de `docs/verification.md`.

## Limites

- A primeira implantação com esta mudança ainda passa pela janela uma última vez: o worker que está no ar é o de antes, com a rota antiga de `/varanda-node.js`, e uma página antiga guardada continua pedindo o nome simples. A partir da versão seguinte, worker e página são desta branch.
- Uma página aberta antes de uma implantação que ainda não tinha carregado o nó (por exemplo, depois de uma falha) pede o nome da sua versão: com o worker dessa versão, vem do cache; sem worker (navegador sem service worker), o arquivo antigo já saiu de `www` e a carga falha até a pessoa recarregar.
- Durante a cópia, uma página nova cujo nó ainda não chegou ao servidor vê o erro de conexão até tocar "Tentar de novo" depois que a cópia termina.

## Testes

Cada arquivo rodou sozinho (`node apps/app/test/<arquivo>`), Node 24.22.1. A coluna "fontes da `main`" usa os testes desta branch com `sw.js`, `finish-web.js` e `browser.js` da `origin/main` (restaurados com `git checkout origin/main --` e depois devolvidos).

| Arquivo | Branch | Fontes da `main` |
|---|---|---|
| `sw.test.js` | 92/92, 1005/1005 | quebra no primeiro teste (`releaseNodePath is not a function`); só os dois testes da janela, sem o resto: 0/2 (a página guardada recebe o nó novo da rede e, sem rede, 503; o nome simples devolve a cópia guardada em 404, sem rede e com HTML) |
| `webnodeHandle.test.js` | 14/14, 114/114 | quebra (`nodeScriptUrl is not a function`) |

Na `main`, `sw.test.js` tinha 91 testes e `webnodeHandle.test.js` 12. Em `sw.test.js`, o teste "/varanda-node.js: network first, cached copy on HTML, 404 or offline" saiu (descrevia a reserva que causava a janela) e entraram "the cached shell runs the node of its own release while the server has another" e "a page of another release never gets this release's node". Os testes de envenenamento, tipo e quota do nó passaram a usar a cópia por versão. Em `webnodeHandle.test.js` entraram `nodeScriptUrl` (o nome igual ao de `finish-web.js`, e o nome simples para uma marca fora do formato) e a carga pela marca da página.

Também passam, sem mudança: `pwa.test.js`, `pwa-boot.test.js`, `release.test.js`, `push-shell.test.js`, `versionFooter.test.js`, `platformGate.test.js`, `apps/cli/test/changelog.test.js` e `apps/cli/test/readme-pull.test.js`.

## Conferência em aparelho

TODO: conferir na web (painel do navegador) com uma exportação local servida em HTTPS, e registrar Android e iOS como não aplicáveis (o app nativo leva o nó junto e não usa o service worker).
