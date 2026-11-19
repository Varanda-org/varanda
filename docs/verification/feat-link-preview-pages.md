# Prévias de links no semeador

T22, PR P4 `feat/link-preview-pages`, wave 9. Alteração restrita às rotas do semeador, teste HTTP e documentação. Os arquivos das waves anteriores foram preservados.

## Cobertura

`apps/cli/test/seed-ws-link.test.js` usa um semeador falso e HTTP em loopback. Confere os quatro tipos, tags, GET/HEAD, @nome em minúsculas, corpo genérico, origem desligada, Host, métodos, caminhos inválidos e a rota de publicação existente. A imagem passa por tamanho, hash, MIME, quadro 512x512 e nova consulta de autor e descritor, inclusive quando o objeto original muda durante a leitura. Há regressão de avatar JPEG e WebP em `/p/@nome/imagem`.

O caso privado chama `Seeder.prototype.linkPublic` com dependências falsas: uma raiz privada tem um nome selado disponível na fixture, mas recebe o mesmo corpo de uma chave desconhecida. Tornar a raiz pública comprova que a fixture chega à regra de visibilidade. Os limites são conferidos antes da consulta; páginas e imagens compartilham só o orçamento de links. Uma consulta pendente continua ocupando a vaga depois da resposta por prazo esgotado.

## Execução local

Ambiente: Node.js v26.12.1, sandbox sem permissão para abrir sockets, inclusive em `127.0.0.1`.

- `XDG_CACHE_HOME=/tmp/t22-standard-cache npx --no-install standard apps/cli/lib/seed-ws.js apps/cli/test/seed-ws-link.test.js`: passou, saída 0. A primeira tentativa sem `XDG_CACHE_HOME` falhou ao gravar o cache em `~/.cache/standard`, com `EPERM`; nenhum diagnóstico de estilo.
- `node apps/cli/test/link-page.test.js`: `# tests = 11/11 pass`, `# asserts = 876/876 pass`.
- `node apps/cli/test/seed-ws-link.test.js`: saída 1, `Error: listen EPERM: operation not permitted 127.0.0.1`. A suíte HTTP não chegou às asserções.
- `node apps/cli/test/seeder-post-http.test.js`: saída 1, `Error: operation not permitted`, `code: 'EPERM'`, em `UDXSocket.bind` na DHT local.
- Todos os 34 arquivos encontrados por `git grep -l seed-ws -- 'apps/cli/test/*'` antes da criação do teste novo foram executados individualmente com `node`, em lote de quatro processos. Todos terminaram com saída 1 por `EPERM` ao abrir sockets. O novo arquivo também foi executado nesse lote. Uma segunda passagem sequencial, sem concorrência entre arquivos, confirmou o mesmo `EPERM` nos 35 arquivos. Não se atribui essas falhas à mudança.

Os 34 arquivos existentes são:

```text
account-pages-delegate.test.js
account-pages-groups.test.js
account-pages-notices.test.js
account-pages.test.js
ai-e2e.test.js
ai-post-route.test.js
ai-read-post.test.js
blob-seeder.test.js
deletion-roteiro.test.js
load-ws.test.js
moderation-e2e.test.js
page-cli.test.js
pages-choice.test.js
pages-delegate.test.js
pages-dm.test.js
pages-groups-parity.test.js
pages-groups-private.test.js
pages-groups-sparse.test.js
pages-groups.test.js
pages-lifecycle.test.js
pages-listing-rate.test.js
pages-listing.test.js
pages-media.test.js
pages-moment.test.js
pages-notices.test.js
pages-share.test.js
pages-writer.test.js
seed-ws-address.test.js
seed-ws-discovery.test.js
seed-ws-drain.test.js
seed-ws.test.js
seeder-feira-http.test.js
seeder-index.test.js
seeder-post-http.test.js
```

Um ensaio adicional substituiu somente o transporte HTTP por eventos em memória, com um preload temporário fora do repositório: `seed-ws-link.test.js` passou com `# tests = 9/9 pass` e `# asserts = 362/362 pass`. Isso confere os handlers e as fixtures, mas não substitui o teste com sockets. Na mesma simulação, três mutações em memória foram detectadas, sem editar os arquivos de implementação: remover a regra de raiz privada falhou no teste 3 (358/362 asserções passaram); remover a conferência do quadro falhou no teste 5 (358/362); remover a comparação de autor e descritor falhou no teste 6 (342/362). Cada mutação terminou com saída 1.

Pendentes para o orquestrador fora do sandbox: os 35 testes com sockets, incluindo o teste novo e `seeder-post-http.test.js`. Não foram executados `npm install`, `npm test`, `npm run demo`, build móvel, deploy ou comandos de publicação.

## Staging, sem execução nesta tarefa

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

Esperado: o robô recebe 200 com a prévia correta, `no-store` e `noindex`; o navegador recebe `index.html`, com `no-cache`, e cada `cmp` termina com saída 0. A imagem disponível responde 200, `image/jpeg` ou `image/webp`, `nosniff`, `no-store` e tamanho exato. Conferir também o CSP recebido através do proxy. Repetir com `TelegramBot` e com `?origem=teste` na página para conferir a preservação da query. A imagem com query deve ser 404. Respeitar a janela do limite do Caddy entre rodadas.

Com uma fixture de grupo privado e uma chave desconhecida, comparar os corpos de `/p/g/<privado>` e `/p/g/<desconhecido>` com `cmp`: ambos 200 e idênticos, sem o nome selado; `/imagem` é 404. O crawler no caminho público correspondente recebe o mesmo resultado. Com a origem de posts desligada em uma instalação de staging separada, os quatro tipos são genéricos, sem `og:image` ou `og:url`, e as quatro imagens são 404. Conferir ainda `/p/<diário>/<seq>` de uma publicação compartilhada: continua servindo a página da publicação.
