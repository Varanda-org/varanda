### Corrigido

- `content-load.js` conta `sweepsMs` desde a etapa `diários de grupo`, a primeira das três varreduras da partida; antes começava no `índice de réplicas` e deixava a primeira de fora (PR `test/content-results`).

### Alterado

- Resultados da pilha de carregamento de conteúdo (PR `test/content-results`): `docs/performance.md` ganhou a seção com os números da pilha ao lado da linha de base, as duas árvores medidas de novo com a mesma bancada corrigida. São números da bancada no Node, não de celular. Conferência em `docs/verification/test-content-results.md`.
