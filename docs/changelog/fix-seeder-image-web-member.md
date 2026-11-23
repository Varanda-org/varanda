### Corrigido

- A imagem do semeador volta a subir (PR `fix/seeder-image-web-member`). Na versão do `account review` (99b079dd), todo comando da CLI parava ao abrir, `seed` inclusive, porque a imagem não trazia o código de `packages/web-member`: a atualização falhava na checagem de saúde e o servidor voltava para a versão anterior. A imagem passa a levar o `package.json` e o `lib` desse workspace, e só o `account review` carrega esse código, quando roda. Verificação em `docs/verification/fix-seeder-image-web-member.md`.
