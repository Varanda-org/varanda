# @varanda/site

O site estático do Varanda (varanda.app). Pacote privado do monorepo, sem JavaScript na página, sem formulários, sem cookies e sem rastreadores. Os botões principais abrem https://bora.varanda.app/, e o teste só permite varanda.app, a raiz de bora.varanda.app e o repositório no GitHub como URLs absolutas.

- `public/`: a raiz publicável. Só esta pasta vai para a GitHub Pages.
- `artwork/`: as fontes do logotipo, `og.html` (a imagem de compartilhamento), `app-design.md` (o desenho novo do app) e `screens.md` (a receita para capturar as telas do app que a página mostra). Nunca são publicadas.
- `scripts/`: `serve.js` (servidor local), `render-assets.js` (gera ícones, abertura e favicons a partir do logotipo) e `render-legal.js` (gera as páginas de termos e privacidade a partir do texto do app).

```sh
npm run dev -w apps/site
```

Abre em http://127.0.0.1:4173/. Para ver como ficará em https://varanda-org.github.io/varanda/, use `node apps/site/scripts/serve.js --prefix /varanda`.

Para regenerar os ícones: `node apps/site/scripts/render-assets.js` (precisa de `rsvg-convert`: `brew install librsvg`); com `--check` só verifica. O `cwebp` (`brew install webp`) só serve para a receita de capturas em `artwork/screens.md`.

## A página

A página é a porta de entrada de quem chega do Instagram pelo celular. O título de campanha é "A internet também merece uma varanda.", e a assinatura do fecho e do rodapé é "A conversa merece uma varanda.".

Os dois botões, "Conheça a Varanda" (abertura, `cta-inicio`) e "Quero conhecer a Varanda" (seção `#gente`, `cta-gente`), abrem exatamente https://bora.varanda.app/ na mesma aba. Junto de cada um há a frase "Vagas limitadas nesta abertura.": se a rede estiver cheia, o app avisa durante a entrada e dá para tentar de novo em alguns dias. A frase não promete lista de espera nem aviso posterior, e a página não consulta o teto de contas da instalação. A abertura também traz a nota "Abriu pelo Instagram? Se a entrada não funcionar, abra o link no Chrome ou no Safari.".

O conteúdo técnico, inclusive o que conferir e como publicar, está em [docs/site.md](../../docs/site.md). O desenho do app segue em [artwork/app-design.md](artwork/app-design.md), e a receita para capturar o app de verdade está em [artwork/screens.md](artwork/screens.md). A página mostra quatro capturas reais do app em modo Vitrine (dados fictícios), em `public/assets/screens/`, feitas com a receita de `artwork/screens.md`.

## Termos e privacidade

`public/termos/index.html` (https://varanda.app/termos/) e `public/privacidade/index.html` (https://varanda.app/privacidade/) publicam os Termos de Uso e a Política de Privacidade que o app apresenta para aceite, com a versão, a data e a nota de revisão jurídica. A segunda serve de endereço da política de privacidade nas lojas de aplicativos. O texto vem só de `apps/app/src/legal.js`: as duas páginas são geradas e nunca se editam à mão.

```sh
node apps/site/scripts/render-legal.js          # regenera as duas páginas
node apps/site/scripts/render-legal.js --check  # verifica sem gravar
```

Mudou `legal.js` (a cada nova versão dos Termos), rode o script no mesmo PR: `test/legal.test.js` falha enquanto as páginas não batem com o texto do app. O aceite continua no app; a página só mostra o texto. A seção `#privacidade` da página inicial trata só da visita ao site.

## Imagem de compartilhamento

`public/assets/og-varanda.jpg` (1200x630) é a imagem que o WhatsApp, o Telegram, o X e o iMessage mostram quando alguém cola https://varanda.app. Ela sai de `artwork/og.html`, que não usa fonte nenhuma: o único lettering é o VARANDA desenhado do logotipo, e o telefone mostra um esqueleto do feed novo (avatares, barras no lugar do texto, as abas e o botão de publicar), sem letra. Para refazer (no macOS, com o Google Chrome instalado), a partir da raiz do repositório:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 --screenshot=/tmp/og-varanda.png file://$PWD/apps/site/artwork/og.html
sips -s format jpeg -s formatOptions 99 /tmp/og-varanda.png --out apps/site/public/assets/og-varanda.jpg
```

Confira com `sips -g pixelWidth -g pixelHeight` que o PNG saiu com 1200x630 (algumas versões do Chrome acrescentam uns pixels) e que o JPEG não passa de 200 KB; se passar, baixe a qualidade. A saída do Chrome varia entre versões, por isso o JPEG não é verificado por `render-assets.js --check`.

Documentação completa, inclusive os passos de domínio e DNS: [docs/site.md](../../docs/site.md).
