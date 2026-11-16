### Corrigido

- Na web, a página só roda o nó da própria versão (PR `fix/sw-node-release-pair`, parte da #539). A exportação copia `varanda-node.js` para `varanda-node-<versão>.js`, a página carrega esse nome e o service worker guarda só essa cópia. Antes, enquanto uma implantação trocava os arquivos, uma recarga podia receber um 5xx no `index.html`, abrir a página guardada da versão antiga e carregar da rede o nó novo; e uma página nova cujo nó falhava recebia o nó guardado da versão antiga. Verificação em `docs/verification/fix-sw-node-release-pair.md`.
