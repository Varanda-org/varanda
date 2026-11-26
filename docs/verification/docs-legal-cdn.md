# Verificação: docs/legal-cdn

Termos e Política na versão 115, com a CDN das fotos públicas descrita como desligada e o provedor (BunnyWay d.o.o., bunny.net) nomeado.

## Testes (`node <arquivo>`)

- `apps/app/test/legal.test.js`: `LEGAL_VERSION` 115, a nota de revisão, o novo digest do texto e o teste "version 115 names Bunny as the CDN edge, still off, and what it keeps", que exige cada frase da Política sobre a CDN (provedor, registros por até 3 dias, endereço anonimizado só no que a associação vê, cópias por no máximo um minuto), recusa um texto que a diga ligada, recusa a antiga promessa de nomear o provedor depois e recusa a promessa de registros guardados já anonimizados.
- `apps/app/test/terms-version.test.js`: `LEGAL_VERSION` igual ao `TERMS_VERSION` de `packages/core/lib/terms.js`.
- `packages/core/test/terms.test.js`: `TERMS_VERSION` 115.
- `apps/site/test/legal.test.js`: as páginas `termos/` e `privacidade/` são o render de `legal.js` (`node apps/site/scripts/render-legal.js`), na versão 115.

## Conferido no código

O texto segue o que o código faz hoje (`apps/app/src/media/fetch.js`, `apps/app/src/installation.js`, `docs/cdn.md`): só `GET /media/<autor>/<núcleo>/<início>/<blocos>` de mídia pública de diário vai à origem de mídia; itens de conversa e grupo, `/blob` e as demais rotas nunca vão; a mesma conferência de hash e uma nova tentativa na instalação; `s-maxage=60` vem do Caddyfile de `chore/cdn-ready-deploy`.

## Aterrissagem

`npm run lint`, os arquivos de teste direcionados sobre o diff contra `origin/main` e `npm run demo` ("DEMO OK"). A suíte inteira roda na CI do GitHub (Node 20 e 24).

## Não conferido

Sem parecer jurídico: a base legal e o mecanismo da transferência internacional ficam em aberto, como no resto da Política. Os fatos sobre a Bunny vêm da documentação dela (bunny.net/privacy, bunny.net/docs/cdn/logging), sem teste ao vivo: registros por até 3 dias, anonimização ligada por padrão e aplicada na leitura pela API ("applies on read at the API boundary"), e Edge Rules que fixam o tempo de cópia. A documentação não diz se a Bunny guarda o endereço completo nesses 3 dias, e o texto diz isso. A versão 114 ficou com a mudança da câmera, que entrou antes na `main`.
