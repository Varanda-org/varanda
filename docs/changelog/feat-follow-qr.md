### Adicionado

- "Meu QR" no Diário: o QR do link do próprio perfil (`/@nome` ou `/m/<chave>`), com copiar e compartilhar. Quem lê com a câmera do celular abre o perfil com o botão Seguir; nada é seguido sem o toque. O app não usa a câmera. Verificação em `docs/verification/feat-follow-qr.md`.

### Alterado

- Os links de perfil `/@nome` e `/m/<chave>` de `bora.varanda.app` abrem o app instalado (App Links no Android, links universais no iOS). O operador precisa publicar de novo o `apple-app-site-association` (`deploy/seeder/well-known.sh`) para o iOS.
