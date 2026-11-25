# Site: botão da App Store em destaque

Branch `feat/landing-app-store-link`.

## O que foi conferido

- `node apps/site/test/site.test.js`: o teste novo exige dois botões `botao--loja` para https://apps.apple.com/br/app/id6831662804, cada um antes do link para bora.varanda.app, a meta `apple-itunes-app` com `app-id=6831662804` e nenhuma frase "ainda não está nas lojas". Com o `index.html` da `main`, o teste falha (dois `not ok`); com a mudança, passa.
- O endereço da App Store entrou na lista de URLs permitidas do teste, só nessa forma exata, sem parâmetros.
- `node apps/site/scripts/serve.js` e o navegador do app em 375x812 e 1280x800: na abertura, o botão preto "Baixe no iPhone pela App Store" aparece antes da dobra num celular e vem antes do botão do navegador; na seção do convite, o botão do navegador virou contorno, para não competir com o da App Store.

## O que ficou de fora

- O banner do Safari (Smart App Banner) só aparece no Safari de um iPhone de verdade, depois da publicação. Não foi visto.
- No dia do lançamento (2026-11-25), a página da App Store ainda respondia 404 e a busca da Apple não achava o app: a Apple leva algumas horas para indexar. Confira que https://apps.apple.com/br/app/id6831662804 abre o app antes de aprovar o deploy do site.
- O botão usa texto, não o selo oficial "Baixar na App Store" da Apple. Trocar pelo selo é uma mudança à parte.
