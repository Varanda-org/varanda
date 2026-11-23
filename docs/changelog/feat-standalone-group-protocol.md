- Grupos sem comunidade no protocolo (PR `feat/standalone-group-protocol`): a raiz de um grupo v2 pode ter `community` e `member` nulos, e quem escreve num grupo assim nomeia `member` igual à chave da raiz. A dobra, o direito de ler de um grupo privado, a admissão e a persistência no semeador e a sincronização do nó seguem essa forma, e a seção 10 de `docs/protocol.md` a descreve. Verificação em `docs/verification/feat-standalone-group-protocol.md`.

### Alterado

- Nós e semeadores anteriores a esta mudança leem a raiz sem comunidade como cabeçalho inválido: o semeador antigo a recusa e apaga a própria cópia, e o nó antigo a ignora. Nada é apagado como legado. Atualize os semeadores antes de qualquer nó que possa criar um grupo sem comunidade.
