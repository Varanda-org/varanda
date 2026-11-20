### Corrigido

- Prévia de link das publicações públicas (`/p/`) (PR `fix/post-page-og-tags`): a página passa a trazer o conjunto completo de tags que os mensageiros leem (`description`, `og:url`, `og:site_name`, `og:locale`, tamanho, tipo e texto alternativo da imagem e `twitter:card` com imagem grande). Uma publicação só de texto, ou só com fotos AVIF, mostra no WhatsApp e afins o cartão da Varanda (`/og/convite.png`) em vez de um link sem imagem. Verificação em `docs/verification/fix-post-page-og-tags.md`.
