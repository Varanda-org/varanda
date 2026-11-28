# Site: botão do Google Play

Branch `feat/landing-play-store-link`.

## O que foi conferido

- `node apps/site/test/site.test.js`: o teste novo exige dois botões `botao--loja` para https://play.google.com/store/apps/details?id=app.varanda (`cta-play-inicio`, `cta-play-gente`), cada um depois do botão da App Store e antes do link para bora.varanda.app, com `aria-describedby` válido, e nenhuma frase "não está na Google Play". Com o `index.html` da `main`, o teste falha (`not ok 9`); com a mudança, passa.
- O endereço do Google Play entrou na lista de URLs permitidas do teste, só nessa forma exata.
- Em 2026-11-27, https://play.google.com/store/apps/details?id=app.varanda respondeu 200.
- `node apps/site/scripts/serve.js` e o navegador do app em 375x812 e 1280x800: num celular, os botões ficam em coluna (App Store, Google Play, navegador), os dois de loja antes da dobra; no computador, os dois botões de loja lado a lado e o link do navegador embaixo, na abertura e na seção do convite.

## O que ficou de fora

- O botão usa texto, não o selo oficial "Disponível no Google Play". Trocar pelos selos oficiais é uma mudança à parte.
- Não há banner de instalação do Google Play para sites, como o da Apple no Safari.
