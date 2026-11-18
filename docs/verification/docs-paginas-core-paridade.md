# Páginas: fechamento da #352 (branch docs/paginas-core-paridade)

Parte da #352 (PR 10, só documentação). Corrige as seções 85 a 90 de `docs/verification.md` no que ficou falso ou incompleto com os PRs da #352 e junta, num lugar só, o estado de cada item. Sem código, sem teste novo, sem mudança de formato, RPC ou Termos.

## O que este PR conferiu

- As seções 85, 86, 87, 88, 89 e 90 de `docs/verification.md`, uma a uma, contra os arquivos `docs/changelog/` e `docs/verification/` dos PRs mergeados e das branches abertas da #352, e contra `apps/app/src/pageGate.js` (o app liga as Páginas num nó core só com `accountOrigin` https e alcance da origem).
- Correções: seção 85 (item 8 e o último limite), seção 86 (item 6), seção 87 (itens 13 a 16 e um limite), seção 88 (dois limites e uma nota sobre os avatares), seção 89 (o limite aceito dividido e atualizado) e seção 90 (limite novo). Todas as checagens humanas continuam "a fazer".
- `README.md`: nada alterado. A seção "Páginas" não tem afirmação que continue falsa depois de todos os PRs e que nenhum deles corrija.
- Não foi rodado nada em navegador, aparelho nem serviço de conta pelo agente.

## Itens da #352

Fontes: #332, #333, #334, #440, #441, #398, #364, #384, #411 e a paridade do nó core. "Aberta" é branch ainda não mergeada (citada pelo nome). Estados: feito, limite aceito, pendente.

| Fonte | Item | PR | Estado | Verificado em |
|---|---|---|---|---|
| #332 | CPU de chave de página vazada, nova baixa de réplica de par parado no core, `diary.peek` do navegador com lápide | #684 | feito | `docs/verification/fix-paginas-chave-vazada.md` |
| #333 | CORS do `varanda-serve` na web | nenhum | limite aceito | seção 89 |
| #333 | Nonce durável de `group-post` e `group-seal` | #685 | feito | `docs/verification/fix-paginas-servico-duravel.md` |
| #333 | Teto de 2 encerramentos ou mudanças por 24 h gravado em `pages.json` | #685 | feito | seção 87 item 12, `docs/verification/fix-paginas-servico-duravel.md` |
| #333 | Limites por minuto na memória | #685 | limite aceito | seções 87 e 88 |
| #333 | Cópia de segurança de `VARANDA_PAGE_KEYS` | #685 | feito (aviso no README) | `docs/verification/fix-paginas-servico-duravel.md` |
| #334 | Avisos da página com curtidas e republicações | já no canal `notices/3` | feito | seção 88 |
| #334 | Texto de Avisos vazios da página | #690 | feito | seção 88, `docs/verification/fix-paginas-app-chaves.md` |
| #334 | Conversas depois de uma mudança de chave (threads da chave antiga só leitura) | #708 | feito | `docs/verification/fix-paginas-conversas-antigas.md`, seção 148 |
| #334 | Marca de página no resultado da Busca | #669 | feito | PR #669 |
| #334 | Avisos, Conversas e comunidades como a página no nó core | #780, #791, #792, #793 | feito, menos a lista de Comunidades e os ajustes do grupo (Fica de fora) | linhas de paridade abaixo |
| #440 | Aviso de chave diferente ao abrir as Conversas | #690 | feito | seção 87 item 14, `docs/verification/fix-paginas-app-chaves.md` |
| #440 | `dm.pageForget` depois de encerrar ou remover | #690 | feito | seção 87 item 13 |
| #440 | Perfil levado para a chave nova na mudança | #746 | feito | seção 87 item 16, `docs/verification/fix-paginas-mudanca-perfil.md` |
| #440 | Administrador removido esquece a chave antiga | #765 | feito | seção 87 item 15, `docs/verification/fix-paginas-removido-chave-antiga.md` |
| #440 | Caminhada da seção 148 | aparelhos | pendente | seção 148 (a fazer, #224) |
| #441 | Caminhada da seção 149 | aparelhos | pendente | seção 149 (a fazer, #224) |
| #441 | Grupos da página achados pelo semeador, ponta a ponta | #712 | feito | `docs/verification/test-paginas-raizes-grupo.md` |
| #398 | Janela de espiadas dos Avisos da página | app, `useRowAvatars` nos Avisos | feito | seção 88 |
| #364 | Selo e filtro da seção 102 nas dicas do semeador | nenhum | limite aceito | seção 102 |
| #384 | Encaminhar como a página e "Carregar mais" | #697 | feito | `docs/verification/fix-paginas-encaminhar.md` |
| #411 | Miniatura do cartão de anúncio (seção 132) | #704 | feito | `docs/verification/fix-paginas-midia-conversa.md` |
| Caminhadas | Páginas ligadas no laboratório hospedado (web) | #730 | feito | `docs/verification/chore-lab-paginas.md` |
| Caminhadas | Correções achadas nelas (estado de agir, nomes, entrar na comunidade) | #745, #740, #743 | feito | `docs/verification/fix-paginas-agir-estado.md`, `fix-paginas-nomes.md`, `fix-paginas-entrar-comunidade.md` |
| Paridade | Motor das Conversas aceita a identidade por leitores | #754 | feito | `docs/verification/refactor-dm-engine-identity.md` |
| Paridade | Prova de carimbo assinada pelo assinante do diário do core | #760 | feito | `docs/verification/feat-diary-signer-proof.md` |
| Paridade | Caixa assinada do delegado core (`actor-box`) | #771 | feito | `docs/verification/feat-page-actor-box.md` |
| Paridade | Inner v9 de Conversas lido de um diário de manifesto | #774 | feito | `docs/verification/feat-dm-inner-v9.md` |
| Paridade | Conversas como a página no nó core, só texto | #780 | feito | `docs/verification/feat-core-conversas-pagina.md` |
| Paridade | Grupos privados como a página no nó core | #793 | feito | `docs/verification/feat-core-pagina-grupos-privados.md` |
| Paridade | App num nó core: Conversas, Avisos, grupo como a página, remover administrador, mudar a chave, mídia recebida | #792 | feito | `docs/verification/feat-app-paginas-no-core.md` |
| Paridade | CLI `page dm-list`, `dm-read`, `dm-reply` | #791 | feito | `docs/verification/feat-cli-page-dm.md` |
| Paridade | Conversas pessoais no nó core | #790 (rascunho, espera a versão hospedada que leva a #774) | pendente | `docs/verification/feat-core-conversas-pessoais.md` |
| Paridade | Interface web do `varanda-serve` sem Páginas (CORS) | nenhum | limite aceito | seção 89 |
| Paridade | `dm.reportSign` recusado no core (denunciar só no navegador) | nenhum | limite aceito | seção 85 |
| Paridade | Envio de mídia como a página no core só texto | nenhum | limite aceito | seção 85 |
| Paridade | Semente das Conversas: só aviso no README, sem cópia | nenhum | limite aceito | seção 89 |
| Paridade | Dono só de nó core permitido, só texto | nenhum | limite aceito | seção 89 |

Contagem: 27 feito, 3 pendente, 8 limite aceito (38 linhas). Este PR entra depois de #780, #791, #792 e #793; a #790 e as duas caminhadas de aparelho seguem pendentes.

## Fica de fora

- A lista de Comunidades e a tela de ajustes do grupo (`apps/app/src/screens/Comunidade.js`, `GrupoAjustes.js`) ainda usam leituras só do nó hospedado num nó core: nenhum PR da #352 as moveu para o motor do core.
- Conversas pessoais no nó core: a #790 (rascunho) espera a versão hospedada (web e app) que leva a #774; até lá, é pendente.
- Todas as caminhadas em Android, iOS e aparelho ficam a fazer, acompanhadas na #224. A web hospedada foi caminhada no laboratório (#730), sem passkey de produção.
- O caminho `actor-box` de ponta a ponta pelo serviço de conta real não tem teste: no teste da #780, a resposta de `dm.actorBox` vai direto para o dono, e o lado do serviço foi testado na #771.

## Não verificado

- Nenhuma checagem humana das seções 84 a 90 foi rodada: todas seguem "a fazer", em Android (build de debug) e simulador iOS primeiro, depois web e PWA (veja a #224).
- O estado dos PRs da paridade vem dos arquivos de verificação deles; este PR não rodou o código deles.
- Este PR só entra depois de #780, #791, #792 e #793; se um deles mudar antes, as linhas acima precisam do mesmo ajuste.
