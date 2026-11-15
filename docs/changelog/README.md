# Entradas do changelog

Um PR com mudança que a pessoa usuária ou o operador percebe descreve essa mudança num arquivo novo nesta pasta, em vez de acrescentar uma linha à seção "Não lançado" do [CHANGELOG.md](../../CHANGELOG.md). Com cada PR no seu próprio arquivo, um merge na `main` não deixa os outros PRs abertos em conflito.

- **Nome**: o da branch, com `/` trocado por `-` e terminado em `.md`. A branch `fix/fetch-socket-retention` usa `fix-fetch-socket-retention.md`.
- **Conteúdo**: o item ou os itens que iriam para o CHANGELOG.md, no mesmo formato: cada item começa com `- ` numa linha, e as linhas seguintes que não estão em branco continuam o item. Itens sem título entram no topo de "Não lançado".
- **Subseção**: uma linha `### Segurança`, `### Adicionado`, `### Alterado`, `### Removido` ou `### Corrigido` manda os itens que vêm depois dela para o topo dessa subseção de "Não lançado".
- **Verificação**: se o PR registra o que foi conferido, cite o arquivo dele em `docs/verification/` (veja o [README](../verification/README.md) dessa pasta).
- **Correção**: corrigir um item que já está no CHANGELOG.md continua sendo no próprio CHANGELOG.md.

Exemplo, `docs/changelog/fix-fetch-socket-retention.md`:

```markdown
- Liberação de referências a sockets fechados nas buscas em quarentena (PR `fix/fetch-socket-retention`). Verificação em `docs/verification/fix-fetch-socket-retention.md`.

### Segurança

- O semeador fecha o socket de uma busca em quarentena assim que ela termina.
```

Quando uma versão é lançada, `node scripts/changelog.js` junta ao CHANGELOG.md os arquivos desta pasta, em ordem de nome, e apaga cada um; este README fica. Um arquivo fora do formato faz o comando parar sem escrever nada, com o nome do arquivo e a linha. Até lá, o que ainda não foi lançado está no CHANGELOG.md e nesta pasta.
