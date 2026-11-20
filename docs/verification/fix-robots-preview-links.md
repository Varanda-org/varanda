# robots.txt libera /g/ e /c/ para os robôs de prévia

## Escopo

- `deploy/seeder/Caddyfile`: o corpo de `/robots.txt` ganha, antes do grupo `User-agent: *`, um grupo com uma linha `User-agent:` para cada robô do User-Agent do `@previaLink` (facebookexternalhit, Facebot, WhatsApp, TelegramBot, Twitterbot, Slackbot, Discordbot, LinkedInBot, SkypeUriPreview e Applebot), seguido de `Allow: /g/`, `Allow: /c/`, `Allow: /f/`, `Allow: /p/`, `Allow: /og/` e `Disallow: /`. Um robô lê só o grupo mais específico, por isso o grupo repete as três liberações do `*`.
- O grupo `*` e a linha `Sitemap:` ficam iguais, byte a byte. As páginas `/p/g/<chave>` e `/p/c/<chave>` continuam com `<meta name="robots" content="noindex">` e o cabeçalho `X-Robots-Tag`, então nada entra na busca.
- `/m/`, `/@` e `/convite/` ficam fora: continuam fechados no `robots.txt` para todos os robôs.
- `docs/protocol.md`, seção 15, "Sitemap and robots": descreve o grupo novo e o motivo.

## Testes automatizados

`apps/cli/test/caddyfile.test.js`, no teste do `/f/*` e do `/robots.txt`:

- o corpo inteiro do `robots.txt`, linha a linha;
- o grupo `*` e a linha `Sitemap:` iguais aos de antes e no fim do corpo, com um só `User-agent: *` e uma só linha `Sitemap:`;
- a lista de `User-agent` do grupo novo, em minúsculas, igual à alternância do `header_regexp User-Agent` do `@previaLink`, lida do próprio Caddyfile;
- o grupo novo só acrescenta `/g/` e `/c/` às três liberações do `*`;
- toda linha do heredoc tem o recuo da marca de fechamento e nenhum espaço no fim.

Conferências de que o teste falha sem a mudança: com o Caddyfile anterior, 3 asserções falham (corpo, lista de robôs e regras do grupo). Com um `User-agent: Googlebot` a mais no grupo, falham o corpo e a lista de robôs. Com um espaço no fim de uma linha, falha a asserção do recuo.

## Execução local

Com `node <arquivo>`, um por vez, a partir da raiz:

- `apps/cli/test/caddyfile.test.js`: 27 testes, 394 asserções, todas passaram.
- `apps/cli/test/seed-ws-link.test.js`: 9 testes, 372 asserções, todas passaram.
- `apps/cli/test/link-page.test.js`: 15 testes, 1062 asserções, todas passaram.
- `apps/cli/test/changelog.test.js`: 9 testes, 42 asserções, todas passaram.
- `npx standard apps/cli/test/caddyfile.test.js`: sem erros.

A suíte completa roda na CI do GitHub deste PR.

## Verificações pendentes

- Produção só muda depois do deploy do Caddy feito pelo dono (`deploy/seeder/Caddyfile` recarregado no servidor). Nada foi implantado nem recarregado neste PR.
- Conferência manual depois do deploy, com o domínio de produção no lugar de `<domínio>` e a chave de um grupo público com imagem no lugar de `<chave>`:
  - `curl -s https://<domínio>/robots.txt` mostra o grupo dos robôs de prévia com `Allow: /g/` e `Allow: /c/`, e depois o grupo `User-agent: *` igual ao de antes, com a linha `Sitemap:`.
  - `curl -s -A 'Twitterbot/1.0' https://<domínio>/g/<chave>` devolve a página de prévia com um `og:image` que termina em `/p/g/<chave>/imagem` (na origem de `VARANDA_POSTS_ORIGIN`), `<meta name="robots" content="noindex">` e o cabeçalho `X-Robots-Tag: noindex, nofollow, noarchive` (com `curl -si`). O mesmo com `/c/<chave>` para uma comunidade.
  - `curl -s https://<domínio>/g/<chave>` sem o User-Agent de robô continua devolvendo o app (`index.html`).
  - Colar o link `/g/<chave>` numa conversa do WhatsApp ou do Telegram mostra o cartão com a imagem do grupo.
