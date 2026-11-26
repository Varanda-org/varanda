# Miniaturas ao publicar

## Escopo

`Publicar.js` chama `buildPostThumbs` depois do envio dos originais, com os bytes codificados retidos e o upload da pessoa ou da Página. Acrescenta `thumbs` ao pedido somente quando o retorno não é `null`. Nenhuma mudança na fila de saída, no plano de anexos ou em dependências.

## Verificação automatizada

Node v24.22.1, sem rede e sem fixtures adicionais. O teste executa as funções de envio extraídas da tela com substitutos locais de E/S e o helper real de miniaturas.

- Três fotos enviam três miniaturas na ordem dos bytes retidos.
- Falha ao codificar ou enviar uma miniatura preserva `null` na posição e envia o post uma vez. Falha em todas omite a chave.
- Texto, GIFs, fotos pequenas e vídeo não codificam nem enviam miniaturas e omitem `thumbs`.
- Caminhos pessoal e de Página usam o proprietário correto e mantêm o bloqueio durante a preparação. Falha no post não repete o pedido.

Comandos finais:

```sh
XDG_CACHE_HOME=/tmp/a18-standard-cache npm_config_offline=true npx --no-install standard apps/app/src/screens/Publicar.js apps/app/test/postShareCompose.test.js
node apps/app/test/postShareCompose.test.js
```

Lint: saída vazia, código 0. Teste:

```text
# tests = 21/21 pass
# asserts = 458/458 pass
# ok
```

Regressão sem a alteração em `Publicar.js`: código 1, `# tests = 20/21 pass`, `# asserts = 304/326 pass`. A alteração foi restaurada e o teste passou novamente.

Ocorrências durante a implementação: a primeira versão do teste extraiu outro `send` e terminou com `ReferenceError: busyRef is not defined`; a seleção foi corrigida e a execução isolada passou. O lint inicialmente encontrou `EPERM` no cache padrão, depois apontou `multiline-ternary` e `no-new-func` no teste; cache redirecionado e teste corrigido. O Node emite o aviso existente `MODULE_TYPELESS_PACKAGE_JSON` ao importar módulos ESM do app.

## Limites

Não executados: suíte completa, lint global, demo, Android, simulador iOS, web e PWA. Não há medição de desempenho ou validação ponta a ponta com um nó real. `docs/rpc.md` e `docs/protocol.md` não descrevem `thumbs` nesta cópia; a documentação normativa desse campo permanece pendente, pois esses arquivos não estão na lista autorizada da tarefa.
