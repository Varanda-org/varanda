# Verificação: docs/legal-cdn

Termos e Política na versão 114, com a CDN das fotos públicas descrita como desligada.

## Testes (`node <arquivo>`)

- `apps/app/test/legal.test.js`: `LEGAL_VERSION` 114, a nota de revisão, o novo digest do texto e o teste "version 114 describes the CDN edge as off and what it would see", que exige cada frase da Política sobre a CDN e recusa um texto que a diga ligada.
- `apps/app/test/terms-version.test.js`: `LEGAL_VERSION` igual ao `TERMS_VERSION` de `packages/core/lib/terms.js`.
- `packages/core/test/terms.test.js`: `TERMS_VERSION` 114.
- `apps/site/test/legal.test.js`: as páginas `termos/` e `privacidade/` são o render de `legal.js` (`node apps/site/scripts/render-legal.js`), na versão 114.

## Conferido no código

O texto segue o que o código faz hoje (`apps/app/src/media/fetch.js`, `apps/app/src/installation.js`, `docs/cdn.md`): só `GET /media/<autor>/<núcleo>/<início>/<blocos>` de mídia pública de diário vai à origem de mídia; itens de conversa e grupo, `/blob` e as demais rotas nunca vão; a mesma conferência de hash e uma nova tentativa na instalação; `s-maxage=60` vem do Caddyfile de `chore/cdn-ready-deploy`.

## Aterrissagem

`npm run lint`, os arquivos de teste direcionados sobre o diff contra `origin/main` e `npm run demo` ("DEMO OK"). A suíte inteira roda na CI do GitHub (Node 20 e 24).

## Não conferido

Sem parecer jurídico: a base legal e o mecanismo da transferência internacional ficam em aberto, como no resto da Política. O provedor ainda não foi escolhido, então o texto não o nomeia.
