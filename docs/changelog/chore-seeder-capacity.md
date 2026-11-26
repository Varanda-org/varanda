### Alterado

- Padrões maiores para o semeador da hospedagem web (PR `chore/seeder-capacity`): `compose.web.yaml` passa a usar 96 conexões externas, 201326592 bytes de memória de quadros (na mesma proporção), 256 sockets, 32 mídias em andamento, mídia a 256 por segundo com rajada de 512 e índice a 128 por segundo com rajada de 256, quando a variável não está no `.env` ou está vazia. Um valor no `.env` continua valendo, e os padrões do código do semeador não mudam. São propostas ainda sem medição com o harness: veja `docs/seeder-capacity.md` e `docs/verification/chore-seeder-capacity.md`.
