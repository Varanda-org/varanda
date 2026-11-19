# Avisos de mensagens em grupos (branch feat/group-message-notice)

## O que muda

- O semeador monta uma indicação de participantes pelos registros em claro do grupo e da comunidade (`packages/core/lib/group-notice.js`). Quando não consegue concordar com a leitura completa, responde `unknown` ou deixa o diário de fora. Nada sai antes de ler os núcleos do grupo e da comunidade até seus comprimentos contíguos. O histórico da abertura nunca avisa.
- Um `group-post` público novo, ou qualquer envelope lacrado de grupo privado, escrito por um escritor permitido pela indicação, gera o evento local `{ v: 1, kind: 'group', group, visibility, name, nid, recipients }`. Os destinatários são os membros, menos o autor, até 64 por evento, em vários eventos para grupos maiores. `nid` é um identificador opaco por bloco (BLAKE2b com chave sobre grupo, escritor e sequência, 16 bytes em hexadecimal); `name` é o nome público ou null, sempre null no privado. Limites no semeador por grupo e por escritor: quatro de uma vez, reposição de um a cada 30 s; o excesso é descartado. Corpo do relé até `RELAY_BODY_MAX` = 8192 bytes.
- O serviço de conta confere o evento e manda no máximo uma vez por `nid` e destinatário, um aviso de grupo por grupo e por pessoa a cada 10 min (contados só ao enfileirar), 60 avisos por pessoa por hora, no máximo metade da fila para grupos, só a quem aceitou os Termos 98. Mesma espera sorteada de 0 a 60 s e mesmo enchimento dos outros avisos. Os registros de operação nunca levam grupo, nome, `nid` ou destinatários.
- O aparelho recebe `{ v: 1, kind: 'group', group, body, g }` no público (`body` é o nome ou null), ou `{ v: 1, kind: 'group-private', g }` no privado. O service worker mostra "Nova mensagem em <nome>", "Nova mensagem num grupo" sem nome utilizável ou "Nova mensagem num grupo privado", com tags `varanda-group-<group>` e `varanda-group-private`, sem `renotify`. Aparece mesmo com a janela em foco e o toque abre `/?aviso=grupo` quando não há janela do app, ou põe a janela existente em foco e envia `{ type: 'varanda-group-open' }`. Se não conseguir pôr a janela em foco, abre outra com o mesmo endereço. `captureLaunch` reconhece o pedido de grupo na URL. O app chama `actingAs.me()` antes de abrir as Conversas, pois os grupos ficam ocultos enquanto a pessoa atua como uma Página.
- Termos e Política de Privacidade na versão 98 (`TERMS_VERSION` e `LEGAL_VERSION`), com novo aceite, digest e páginas do site atualizados. Descrevem a informação que chega ao serviço de conta, os tetos e a base legal proposta. Documentos: `docs/protocol.md` (seção 11, "Push notice", e seção 3, "Push relay"), `docs/design.md` (Notificações e linhas de mensagens de grupos na tabela LGPD), `docs/app.md` (limites dos grupos).

## Testes automatizados

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/app/test/legal.test.js` | 68 | 2070 |
| `apps/site/test/legal.test.js` | 7 | 115 |

Revisão T17: ambos passaram. A asserção corrigida sobre a chave do grupo foi executada antes de corrigir os Termos: falhou como esperado (`67/68` testes e `2069/2070` asserções passaram, falha em "terms: group key for both visibilities, public name only, no author or content"). Depois da correção e da atualização do digest, todos passaram, conforme a tabela.

`node apps/site/scripts/render-legal.js` atualizou a página de Termos; a de Privacidade já correspondia à fonte. `node apps/site/scripts/render-legal.js --check` passou. A busca por U+2014 nos nove arquivos do escopo não encontrou ocorrências. A linha LGPD de grupo privado e os limites abaixo já informavam que o serviço de conta recebe a chave do grupo privado. O Node emitiu o aviso `MODULE_TYPELESS_PACKAGE_JSON` ao importar `legal.js`, sem falha nos testes nem na renderização.

`npm run lint` falhou ao gravar o cache fora da pasta permitida: `EPERM: operation not permitted` ao abrir `~/.cache/standard/v17/.cache_16jajyy`. A repetição com `XDG_CACHE_HOME=/tmp/t17-standard-cache npm run lint` passou.

## No aparelho

- a fazer: grupo público, duas contas A e B num grupo servido por semeador e serviço de conta locais, na DHT local, com relé ligado e B com push ligado e Termos 98 aceitos. A escreve; B recebe "Nova mensagem em <nome>" em até cerca de um minuto, A não recebe. Sem nome utilizável, conferir "Nova mensagem num grupo". Repetir com a janela de B em foco; tocar no aviso abre as Conversas.
- a fazer: atuando como uma Página, tocar num aviso de grupo. Conferir que o app volta à identidade do membro e mostra o grupo na lista de Conversas, sem abri-lo diretamente. Repetir com uma janela do app aberta e sem janela aberta.
- a fazer: grupo privado, nas mesmas condições, A escreve e B recebe "Nova mensagem num grupo privado". Conferir que o aviso não leva nome nem chave do grupo. Em janelas separadas de 10 min, esconder uma mensagem, reagir e mudar o nome também podem gerar o mesmo aviso.
- a fazer: janela de 10 min, A escreve duas vezes no mesmo grupo dentro desse intervalo; B recebe só o primeiro aviso. Passados 10 min desde o enfileiramento, uma nova mensagem pode avisar. Conferir também que uma tentativa sem aparelho inscrito não inicia essa janela: inscrever B e escrever de novo deve permitir o aviso.
- a fazer: Termos 98 não aceitos, B com inscrição de push e apenas o aceite 93; uma mensagem de A no grupo não avisa B. Depois do aceite 98, nova mensagem pode avisar, sem esperar uma janela iniciada pela tentativa anterior.
- a fazer: semeador antigo, a mensagem de A aparece para B ao atualizar o grupo, sem aviso push. Com o semeador novo, reiniciar com histórico já guardado não manda avisos desse histórico.

## O que não foi conferido

- Os passos no aparelho estão a fazer. Android, iOS, Safari no iPhone com PWA instalado, Chrome no Android e Firefox não foram conferidos com o aviso novo nesta tarefa.
- A integração do semeador, do relé, da fila e do service worker pertence às outras tarefas deste PR; os resultados conjuntos ficam a preencher na aterrissagem.
- A suíte completa (`npm test`) e a demo não foram executadas nesta revisão de textos.
- Não houve envio a serviço de push real nem teste em rede externa.

## Limites conhecidos

- O serviço de conta fica sabendo quais membros pertencem a um grupo com atividade e quando, inclusive sem inscrição de push. Recebe a chave do grupo e, se público, o nome, nunca pelo aviso o autor nem o conteúdo. O semeador já conhecia os participantes. O serviço de push vê o momento de cada aviso.
- Um envelope de grupo privado não diz de fora se é mensagem, ocultação, reação ou mudança de nome; todos podem gerar a mesma frase de mensagem nova. O aparelho não recebe a chave nem o nome do grupo privado.
- A indicação de participantes é conservadora: quando não consegue concordar com a leitura completa, deixa membros de fora ou não avisa. Perder um aviso só custa o push; não muda a participação nem a mensagem.
- O histórico da abertura não avisa. Semeadores antigos não mandam avisos de grupo. Falha no relé, fila cheia ou teto atingido perde o aviso, sem reenvio.
- O limite de um aviso por grupo e por pessoa a cada 10 min pode esconder uma segunda mensagem nesse intervalo. A janela só começa quando um aviso entra na fila, não quando faltam aceite, inscrição ou espaço na fila, nem quando o teto por hora impede o aviso.
- As tags substituem avisos anteriores sem `renotify`: grupos públicos têm uma tag por grupo; todos os grupos privados compartilham a mesma tag. O toque volta à identidade do membro e abre as Conversas, sem escolher um grupo.
- O app nativo ainda não tem push. A informação sobre os membros chega ao serviço de conta também quando usam só o app nativo.
