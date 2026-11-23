### Adicionado
- App: **Novo grupo** em **Nova conversa** oferece **Grupo sem comunidade**, que qualquer pessoa cria, mesmo sem nenhuma comunidade. O grupo aparece em **Conversas** (lido por `group.standalone`) e abre direto depois de criado. Uma criação incerta se confere pelas chaves lidas antes e depois do pedido, sem reenvio automático. Uma Página não vê essa opção. Verificação em `docs/verification/feat-standalone-groups-app.md`.
### Corrigido
- App: a tela de um grupo de comunidade não oferece mais **Entrar no grupo** a quem não é membro da comunidade, nem a uma Página fora dela; essa pessoa vê **Entrar na comunidade**. Um grupo sem comunidade nunca pede a comunidade. Verificação em `docs/verification/feat-standalone-groups-app.md`.
### Segurança
- O nó do navegador confere, no bloco 0 assinado da raiz lido no semeador, a dica de comunidade ou de grupo sem comunidade antes de entrar num grupo que ainda não chegou; uma dica falsa do índice é recusada sem gravar nada no diário. Verificação em `docs/verification/feat-standalone-groups-app.md`.
