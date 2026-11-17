# Páginas no laboratório hospedado (branch chore/lab-paginas)

Parte da #352. Só ferramenta de desenvolvimento: muda `apps/cli/scripts/hosted-lab.js`, exporta de `apps/cli/lib/commands/account.js` as funções que abrem os clientes de Páginas (o laboratório os abre como o serviço) e atualiza `docs/development.md`. Nada muda no serviço de produção, no app, no protocolo, no RPC ou nos Termos.

- **Páginas ligadas.** `GET /account/pages/policy` responde `{ available: true }`. O `VARANDA_PAGE_KEYS` é sorteado a cada execução, fica só na memória do processo e nunca é impresso; as Páginas somem com os dados do laboratório (Ctrl-C).
- **Fotos e voz nas Conversas.** O semeador do laboratório ganha `blobPostage` (o pool de pedaços cifrados e o selo deles), e o laboratório manda `/blob/*` e `/f/*` ao semeador, como `varanda seed` e o `deploy/seeder/Caddyfile`. Sem isso, a primeira foto falhava com "Sem conexão agora".
- **Códigos de recuperação.** O serviço de conta do laboratório abre a loja `recovery.json`. Um código criado em Ajustes › Passkeys e recuperação abre a mesma conta num segundo perfil do Chrome, que vira o segundo aparelho da pessoa. Antes, a tela respondia "serviço indisponível".

Como verificar, a partir da raiz:

- `node apps/cli/test/hosted-lab.test.js`: o teste do laboratório no ar confere `/account/pages/policy`, o caminho `/blob/` até o semeador e `/account/recovery/fetch` com uma entrada desconhecida, que responde 404 `{ error: 'nao-encontrado', recovery: true }` da própria loja. Sem a loja, as duas asserções de recuperação falham; com ela, o arquivo passa inteiro. `routeOf` cobre `/blob/` e `/f/`.
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

## Caminhadas na web feitas com este laboratório (2026-11-17)

Decisão do Rodrigo (17/11): as caminhadas de Páginas vão na web, no laboratório, com Chrome headless, um processo por pessoa e passkey virtual com PRF, 412x915. Android e iOS continuam devidos (build de preview do EAS). Interface: export web de `075476f`. A = Ana (dona), B = Bia (admin), C = Caio, D = Davi. As capturas ficam fora do git, em `~/Workspace/evidencias/chore-lab-paginas/`.

- [x] #669, marcas de Página na busca: a linha de "Padaria" diz "Página"; aberta, mostra "Página" e "Anúncios" desde o primeiro quadro, nunca o perfil de pessoa. Uma pessoa não tem a marca.
- [x] #690, Avisos vazios da Página: "Nenhum aviso da página ainda. Quando alguém seguir a página, comentar, citar, mencionar o @nome dela, curtir ou republicar uma publicação dela, aparece aqui."
- [x] §148, Conversas da Página: o pedido de C chega aos Pedidos dos dois admins; B aceita e responde; C vê a resposta como "Padaria do Lab", nunca como "Bia Admin"; o aparelho da dona arquiva o aceite e a resposta. Depois de remover um admin, ele não envia mais (aviso de chave diferente) e não recebe o que chega depois; guarda o histórico que já tinha.
- [x] #704, mídia numa conversa da Página: num pedido, foto e voz esperam um toque; a foto abre e a voz toca; depois de aceitar, as fotos carregam sozinhas.
- [x] #697, encaminhar como Página: texto encaminhado; foto com legenda leva só a legenda, com o aviso da folha; foto sozinha não oferece "Encaminhar"; C vê "Encaminhada".
- [x] Troca de chave vista por quem fica: um admin que fica guarda a chave nova sem passo seu; depois que a dona remove outro admin, os que estão nas Conversas da Página veem "A chave publicada da página não é a deste aparelho" antes de qualquer envio, e "ler a chave de novo" tira o aviso.
- [x] #708, mudar a chave com Conversas ativas: as conversas da chave antiga ficam no chip "Chave antiga", só para ler, sem campo de envio, com "Copiar" como única ação; foto abre e voz toca; o chip continua depois de reabrir Páginas; quem segue vê "mudou de chave" e já segue a chave nova; uma mensagem para a chave nova chega aos dois admins.
- [x] Encerrar com Conversas ativas: no aparelho da dona a caixa some das Conversas.
- [x] Segundo aparelho por código de recuperação: B cria o código; o segundo perfil entra com ele, cria uma passkey nova, lista a Página e abre as Conversas dela sem "Ativar"; uma mensagem de C chega a ele em cerca de 1 min.
- [x] Admin removido, no segundo aparelho: ao abrir Páginas, a Página some.
- [ ] §149, grupo privado como Página: parou antes de entrar. A Página abre o "Geral" pela busca, mas "Entrar como a página" responde "Serviço indisponível": o serviço recusa `fora-da-comunidade` (a Página ainda não está na comunidade), o app não tem texto para isso e, ao contrário da pessoa, não abre a comunidade antes. Correção num PR seguinte da #352.
- [ ] Miniatura de anúncio numa conversa da Página: a Feira fica fechada no laboratório (coberto por `page-dm-media-e2e.test.js`).
- [ ] Encaminhar só para conversas da Página e "Carregar mais": pediriam conversas pessoais e mais de quatro páginas de lista (coberto por `forwardSheet.test.js`).

Achados para um PR seguinte da #352 (vistos em todas as rodadas):

- O cartão do topo das Conversas da Página mostra "ocupado" e "tentar de novo" cru quando as vagas de leitura estão ocupadas.
- Nomes: em Ajustes da página, cada aparelho só nomeia a própria linha, as outras dizem "sem nome", e a confirmação diz "Remover sem nome da administração da página?" (a dona removeu o admin errado numa rodada). A Página perde o nome ("Sem @nome ainda.") depois de remover um admin; linhas sem nome em Páginas logo depois de criar ou aceitar; "Pessoa" nas linhas de pedido; a confirmação de encerrar não cita o @nome.
- Depois de encerrar a Página, ou de perder o papel nela, o aparelho continua agindo como ela até recarregar.
