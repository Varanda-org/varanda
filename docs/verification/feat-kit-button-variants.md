# Variantes de botão do kit (feat/kit-button-variants)

A entrada **Pílula com ícone** em `apps/site/artwork/app-design.md` ganha a tabela das variantes lidas do kit:

- fraca (`weak`): fundo `accentSoft`, texto e ícone `accent`, preenchimento da cheia (9,5 pt na vertical e 17 pt na horizontal). Seguir e Seguir de volta (`FollowPill`).
- link (`link`): sem fundo e sem contorno, texto e ícone `accent`, 12 pt nas laterais (`space.md`), alvo de pelo menos 44 pt, também com `small`. O `StepLink` usa essa variante: Pular por enquanto, Voltar em Anunciar, Reenviar código, Trocar número e Excluir conta sem a passkey.
- neutra fraca (Neutral Weak): a prop continua `tonal`, fundo `inputOff` e texto `soft`. Seguindo.
- perigo fraca (Error Weak): `danger` com `tonal`, fundo `dangerSoft`, texto e ícone `danger`, sem contorno. São três pílulas: Apagar versão (lixeira, só ícone, em Versões do perfil), denunciar o tópico e denunciar a resposta. O perigo sem `tonal` continua o contorno de 1,5 pt.
- só ícone: círculo de 44 pt (36 pt com `small`); glifo de 18 pt no padrão e 16 pt com `small`, o mesmo tamanho do ícone ao lado de um rótulo.
- carregando (`pending`): spinner pequeno centrado, na cor do rótulo. O rótulo fica com opacidade 0, sem reticências, e a face guarda o tamanho. O controle fica desligado (opacidade 0,45) e anuncia `busy` (na web, `aria-busy`); o spinner fica fora da árvore de acessibilidade (na web, `aria-hidden`). Vale na `Pill` e no `Btn`.

Não foram lidos no kit: Filled e Outline de Neutral e de Error, as camadas do anel de foco e o encaixe de ícone `md`. Nada disso entrou no app.

Só números e medidas. Nenhum arquivo, imagem ou ícone do kit de referência entrou no repositório. Os ícones continuam Feather, por `ui/Icon.js`.

## Testes

- [x] `npm run lint` passou.
- [x] Os 46 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles buttonVariants, uiKit, a11yCompose, followPill, feiraCompose, forum, passkeysScreen, phone, phoneEntry, profileActions e profileSave.
- [x] Sem `aria-busy` na face e sem `aria-hidden` no spinner, os pins novos de buttonVariants falham (601 de 677 asserções passam), como esperado.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## Conferência visual

Nada foi aberto no aparelho nem no navegador. Em cada item, conferir no tema claro e no escuro e com o texto do sistema bem grande.

- [ ] Seguir no Membro, em Seguindo, na Espiadinha e na Busca, e Seguir de volta em Avisos: fundo verde claro, texto verde, sem contorno. Seguindo continua no campo desligado, com texto suave.
- [ ] Links dos passos, sem fundo e sem contorno, texto verde, alvo de 44 pt: Pular por enquanto no perfil, Voltar em Anunciar, Reenviar código e Trocar número no passo Telefone, Excluir conta sem a passkey.
- [ ] As três pílulas de perigo, fundo suave e sem contorno: a lixeira Apagar versão, Denunciar no tópico e Denunciar na resposta. Uma pílula de perigo sem o tom (Remover foto) continua com contorno.
- [ ] Botões e pílulas ocupados: spinner na cor do rótulo, o tamanho de antes, o rótulo sem reticências, e o leitor de tela anunciando ocupado. No cheio, no contorno, no perigo, no compacto e no grande.
- [ ] Android (build de debug), simulador iOS, web e PWA, a 320 px e a 1280 px.
