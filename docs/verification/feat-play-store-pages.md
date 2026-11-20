# Páginas da ficha do Google Play (branch feat/play-store-pages)

Só site e texto da ficha. Sem mudança de RPC, formato ou Termos. As páginas `excluir-conta` e `seguranca-infantil` são geradas por `apps/site/scripts/render-legal.js`, que cita parágrafos do `legal.js` (versão 108) por prefixo exato e falha se um sumir ou se repetir.

## O que mudou

- Merge de `origin/main` (51e5f404) na branch. Conflitos em `render-legal.js` (mantidas as páginas de informação, tomada a frase nova de `main`) e em `index.html` (tomado `main`, com os dois links do rodapé recolocados à mão). `termos/` e `privacidade/` foram regerados.
- Prefixo de retenção que não achava mais nada na versão 108 trocado por "Ao excluir a conta, o número do celular lacrado".
- Excluir conta: caminho com passkey, caminho sem passkey (o SMS só registra o pedido, a pessoa escreve para contato@varanda.app e a equipe confirma antes de a exclusão ser agendada), retenção e limites P2P citados do `legal.js`. Sem a passkey, a página cobre o aparelho perdido (passkey sincronizada ou código de recuperação), o número recuperado na operadora, a conta do Google (e-mail da conta) e o caso sem nada que prove a conta, sem inventar procedimento além dos Termos.
- `play-screens.test.js` falha quando falta uma das quatro capturas (antes passava com a pasta vazia).
- Segurança infantil: proibições, denúncia e parágrafo de Contato, sem prometer nada além dos Termos.
- `apps/site/artwork/play/listing.pt-BR.json` e `apps/site/test/play-listing.test.js` (30, 80 e 4000 caracteres, URLs https://varanda.app/, sem travessão).
- Orçamento de tamanho de `public/` em `site.test.js` subiu de 837000 para 1058000 bytes (medido 846273 depois do merge e das duas páginas).

## Testes

- [x] `node apps/site/scripts/render-legal.js --check`
- [x] legal, site, brand, calcada, play-screens e play-listing, cada um sozinho
- [x] `npx standard` nos arquivos .js mudados
- [x] `npm run lint` e `npm run demo` (termina com "DEMO OK")

A suíte completa roda na CI do GitHub do PR.

## Para o dono conferir antes de declarar conformidade no Console

Procedimentos operacionais que a página de segurança infantil não afirma e que a associação precisa confirmar:

- [ ] Quem recebe as denúncias de conteúdo ilegal, em que prazo decide e quem é a pessoa de contato
- [ ] O que é feito com material de abuso sexual infantil achado ou denunciado: retirada, preservação e comunicação às autoridades competentes e à SaferNet
- [ ] Que o endereço contato@varanda.app é lido e respondido
- [ ] Que o prazo de 7 dias para o diário sair dos semeadores, citado nos Termos, é cumprido
- [ ] Que o pedido de exclusão sem passkey recebido por e-mail é verificado e confirmado pela equipe

## Conferências que faltam

- [ ] As duas páginas em 390 px de largura, num servidor local do site
- [ ] Depois do deploy do site: os três endereços respondem 200 sem entrar em conta, e o pedido de exclusão por e-mail funciona de ponta a ponta
