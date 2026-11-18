# Sobras de comunidades e grupos (branch docs/community-group-leftovers)

Fecha a #350. Cada item do escopo da issue foi corrigido num PR próprio ou descartado com o motivo abaixo. Este arquivo junta as decisões e o estado final de cada item; a verificação de cada correção fica no arquivo do PR que a fez.

## Decisões

Tomadas por Rodrigo em 16/11/2026, nesta ordem:

- **Aparelho perdido (item do #241).** Implementar o corte pelo diário: um `group-cut` passa a valer para qualquer escritor do próprio diário, e os posts e a autoridade daquele escritor deixam de contar a partir do corte. Não para um ladrão que tem a sessão destravada (quem tem a identidade age como a pessoa).
  - A pessoa escolhe o aparelho numa lista de aparelhos da conta, como no WhatsApp: em Ajustes, "Aparelhos conectados". Cada aparelho ganha um id e um nome no diário, e cada entrada em comunidade ou grupo diz de qual aparelho é. "Desconectar" corta os escritores daquele aparelho em todas as comunidades e grupos.
  - O nome do aparelho vai cifrado com uma chave da passkey: só os aparelhos da conta leem. Quem guarda o diário vê só um id aleatório.
  - Os aparelhos que entraram antes da mudança aparecem num item só, "Aparelhos anteriores": desconectar corta todos os escritores sem id, menos os deste aparelho. Um aparelho antigo que ainda tem a passkey se registra sozinho ao abrir o app e sai desse item.
  - Num grupo privado o corte conta como remoção: o grupo pede uma chave nova, e o aparelho cortado não lê o que vier depois.
  - O corte vale a partir do comprimento que o aparelho que corta já tem daquele escritor: o que chegar depois não conta; o que já estava visível continua.
- **Sigilo futuro dentro de uma época (item do #275).** Propor um desenho com custo medido antes de qualquer mudança de formato.
- **Aprovação do aparelho novo (item do #320).** Admitir sozinho o aparelho novo: a admissão de um membro cobre os aparelhos novos do mesmo diário enquanto ele não sair nem for banido.
- **Vagas e saída (itens do #320).** Estudar aqui a devolução da vaga pelo semeador e trazer o desenho antes de codificar. Descartar o item "um aparelho que ainda não recebeu a saída feita em outro pode entrar sozinho numa raiz de que a conta já saiu".

Depois dos estudos, também em 16/11/2026:

- **Sigilo futuro: troca periódica da chave.** Sem formato novo e sem ratchet. Quem já distribui chaves troca a chave de um grupo privado a cada 7 dias ou 1000 envelopes, o que vier antes, com os dois limites mais espaçados em grupo grande, pelo mesmo caminho do `group.rekey`. Uma chave de época vazada passa a abrir só uma janela. Nenhum desenho protege contra um aparelho roubado, que guarda as chaves de todo o histórico que recebeu; isso fica descrito como limite.
- **Vagas: congelar com reserva.** O mesmo `group-cut` do corte pelo diário decide as vagas. Corte em 0 libera a vaga de vez; corte maior congela o escritor (o que veio antes do corte continua valendo) e o tira das 8 vagas vivas para uma reserva de 8 congelados, com no máximo 16 liberações por diário e raiz. O semeador passa a ler `group-cut` e guarda no máximo 16 núcleos por diário e raiz.
- **Aparelho desconectado trava.** Quando um aparelho descobre que foi desconectado, ele esquece a sessão guardada e trava: para usar de novo, e para "Conectar de novo", precisa da passkey. Os dados locais ficam no aparelho.
- **Uso da vaga devolvida: bit de capacidade.** O semeador novo anuncia um bit no canal de admissão, e o aparelho só entra numa vaga devolvida quando o semeador conectado o anuncia. Nenhum passo manual depois.
- **Corte é final.** Nada que um aparelho escreveu depois do corte volta a contar, nem por decisão de outra pessoa (um rebaixamento, um banimento ou uma troca de chave que cite aquele aparelho). Limite aceito: uma conta pode, com a própria passkey, cortar um aparelho dela abaixo do que ele já escreveu e assim desfazer banimentos que fez quando era admin; outro admin pode banir de novo.

Na revisão das vagas, também em 16/11/2026:

- **Corte em 0 mantém a saída.** O corte em 0 libera a vaga viva, mas o primeiro bloco, as saídas e as chaves daquele escritor continuam valendo: quem saiu não volta a ser membro, e o histórico selado continua legível. O semeador guarda desse escritor só esses blocos, num núcleo reduzido, além dos 16 núcleos por diário e raiz.
- **Escritores que saíram ficam no semeador.** Ele continua guardando escritores com saída, para um semeador novo conseguir completar a dobra, dentro do total por conta.
- **Teto de 1024 núcleos por conta** (64 grupos vezes 16).
- **A troca do escritor sem chave corta na hora**, sem esperar o bit de capacidade do semeador.
- **Saída depois do corte continua contando.** Uma saída só tira, nunca dá nada, e assim a saída feita no aparelho perdido pouco antes de perdê-lo não se desfaz. Limite aceito: um aparelho roubado e já desconectado pode tirar a pessoa de um grupo ou do cargo de admin; ela volta pedindo para entrar de novo.

Em 17/11/2026:

- **Escritor sem chave liberado.** Corrigir antes de fechar a issue. Num grupo privado, o escritor sem chave de um aparelho que entrou antes de a raiz chegar é trocado e, com o corte em 0, liberado. Quem nunca o guardou recusava o cabeçalho e via o grupo incompleto para sempre. Agora o leitor guarda só o bloco 0 desse escritor.
- **Escritor cujo `member` não bate com o tipo da raiz.** Corrigir na própria issue: a dobra nunca conta esse escritor, então o leitor deixa de esperá-lo e vê o grupo completo.
- **Todo cabeçalho que nunca conta** (bloco 0 que não se decifra, registro v1 antigo, de outro grupo ou de outro diário) segue a mesma regra, no nó core e no nó do navegador.
- **Bit de capacidade para o semeador.** O leitor guarda esses escritores como toco (só o bloco 0, sem contar na cota) e anuncia um bit; o semeador lista esses tocos só a quem anuncia o bit, para um aparelho antigo não recusar a listagem.

## Estado de cada item

A verificação de cada correção, com os testes que falham sem ela, fica em `docs/verification/<branch>.md` do PR citado. As seções numeradas antigas de `docs/verification.md` ficam como histórico.

Do #241:

- **Renomear o grupo não aparece na busca do semeador.** Corrigido no #694: o semeador dobra o `group-meta` de um grupo público no índice de busca.
- **O diário não corta o escritor de um aparelho perdido.** Corrigido em três PRs: #693 (um `group-cut` do próprio diário corta qualquer escritor seu, e o corte é final), #703 (cada aparelho ganha id e nome cifrado no diário, e "desconectar" corta os escritores daquele aparelho em todas as comunidades e grupos) e #710 (Ajustes, "Aparelhos conectados", Termos 76).

Do #266:

- **Um grupo cuja comunidade foi bloqueada não consegue desligá-la.** Descartado: deixou de existir com o #293, que trocou o vínculo entre grupo e comunidade (`community.link`) por comunidades que contêm os próprios grupos. Não há mais vínculo para desligar.

Do #275:

- **Um aparelho que entrou antes de a raiz privada chegar precisa entrar de novo.** Corrigido no #688: a participação automática troca o escritor sem chave por um com a chave do aparelho.
- **Sem sigilo futuro dentro de uma época.** Resolvido no #700 com a troca periódica da chave (7 dias ou 1000 envelopes, o que vier antes), sem formato novo. O limite que fica (um aparelho com as chaves guardadas lê o histórico que recebeu) está em `docs/protocol.md`.

Do #319:

- **Um escritor novo numa raiz que já é réplica espera a próxima paginação.** Corrigido no #686: o aparelho busca o escritor logo e de novo após 2, 5 e 10 s.
- **Num diário com buraco ou leitura que falha, uma entrada pode ser pulada.** Corrigido no #686: a entrada é relida em toda varredura e por temporizador depois de uma falha.

Do #320:

- **Os aparelhos ocupam 8 vagas por raiz e o semeador nunca devolve a vaga.** Corrigido em cinco PRs: #713 (a caminhada das vagas: corte em 0 libera, corte maior congela; o semeador guarda até 16 núcleos por diário e raiz), #721 (o semeador lista um escritor que saiu pela última entrada ligada), #722 (os clientes contam as vagas pela mesma caminhada e trocam o próprio escritor com um corte), #732 (o semeador guarda de um escritor cortado só os blocos que ainda contam) e #742 (quem nunca guardou um escritor sem chave que foi trocado e liberado num grupo privado guarda só o bloco 0 dele e vê o grupo completo).
- **Cada escrita local arma uma passada que para a sincronização por cerca de 1,5 s.** Já resolvido antes desta issue pelo #340 (seção 94 de `docs/verification.md`): um plano da participação automática sem nada a escrever não para mais a sincronização. Só um plano que tem algo a escrever passa pela trava de escrita.
- **Limitar as passadas que o evento `group-writer` arma.** Corrigido no #688: o evento só arma a passada para grupo privado em que o aparelho escreve, ou para escritor novo do diário da conta, no máximo 64 por sessão (eram 512).
- **Um aparelho que ainda não recebeu a saída feita em outro pode entrar sozinho numa raiz de que a conta já saiu.** Descartado por decisão de 16/11/2026 (acima). A participação automática respeita a saída que já chegou, inclusive a registrada no diário por outro aparelho (#688); a janela que sobra é a de um aparelho que ainda não recebeu o diário, e ela se fecha quando ele sincroniza.
- **Numa comunidade com aprovação, os grupos do aparelho novo de um membro comum esperam um administrador.** Corrigido no #701: a admissão de um membro cobre os aparelhos novos do mesmo diário enquanto ele não sair nem for banido.

Achados de 17/11/2026 (decisões acima):

- **Escritor cujo bloco 0 nunca conta para o diário que o ligou** (`member` que não bate com o tipo do núcleo, bloco 0 que não se decifra, cabeçalho v1, de outro grupo ou de outro diário). Corrigido no #768: o nó core e o nó do navegador guardam esse escritor como toco, só o bloco 0, e a dobra deixa de esperá-lo. Os aparelhos anunciam o bit `CAP_HEADER_STUBS`.
- **O semeador lista os tocos.** Corrigido no #778: o semeador guarda os tocos (até 8 por diário e 256 no total, só o bloco 0) e os lista só a quem anuncia o bit.

Nenhum item virou issue própria.
