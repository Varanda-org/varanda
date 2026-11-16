# Revisão visual de UI

Este é o ciclo que todo PR com mudança de interface percorre antes de pedir revisão. Ele existe para que a tela seja olhada de verdade, no celular primeiro, e não apenas pelos testes.

## Quando rodar

- Qualquer PR que altere tela, componente, tema, texto visível ou navegação em `apps/app`.
- Antes de marcar no checklist do PR que a interface foi conferida. Se algum passo não rodou, diga qual e por quê.

## Evidências

As capturas ficam fora do git, em uma pasta de evidência do PR (por exemplo, `~/Workspace/evidencias/<branch>/`). No corpo do PR, cite o caminho de cada captura, nunca anexe o arquivo ao repositório.

O script `apps/app/scripts/review-shots.sh` tira a captura da tela ligada:

```sh
bash apps/app/scripts/review-shots.sh android <outdir> <label>
bash apps/app/scripts/review-shots.sh ios <outdir> <label>
```

Ele grava `<outdir>/<label>-<platform>-<n>.png` com `n` sequencial e imprime o caminho. Sem dispositivo ligado, ele para com `Nenhum simulador ou emulador ligado` e código de saída 1.

## Ordem do ciclo

1. **Android** no emulador AVD `varanda-api36`. É a plataforma de referência: o build de debug (`app.varanda.debug`) roda aqui antes de qualquer outra.
2. **iOS** no simulador iPhone 16e.
3. **Chrome** (web e PWA) em 390 px e 1280 px, no tema claro e no escuro.
4. Rodar cada tela também com texto grande e com movimento reduzido, nas plataformas acima, para conferir corte de texto e animações.

Para telas populadas sem conta, suba o Metro com `EXPO_PUBLIC_VARANDA_VITRINE=1`. Assim as telas hospedadas aparecem com dados de exemplo. Para conversas reais entre duas sessões, use o laboratório hospedado (`apps/cli/scripts/hosted-lab.js`) e abra cada sessão no Chrome.

## Checklist de telas

Confira cada tela nas plataformas do ciclo:

- A Rua
- Conversa
- Membro
- Diário
- Posts salvos
- Assunto (hashtag tocada)
- Conversas e filtros
- Mensagem
- Comunidade
- Grupo
- ComunidadeInfo
- Avisos
- Busca
- Publicar
- Ajustes
- Introdução
- Perfil rico, só no nó hospedado (Diário, Membro e Editar perfil; confira cada item no claro e no escuro, a 375 pt e a 1280 pt, com texto grande):
  - Faixa do perfil em tema: os oito temas (Varanda, Floresta, Mar, Pôr do sol, Ipê, Flor, Lavanda e Terra), cada um no claro e no escuro, no Diário e no Membro, com o fio de destaque embaixo, o círculo de voltar e os botões da faixa legíveis, e a barra fixa do topo ainda no pôr do sol. Sem tema, a faixa de sempre.
  - Pastilha de humor: com emoji e texto, só emoji, só texto, texto longo (sem corte nem sobreposição), "some em N h", no tema e fora dele; no Diário próprio é um botão de 44 pt.
  - Cartão Sobre mim: texto em várias linhas, só as linhas preenchidas, borda de destaque na cor do tema; sem nada preenchido, o cartão não aparece.
  - Seletor de tema: "Padrão" e as oito amostras, cada uma com alvo de pelo menos 44 pt, nome embaixo, aro e marca na escolhida, quebra de linha em tela estreita, leitor de tela lendo "Tema <nome>".
  - Cartão Sorte do dia: só no Diário próprio, abaixo do cartão Sobre mim, sem botão.
  - Editor (Sobre mim e Humor do dia): os campos e o seletor não ficam atrás do teclado, em Android, iOS e web, com o formulário inteiro ainda alcançável com o teclado aberto.
  - Apagar sobre mim e Apagar humor: o botão só aparece com um registro, a confirmação cabe sem corte e os botões "Apagar" e "Cancelar" têm 44 pt; os textos de sucesso e de incerteza (com "Conferir") aparecem e depois de apagar o cartão, o tema e a pastilha somem do Diário.
- Fãs e Melhores amigos, só no nó hospedado (Membro com o botão "Sou fã" / "Deixar de ser fã" e a linha Melhores amigos; Diário com a linha Melhores amigos e o editor, tela `melhores-amigos`; Seguindo com o segmento "Seguindo | Fãs"; tela `fas`, aberta pelo número de fãs; confira cada item no claro e no escuro, a 375 pt e a 1280 pt, com texto grande):
  - Botão de fã (Membro): "Sou fã" e "Deixar de ser fã" com a estrela cheia ou vazia, alvo de 44 pt, os estados "Sou fã…" e "Deixando de ser fã…", e o estado incerto com o texto e o botão "Conferir" ("Conferindo…", "Conferido: você é fã.", "Conferido: você não é fã."); com o próprio diário ilegível o botão continua usável.
  - Contagem de fãs: "1 fã", "N fãs" e zero, ao lado das contagens de seguidores, tocável e abrindo a lista; com a nota "A contagem pode estar incompleta." sem corte nem sobreposição.
  - Lista de fãs: linhas de pessoa com avatar de 48 pt e alvo de 44 pt, do mais novo para o mais antigo, com rolagem infinita na segunda página (sem botão "Ver mais"; o único botão é "mostrar mais", na tela "Ninguém conferido até aqui" quando ainda há cursor), a nota das pessoas que não puderam ser conferidas, "Ainda montando a lista", "Lista incompleta" e a lista vazia ("Ninguém é fã ainda"). Em Seguindo, o segmento "Seguindo | Fãs" troca de lista sem sair da tela.
  - Faixa Melhores amigos: no perfil de outra pessoa só os amigos que seguem de volta; no próprio perfil, o texto "esperando seguir de volta" nos demais, o botão "Editar" (ou "Escolher melhores amigos" com a lista vazia) e a nota "Só aparece para os outros quando a pessoa seguir você de volta."; sem nenhum amigo, a faixa não aparece para os outros. Os avisos da faixa ("Não deu para ler os melhores amigos agora. Nada é mostrado por enquanto.", "Você bloqueou esta pessoa. Desbloqueie para ver os melhores amigos dela.", "A leitura ficou incompleta. Podem faltar pessoas nesta lista." e "O semeador ainda está montando esta lista. Podem faltar pessoas por enquanto.") cabem sem corte.
  - Editor da lista: até 8 pessoas, subir e descer com alvo de 44 pt e leitor de tela lendo o lugar de cada uma, remover, as mensagens de recusa (máximo, repetido, a si mesmo, bloqueado, só para quem acabou de ser adicionado: uma pessoa bloqueada ou página que já estava na lista pode ficar ao salvar), o botão de salvar só com mudança, o caso em que o próprio diário não pode ser lido por inteiro (o editor parte da lista que o semeador aponta, conferida no próprio diário, ou abre vazio com um aviso), e o campo e a lista fora do teclado em Android, iOS e web.
  - Estados do semeador: "O semeador ainda está montando esta lista. Podem faltar pessoas por enquanto.", "A leitura ficou incompleta. Podem faltar pessoas nesta lista.", leitura que falhou, pessoa bloqueada, e o texto de incerteza depois de um envio sem confirmação.
- Fóruns e enquetes, só no nó hospedado (Publicar com a opção Enquete e o `PollEditor`; `PollCard` nas publicações; segmento Tópicos num grupo público, dentro de `Grupo`; tela `Topico`; folha `NewTopicSheet`; confira cada item no claro e no escuro, a 375 pt e a 1280 pt, com texto grande):
  - `PollCard`: pergunta e 2 a 4 opções com a barra de proporção, a contagem ("1 voto", "N votos") e a marca da opção escolhida, alvo de 44 pt por opção, sem corte com opções de 60 caracteres; o aviso "Seu voto é público: quem vê o seu diário pode ver em quem você votou." antes do primeiro voto; "Os totais vêm do semeador e podem estar incompletos." e "Ainda não deu para ler os totais."; o estado de voto enviando e o de incerteza depois de um envio sem confirmação; "Quem votou" com avatar de 48 pt e alvo de 44 pt, e a lista vazia.
  - `PollEditor`: campo da pergunta e as opções com contador de caracteres, adicionar (até 4) e remover (até 2) com alvo de 44 pt, as cinco mensagens de recusa ("Coloque pelo menos duas opções.", "No máximo quatro opções.", "Preencha ou remova as opções vazias.", "Cada opção tem no máximo 60 caracteres.", "As opções precisam ser diferentes."), e o campo e a lista fora do teclado em Android, iOS e web.
  - Tópicos (lista): linhas com o título, quem abriu, o número de respostas, a última resposta e o resumo da enquete; do mais novo para o mais antigo, na ordem do servidor; "mostrar mais" com cursor; a lista vazia, o grupo ainda sincronizando e a leitura incompleta; tópico escondido sem texto.
  - Topico (tela): o tópico em destaque com o `PollCard` da enquete, as respostas e o campo de resposta; o topo com a seta de voltar; o tópico escondido e o tópico apagado.
  - `NewTopicSheet`: o campo "Assunto" (a primeira linha é o título), "Adicionar enquete" com o `PollEditor` e o botão "Criar tópico" desligado com o texto vazio, com os campos fora do teclado.
  - Grupo privado: sem o segmento Tópicos e sem a opção de tópico ou enquete.

## Critério de revisão

Cada tela é comparada com estas qualidades de referência:

- Uma ação principal por tela, com destaque claro.
- Linhas com avatar à esquerda, como nos apps de mensagem.
- Balões com cauda, e horários agrupados por remetente e intervalo.
- Cabeçalhos com ícone, sem texto solto onde um ícone resolve.
- Alvos de toque de pelo menos 44 pt. Exceção: um link dentro do texto (um `@nome`, um endereço ou um `#palavra`) segue a linha do texto, e o alvo é o próprio texto.
- Nenhum texto cortado, sobreposto ou escondido por teclado, entalhe ou barra do sistema.

Para cada tela, escreva uma crítica curta: o que está bom, o que quebra a referência, e qual é a correção proposta.

## Rodadas de correção

1. Critique a tela, corrija o que a crítica apontou, e tire a captura de novo.
2. Repita enquanto cada rodada mudar algo.
3. Pare quando duas rodadas seguidas não mudarem nada. Registre no PR a última rodada e o motivo da parada.

## Limite conhecido: login nativo real

O login nativo real por passkey e por conta ainda depende do domínio associado e dos arquivos de links de aplicativo (asset links) publicados. Até lá, o celular não consegue completar o login de conta real, e isso é um portão separado do ciclo visual. Uma revisão visual aprovada não libera esse fluxo, e o PR deve dizer isso com essas palavras.

## Limites da Vitrine

A Vitrine responde a todos os métodos que o app chama, com dados fixos e sem rede, para mostrar as telas preenchidas. Ela não reproduz cada regra do nó: por exemplo, bloquear uma conversa não esconde as mensagens antigas, seguir de volta não tira o aviso de quem seguiu, e banir alguém da comunidade não reflete nos grupos dela. O índice da Vitrine (conversas, perfis, contagens, busca) responde com os dados fixos: uma publicação feita durante a sessão aparece em A Rua e no Diário, mas não abre como conversa nem soma nas contagens. Para conferir um fluxo de comportamento (bloqueio, moderação, avisos, envio), use o laboratório hospedado com duas pessoas de verdade. A Vitrine serve para conferir aparência e navegação.

## Registro

No corpo do PR, liste as telas revisadas por plataforma, o caminho das capturas, o número de rodadas e o resultado da última rodada. Diga o que não foi conferido.
