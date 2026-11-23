### Corrigido

- Seguidos de outros aparelhos na CLI e no app com configuração manual (PR `feat/core-fold-follows`, #137): `follow list`, `follow add` e `remove`, `feed` e o início de cada `sync` passam a aplicar os registros `follow` do próprio diário a `follows.json`. Quem seguiu ou deixou de seguir na web agora aparece na CLI depois do sync, e o contrário também. Um seguido antigo, de antes dos registros, continua na lista e não é publicado. Verificação em `docs/verification/feat-core-fold-follows.md`.
