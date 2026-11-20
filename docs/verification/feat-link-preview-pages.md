# Prévias de links de grupos, comunidades e Páginas

## Escopo

- `name-index`: busca de uma Página pelo @nome, em minúsculas, com as mesmas regras do índice de nomes.
- `Seeder.linkPublic(kind, id)`: para `g` e `c`, só uma raiz pública, vinculada ao diário, não bloqueada e com a leitura concluída; devolve o nome atual (com `group-meta`, inclusive renomeado ou apagado) e a imagem de `groupImagePublic`. Para `m` e `u`, só uma Página: nome, @nome, bio e avatar. Perfil de pessoa, grupo privado e chave desconhecida devolvem `null`.
- `apps/cli/lib/link-page.js`: a página Open Graph, com texto filtrado, limitado e escapado, e a mesma página genérica para qualquer falha do tipo pedido.
- `apps/cli/lib/seed-ws.js`: `GET|HEAD /p/g/<chave>`, `/p/c/<chave>`, `/p/m/<diário>` e `/p/@<nome>`, cada um com `/imagem`; orçamento próprio de 8 pedidos/s, rajada de 16, 4 em andamento e 5 s. A imagem é conferida por tamanho, hash, tipo e quadro antes de sair.
- `deploy/seeder/Caddyfile`: `@previaLink` reescreve `/g/`, `/c/`, `/m/` e `/@` para `/p` só com o User-Agent de um robô de prévia, numa zona de limite própria (30 a cada 10 s). Só chaves hexadecimais em minúsculas.
- Termos e Política na versão 104 e a linha LGPD de `docs/design.md`.

## Testes automatizados

| Área | Arquivo |
| --- | --- |
| Busca por @nome | `packages/core/test/name-index.test.js` |
| Regras de `linkPublic` | `packages/core/test/seeder-link-public.test.js` |
| Página Open Graph | `apps/cli/test/link-page.test.js` |
| Rotas HTTP e imagem | `apps/cli/test/seed-ws-link.test.js` |
| Rewrite e limites do Caddy | `apps/cli/test/caddyfile.test.js` |
| Termos e Política | `apps/app/test/legal.test.js`, `apps/site/test/legal.test.js`, `packages/core/test/terms.test.js` |

Regressões que falham sem a correção: comunidade e grupo renomeados mostram o nome novo; comunidade com o nome apagado devolve `name: null`; a descrição de uma Página começa por `Página @<nome>`; um @nome com marcação ou caracteres bidi é descartado; o matcher do Caddy recusa chave com maiúsculas.

## Execução local

Sobre `feat/group-image` 9da177a5, com `node <arquivo>` em quatro processos paralelos:

- `npm run lint`: saída 0.
- 94 arquivos de teste alcançados pela mudança (os alterados e os que importam um módulo alterado): todos passaram. Entre eles, `name-index.test.js` (409 asserções), `seeder-link-public.test.js` (167), `link-page.test.js` (1062), `seed-ws-link.test.js` (362) e `caddyfile.test.js` (388).
- `npm run demo`: `DEMO OK`.

A suíte completa roda na CI do GitHub.

## Limitações conhecidas

- O cabeçalho global do Caddy (`cabecalhos_seguranca`) troca o CSP que o semeador envia em `/p/*` pelo CSP do app. Isso já acontece nas páginas de publicação; corrigir fica para um PR próprio.
- O `robots.txt` só libera `/f/`, `/p/` e `/og/`. Um robô de prévia que respeite o `robots.txt` não busca `/g/<chave>` e mostra a prévia genérica.
- Um link com a chave em maiúsculas não recebe a prévia e abre o app normalmente.

## Staging, ainda não executado

Implantar primeiro o semeador com estas rotas e só depois o rewrite do Caddy. Usar a origem de posts já configurada, um grupo público G, uma comunidade pública C e uma Página D com @nome e avatar disponíveis. As chaves e o nome abaixo são placeholders de fixtures de staging.

```sh
preview_origin='https://staging.example'
preview_group='<G>'
preview_community='<C>'
preview_page='<D>'
preview_name='<nome>'

curl -fsS -D /tmp/link-direct.headers "$preview_origin/p/g/$preview_group" -o /tmp/link-direct.html
curl -fsS -D /tmp/link-index.headers -A 'Mozilla/5.0' "$preview_origin/" -o /tmp/link-index.html

for preview_path in "g/$preview_group" "c/$preview_community" "m/$preview_page" "@$preview_name"
do
  curl -fsS -D /tmp/link-crawler.headers -A 'WhatsApp/2.0' "$preview_origin/$preview_path" -o /tmp/link-crawler.html
  rg 'og:title|og:description|og:image|og:url' /tmp/link-crawler.html
  rg -i 'HTTP/|content-type|cache-control|x-robots-tag|content-security-policy' /tmp/link-crawler.headers
  curl -fsS -D /tmp/link-browser.headers -A 'Mozilla/5.0' "$preview_origin/$preview_path" -o /tmp/link-browser.html
  cmp /tmp/link-index.html /tmp/link-browser.html
  curl -fsSI "$preview_origin/p/$preview_path/imagem"
done
```

Esperado: o robô recebe 200 com a prévia correta, `no-store` e `noindex`; o navegador recebe `index.html`, com `no-cache`, e cada `cmp` termina com saída 0. A imagem disponível responde 200, `image/jpeg` ou `image/webp`, `nosniff`, `no-store` e tamanho exato. O CSP recebido através do proxy é o do app (veja as limitações). Repetir com `TelegramBot` e com `?origem=teste` na página para conferir a preservação da query. A imagem com query deve ser 404. Respeitar a janela do limite do Caddy entre rodadas.

Com uma fixture de grupo privado e uma chave desconhecida, comparar os corpos de `/p/g/<privado>` e `/p/g/<desconhecido>` com `cmp`: ambos 200 e idênticos, sem o nome selado; `/imagem` é 404. O crawler no caminho público correspondente recebe o mesmo resultado. Com a origem de posts desligada em uma instalação de staging separada, os quatro tipos são genéricos, sem `og:image` ou `og:url`, e as quatro imagens são 404. Conferir ainda `/p/<diário>/<seq>` de uma publicação compartilhada: continua servindo a página da publicação.
