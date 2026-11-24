### Corrigido

- Nó do core: num grupo em que um diário já ocupa as 32 vagas de escritor, a entrada mais antiga toma a vaga do último a entrar também quando a entrada dele chega, buscada por outro portão, depois de a primeira leitura das entradas do diário ter parado antes dela (PR `fix/group-cap-stale-joins`). Antes, o último contava como não provado e saía outro escritor no lugar dele. Verificação em `docs/verification/fix-group-cap-stale-joins.md`.
