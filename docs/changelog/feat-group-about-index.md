### Adicionado

- O semeador guarda a descrição de grupos e comunidades públicos, lida do último registro `group-about` da raiz, e a entrega pela rota `GET /index/group-about/<chaves>`, em lotes de até 32 chaves. A página de link de um grupo ou comunidade pública (`/p/g/<chave>` e `/p/c/<chave>`) usa essa descrição, cortada em 200 caracteres, como `og:description`. Grupos privados, ocultos ou desconhecidos não têm descrição no índice e mantêm a página genérica. Verificação em `docs/verification/feat-group-about-index.md`.
- No app, quem abre uma comunidade ou um grupo público sem participar lê a descrição no cartão antes de entrar, vinda do índice ou, num grupo cuja raiz o aparelho já guarda, do próprio nó. Verificação em `docs/verification/feat-group-about-index.md`.
