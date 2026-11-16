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
- **O deploy confere a cópia.** `varanda-node.js` continua em `dist` e em `www`, e as sondas continuam conferindo esse nome. Além dele, `build-web.sh` e `Dockerfile.web` recusam um build sem a marca `varanda-release` no `index.html` ou sem a cópia `varanda-node-<versão>.js` dessa versão. O `aguardar_web` do `deploy.sh` e o do `update.sh` leem a versão da marca do `index.html` de `www` (`versao_web`, em `deploy/seeder/well-known.sh`) e conferem a cópia servida pelo domínio byte a byte, como o bundle com hash; um `www` sem a marca (uma volta para uma versão anterior a esta) pula essa sonda. Sem isso, um export que deixasse de gravar a cópia publicaria uma página que não carrega o nó e um worker que não instala, com todas as sondas verdes.
- **A página entra por último.** O `publicar_web` do `deploy.sh` e a publicação manual do `build-web.sh` esvaziam `www` como antes, mas copiam o app com `copiar_app` (`well-known.sh`): tudo menos `index.html` e `sw.js`, depois o `sw.js` e por último o `index.html`. Na ordem do diretório (`cp -R dist/. www/`), um `index.html` novo podia chegar antes da cópia do nó da sua versão. Uma cópia que falha continua parando a publicação. O `update.sh` não copia por cima: ele prepara o `www` de cada versão num diretório próprio.

Resultado: a página guardada da versão N, servida durante a troca, roda o nó guardado da versão N (inclusive sem rede); uma página N+1 só é servida depois que o nó N+1 já está em `www`. Se a carga do nó falhar mesmo assim, o app mostra o erro de conexão com "Tentar de novo", em vez de rodar o nó N.

Documentos atualizados: `README.md` (exportação web e os passos do `deploy.sh`), `docs/app.md` ("Abrir sem rede, instalado ou numa aba"), `docs/development.md` (o que `npm run export:web` deixa em `dist`) e a linha "Mixed releases" de `docs/verification.md`.

## Limites

- A primeira implantação com esta mudança ainda passa pela janela uma última vez: o worker que está no ar é o de antes, com a rota antiga de `/varanda-node.js`, e uma página antiga guardada continua pedindo o nome simples. Ela também roda o `deploy.sh` anterior (o bash já leu o arquivo antes do `git reset`), então copia `www` na ordem do diretório e não sonda a cópia do nó; o `build-web.sh` novo, que roda do checkout já trocado, recusa o build sem a cópia. A partir da implantação seguinte, worker, página e `deploy.sh` são desta branch.
- Uma página aberta antes de uma implantação que ainda não tinha carregado o nó (por exemplo, depois de uma falha) pede o nome da sua versão: com o worker dessa versão, vem do cache; sem worker (navegador sem service worker), o arquivo antigo já saiu de `www` e a carga falha até a pessoa recarregar.
- A volta do `deploy.sh` (`voltar`) restaura `www` com `cp -a` na ordem do diretório, como antes: durante essa cópia, uma página da versão anterior pode chegar antes do próprio nó e mostrar o erro de conexão até "Tentar de novo".
- Enquanto `www` está vazio ou pela metade, um navegador sem o worker desta versão recebe 404, como antes; só a ordem da cópia mudou.

## Testes

Cada arquivo rodou sozinho (`node apps/app/test/<arquivo>`), Node 24.22.1. A coluna "fontes da `main`" usa os testes desta branch com `sw.js`, `finish-web.js` e `browser.js` da `origin/main` (restaurados com `git checkout origin/main --` e depois devolvidos).

| Arquivo | Branch | Fontes da `main` |
|---|---|---|
| `sw.test.js` | 92/92, 1005/1005 | quebra no primeiro teste (`releaseNodePath is not a function`); só os dois testes da janela, sem o resto: 0/2 (a página guardada recebe o nó novo da rede e, sem rede, 503; o nome simples devolve a cópia guardada em 404, sem rede e com HTML) |
| `webnodeHandle.test.js` | 14/14, 114/114 | quebra (`nodeScriptUrl is not a function`) |

Na `main`, `sw.test.js` tinha 91 testes e `webnodeHandle.test.js` 12. Em `sw.test.js`, o teste "/varanda-node.js: network first, cached copy on HTML, 404 or offline" saiu (descrevia a reserva que causava a janela) e entraram "the cached shell runs the node of its own release while the server has another" e "a page of another release never gets this release's node". Os testes de envenenamento, tipo e quota do nó passaram a usar a cópia por versão. Em `webnodeHandle.test.js` entraram `nodeScriptUrl` (o nome igual ao de `finish-web.js`, e o nome simples para uma marca fora do formato) e a carga pela marca da página.

Também passam, sem mudança: `pwa.test.js`, `pwa-boot.test.js`, `release.test.js`, `push-shell.test.js`, `versionFooter.test.js`, `platformGate.test.js`, `apps/cli/test/changelog.test.js` e `apps/cli/test/readme-pull.test.js`.

### Correções da revisão (deploy e `finish-web.js`)

Mesma forma: cada arquivo sozinho, Node 24.22.1. A coluna "fontes antes" usa os testes atuais com `well-known.sh`, `deploy.sh`, `build-web.sh`, `Dockerfile.web`, `update.sh` e `finish-web.js` do commit anterior desta branch (22e8be45), restaurados com `git checkout` e depois devolvidos.

| Arquivo | Branch | Fontes antes |
|---|---|---|
| `apps/cli/test/deploy.test.js` | 62/62, 831/831 | falham as linhas exigidas do `deploy.sh` (a leitura da marca, a sonda da cópia, `copiar_app` e a cópia na ordem do diretório) e 8 asserções do teste do `build-web.sh` (a publicação por `copiar_app` e as recusas sem a cópia ou sem a marca, nos dois modos); o teste novo de `copiar_app` e `versao_web` quebra (`copiar_app: command not found`) |
| `apps/cli/test/update.test.js` | 73/73, 1901/1901 (o arquivo inteiro, 521 s) | só os dois testes tocados, numa cópia temporária com `test.solo` (apagada depois): 0/2, 83/86 (falta a sonda no `aguardar_web`; a porta de saúde passa uma página marcada cuja cópia do nó não é servida, sem pedi-la) |
| `apps/cli/test/web-image.test.js` | 6/6, 48/48 | 5/6, 46/48 (a leitura da marca e o `test -f` da cópia) |
| `apps/app/test/sw.test.js` | 92/92, 1006/1006 | quebra no teste da exportação incompleta: com um diretório no lugar de `varanda-node.js`, `TypeError: Cannot set properties of undefined (setting 'url')` em vez da mensagem clara |

`deploy.test.js` ganhou "well-known.sh: copiar_app copies index.html last and versao_web reads the release mark": um `cp` embrulhado registra a ordem (o `sw.js` e depois o `index.html` por último, a cópia do nó antes da página), os bytes e os arquivos com ponto (`.well-known`) chegam iguais, e uma cópia que falha faz `copiar_app` falhar sem publicar o `index.html`. O trecho novo do `Dockerfile.web` também rodou no `sh` e no `sed` do BusyBox (uma imagem Alpine local, sem rede): aceita a marca com a cópia e recusa sem a cópia e sem a marca. `npm run lint` passa. Ainda passam: `apps/cli/test/changelog.test.js` 9/9 e `apps/cli/test/readme-pull.test.js` 16/16.

## Conferência em aparelho

Pendente: conferir na web (painel do navegador) com uma exportação local servida em HTTPS, e registrar Android e iOS como não aplicáveis (o app nativo leva o nó junto e não usa o service worker).
