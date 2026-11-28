### Corrigido

- `scripts/bunny.js apply` passa a criar a zona do Bunny com uma origem que nunca resolve (`https://origin.invalid`), porque o Bunny passou a exigir uma origem na criação; a origem real entra depois das três regras, como antes (PR `fix/bunny-create-origin`). Verificação em `docs/verification/fix-bunny-create-origin.md`.
