# Origem de mídia opcional (CDN) no app

Branch `feat/cdn-ready-app`. Desligada por padrão: sem `media` no `/varanda.json`, o app pede tudo à instalação, como antes. O texto para quem opera, com o que a borda enxerga e a dependência dos Termos (Stack B), está em `docs/cdn.md`.

## O que foi conferido

| Área | Como | Resultado |
|---|---|---|
| Chave `media` e origem de mídia em memória (`installation.js`, `config.js`, `configStore.*`) | `node apps/app/test/installation.test.js`, `config.test.js`, `discoverHosted.test.js`, `configStoreWeb.test.js`, `installationStore.test.js` | passam (256 asserções em `installation`; 16, 8, 8 e 28 testes nos outros) |
| Busca verificada (`apps/app/src/media/fetch.js`) | `node apps/app/test/mediaFetch.test.js` | 29 de 29 testes, 369 asserções |
| Service worker e CSP da página guardada (`scripts/sw.js`, `scripts/finish-web.js`) | `node apps/app/test/sw.test.js`, `webnodeHandle.test.js` | 129 de 129 e 15 de 15 |
| Estilo | `npx standard` nos arquivos alterados | sem avisos |

## Revisão de segurança (correções)

- **Borda parada.** A tentativa na borda, e só ela, tem prazo que cobre cabeçalhos e corpo (8 s mais 1 s por 128 KiB). Vencido o prazo, o pedido é abortado e a instalação é tentada uma vez. Teste com `fetch` que nunca responde e com corpo que pinga: os dois caem na instalação em 2 pedidos; cancelamento do chamador durante a espera não faz o segundo pedido.
- **Validador de tempo de execução.** `validMediaOrigin` exige a mesma regex do build e do service worker (nomes DNS ASCII em minúsculas, porta de 1 a 65535) e recusa IP v4, IPv6 entre colchetes e `localhost`. O teste roda com o parser nativo e com um parser frouxo que mantém caracteres não ASCII, espaço de largura zero e hífen suave; sem a regex, o teste falha.
- **CSP.** O service worker acrescenta a origem só a `connect-src` (a borda só é alcançada por `fetch()`; os bytes aparecem por `blob:`). `sw.test.js` confere que `img-src`, `media-src`, `default-src` e `frame-src` continuam sem a origem. A CSP do `Caddyfile` deve trazer a mesma única adição (paridade byte a byte).
- **Retenção na borda.** `docs/cdn.md` descreve que a borda guarda cópias depois que a instalação deixa de servir, o `s-maxage=60` enviado pelo deploy, a obrigação de honrá-lo e de limpar em bloqueio ou remoção, e que o semeador não registra caminhos nem endereços mas a borda registra. Isso entra no texto dos Termos e da LGPD da Stack B.
- **Corrida de respostas.** Cada resposta ao vivo do `/varanda.json` (com ou sem `media`) é aplicada se for mais nova que a última aplicada, mesmo que uma descoberta mais nova tenha falhado por transporte no meio; uma resposta mais antiga nunca desfaz uma mais nova, e a de outra instalação nunca é aplicada. Testes na web (`installation.test.js`) e no nativo (`installationStore.test.js`); sem a correção, falham.
- **Mesma origem.** `hostedConfigOf` descarta `media` igual à origem da própria página (`config.test.js`, `discoverHosted.test.js`).

## Busca verificada, em `mediaFetch.test.js`

- Com origem de mídia, `mediaUrl` é absoluta nela; com `chat` (qualquer valor verdadeiro) ou `installation: true`, fica na instalação; sem a origem, como antes.
- O pedido vai à origem de mídia com `method: 'GET'`, `credentials: 'omit'` e `redirect: 'error'`.
- Hash errado vindo da borda nunca vira bytes entregues: com a instalação honesta, entrega os bytes certos depois de uma só chamada extra; com as duas erradas, falha com `conteúdo não confere` e faz exatamente 2 pedidos.
- Falha da borda (rede, 500, 404, redirecionamento seguido, resposta de outra origem, `Content-Length` acima do descritor, corpo curto) cai na instalação uma única vez; com as duas falhando, 2 pedidos e o erro da instalação decide se é repetível.
- Itens de conversa (foto e nota de voz) pedem só à instalação, e uma falha não é repetida.
- Origem de mídia igual à instalação faz um pedido só; chamador já cancelado não faz nenhum, e cancelado no meio não dispara o segundo.
- `fetchVideo` usa a borda, mantém `cache: 'no-store'`, cai uma vez e recusa bytes adulterados.
- Regressão: trocando em memória a regra "chat nunca usa a borda", 2 testes falham; sem a troca, todos passam.

## Fora do que foi conferido

- Nenhuma CDN real, nenhum navegador, nenhum aparelho: os testes injetam `fetch`. A regra de CORS, a CSP do deploy e o `Caddyfile` não são exercitados aqui.
- A mudança de Termos e de privacidade (Stack B) não está neste PR. Sem ela, a chave não deve ser publicada.
