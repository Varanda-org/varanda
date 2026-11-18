# Página avalia um negócio da Feira (branch feat/page-feira-rate)

## O que mudou

- `apps/cli/lib/account/pages-routes.js`: nova ação de Página `listing-rate` (`to`, `offer`, `consent`, `stars`, `text`), uma declaração assinada como `listing`. O consentimento é conferido com a chave de quem anunciou e a Página como quem avalia (`consentimento-invalido`); uma segunda avaliação da mesma oferta, apagada ou não, responde `avaliacao-enviada` (lida nos blocos crus do diário; um diário que o serviço não lê inteiro responde `indisponivel`); anúncio de quem está bloqueado responde `sem-permissao`; anúncio do membro que age, do dono, de um administrador, do diário delegado de um deles, de um convidado pendente, de quem vai receber a transferência ou de outra Página dessas pessoas (uma consulta à linha da Página que anunciou, sem varrer as Páginas) responde `avaliacao-propria`; o texto passa pela checagem de termos. `delete` recusa uma avaliação, e encerrar a Página não a apaga.
- `packages/core/lib/page-proof.js`, `packages/rpc/lib/methods.js`, `apps/app/src/pages.js`: `listing-rate` nas listas fixas e os textos `consentimento-invalido`, `avaliacao-enviada` e `avaliacao-propria`. `apps/cli/lib/account/pages-writer.js`: `readRawBlocks`, os blocos crus da Página, que falha fechado.
- `apps/app/src/feiraReview.js`: `rateCall` escolhe `listing.rate` (pessoa) ou a ação `listing-rate` (Página), com a Página como quem avalia.
- `apps/app/src/screens/Avaliar.js`: agindo como Página, lê a conversa da Página com quem anunciou e avalia pelo serviço; sem resposta, **Tentar de novo** manda os mesmos bytes assinados. `apps/app/src/screens/Mensagem.js`: a Página que fez a oferta vê **Avaliar** depois do aceite.
- `docs/protocol.md`, `docs/rpc.md`, `docs/app.md`.
- `apps/app/src/legal.js`, `packages/core/lib/terms.js`, `apps/site/public/termos/`, `apps/site/public/privacidade/`: Termos e Política versão 91, com novo aceite.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/cli/test/pages-listing-rate.test.js
node apps/cli/test/pages-listing.test.js
node apps/cli/test/pages-writer.test.js
node packages/core/test/page-proof.test.js
node packages/core/test/terms.test.js
node packages/rpc/test/methods.test.js
node apps/app/test/feiraReview.test.js
node apps/app/test/avaliarStars.test.js
node apps/app/test/mensagemRows.test.js
node apps/app/test/feiraOffer.test.js
node apps/app/test/pages.test.js
node apps/app/test/legal.test.js
node apps/app/test/platformGate.test.js
node apps/site/test/legal.test.js
```

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Precisa de uma Página e de outra pessoa com um anúncio na Feira.

- [ ] Agindo como a Página, fazer uma oferta nas Conversas da Página; quem anuncia aceita. A Página vê **Avaliar** na oferta. Pendente.
- [ ] Avaliar com estrelas e comentário: a avaliação aparece no anúncio com o nome da Página. Pendente.
- [ ] Abrir Avaliar de novo para a mesma oferta e enviar: "A página já avaliou esta oferta.". Pendente.
- [ ] Sem rede no meio do envio: aparece **Tentar de novo**, e o toque não cria uma segunda avaliação. Pendente.
- [ ] Um anúncio do dono ou de um administrador da Página, ou de outra Página deles: o serviço recusa ("Uma página não avalia anúncios de quem cuida dela."). Pendente.
- [ ] Como pessoa, Avaliar continua como antes. Pendente.

## Não verificado / limites conhecidos

- As telas têm testes de texto do código e testes de funções puras, sem teste de renderização; nada foi rodado em aparelho.
- A Página não apaga nem refaz a avaliação, como uma pessoa.
- Só a linha delegada atual de cada dono ou administrador é lida: quem aponta a delegação para um segundo diário certificado deixa de ter o primeiro contado, e a Página pode então avaliar um anúncio desse primeiro diário.
- Um bloco de avaliação apagado com uma chave vazada (diário de Página pausada) é contado pelo teste com um bloco cru injetado, não por um diário de fato bifurcado; o caminho de núcleo bifurcado ou estado perdido de `readRawBlocks` não tem teste próprio.
