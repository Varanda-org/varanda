# Preload do nó no índice web

O `finish-web.js` insere no `<head>` um único preload de script com o caminho de `releaseNodePath(version)`, sem `integrity` e sem `crossorigin`. O hash final do índice inclui o link; o cálculo da versão remove o link gerado anterior para manter a segunda execução idêntica.

Cobertura em `apps/app/test/sw.test.js`: caminho e atributos do link, posição no head, idempotência, troca do link quando a versão muda e SHA-256 do índice escrito no manifesto. Em `apps/app/test/webnodeHandle.test.js`, o script de `loadNode` usa o mesmo caminho e não define os dois atributos.

Verificação executada nesta cópia sem `node_modules`:

- `npm_config_offline=true npm_config_update_notifier=false npx --no-install standard apps/app/scripts/finish-web.js apps/app/test/webnodeHandle.test.js apps/app/test/sw.test.js`: saída 1, `npm error code ENOTCACHED`. O pacote `standard` não está disponível localmente nem no cache. Sem acesso à rede.
- `node apps/app/test/sw.test.js`: saída 1, `Error: Cannot find module 'brittle'`.
- `node apps/app/test/webnodeHandle.test.js`: saída 1, `Error: Cannot find module 'brittle'`.
- Os dois arquivos de teste foram executados individualmente antes e depois da correção; nas duas tentativas falharam ao carregar `brittle`, antes das asserções.
- `node --check` em cada um dos três arquivos JavaScript alterados: saída 0, sem mensagens.
- Conferência adicional via `node` pela entrada padrão, usando apenas `assert`, `fs`, `os`, `path`, `crypto` e `vm`: exportação mínima em diretório temporário, removido ao terminar. Conferiu link exato, posição no head, preservação de outro preload, bytes idênticos dos arquivos na segunda execução, SHA-256 no manifesto do worker gerado e substituição da versão depois de alterar o script do nó. Saída 0: `PASS: preload URL and attributes, head placement, unrelated preload, byte-identical rerun, manifest sha256 and release replacement`.
- Prova de regressão dessa conferência adicional, antes da correção: saída 1, `AssertionError [ERR_ASSERTION]: one exact node preload`, com resultado `null` no lugar do link esperado. Não substitui a execução dos testes com `brittle`.

Nenhuma fixture permanente foi criada. Não foram executados o lint completo, a suíte completa, a demo ou builds de Android, iOS e web. Não foram medidos tempo de carregamento nem reaproveitamento da requisição em navegador real. A alteração não muda protocolo nem RPC.
