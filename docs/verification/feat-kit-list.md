# Linha de lista, grupo e divisória

Três peças novas em `apps/app/src/ui`: `ListRow` e `ListGroup` (`ListRow.js`) e `Divider` (`Divider.js`). As medidas estão em `apps/site/artwork/app-design.md`.

A linha tem no mínimo 48 pt, ou 76 pt com legenda, 16 pt nas laterais e 12 pt de vão, com o ícone de 22 pt numa área de 40 × 40 pt. À direita, uma seta, um texto ou a marca de escolha. Uma linha de escolha (opção, chave ou caixa) sempre mostra a marca e anuncia se está marcada, mesmo sem `checked`; um botão nunca mostra a marca. O nome que o leitor de tela ouve junta o rótulo, a legenda e o texto à direita, salvo quando quem chama passa outro. Na web, a linha de escolha aciona com a barra de espaço uma vez, mesmo com a tecla segurada. Desligada ou esperando, a linha não aceita toque e fica a 0,45.

A divisória é um fio de 1 pt na cor do fio, escondido do leitor de tela. Com rótulo, dois fios ladeiam o texto.

Onde entra:

- Ajustes: as linhas e os grupos usam `ListRow` e `ListGroup`. Os grupos mantêm os 12 pt de margem embaixo. As linhas deixam de passar só o rótulo como nome, então o leitor de tela ouve o valor à direita (Aparência, Visitas, avisos do aparelho). A chave de prévia de links fica depois de uma `Divider`.
- `OptionList` e `OptionRow` (Outras formas de entrar, Termos antes de entrar): `ListGroup` e `ListRow`. A linha passa de 52 pt para 48 pt.
- Termos e privacidade, Recados ("Quem pode deixar recado"), Denunciar (motivos) e as versões do perfil: o fio entre itens vira `Divider`.
- Diário: os atalhos Salvos, Eventos, Visitas, Recados e Varandinha ficam num só `ListGroup`, com 16 pt de margem nas laterais.
- Busca: o título "Buscas recentes" é um `SectionHeader` com "Limpar" como link; cada busca é um `ListRow` com o ícone de relógio, e "remover" é uma pílula de link à parte.
- Mensagem e Grupo: a marca "Mensagens novas" é uma `Divider` com rótulo, dentro da mesma área que o leitor de tela anuncia como "Mensagens novas a partir daqui".

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 64 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles listRow (seis testes: a linha compacta e a com legenda, a marca e o estado das linhas de escolha, desligada e esperando com a barra de espaço uma vez, a divisória e a ação ao lado, o `ListGroup` e a `Divider` com rótulo), composePolish (o nome das linhas de Ajustes), uiKit, profileSave, mensagemRows, buscaGlobal, searchRecents, diarioSnapshot, terms e report.
- [x] Regressões: sem a correção da marca, listRow falha (4 de 6); com a linha de Ajustes passando só o rótulo, composePolish falha (15 de 16).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador.

- [ ] Ajustes no claro e no escuro: grupos com cantos de 24 pt, divisórias de 1 pt, valor à direita, linha pressionada, e o leitor de tela dizendo "Aparência, Sistema".
- [ ] Ajustes › Aparência: as três opções como `radiogroup`, uma só marcada, e a barra de espaço na web.
- [ ] Entrar › Outras formas de entrar › Entrar com outra passkey, e os Termos antes de entrar ("Ler", "Fechar", "Aceitar e continuar").
- [ ] Ajustes › Termos e privacidade: os acordeões abrindo e fechando com a divisória entre eles.
- [ ] Diário: o grupo de atalhos com uma, duas e as cinco linhas.
- [ ] Busca: buscas recentes, "Limpar" e "remover", e o toque na linha refazendo a busca.
- [ ] Denunciar, Recados e as versões do perfil com as divisórias.
- [ ] "Mensagens novas" numa conversa e num grupo.
- [ ] Android (build de debug), simulador iOS, web e PWA.
- [ ] Texto grande e larguras de 320 px e 1280 px.
