# Perfil da Página na chave nova (branch fix/paginas-mudanca-perfil)

## O que mudou

- `apps/cli/lib/account/pages-routes.js`: ao mudar a chave de uma Página, o serviço lê, antes de `movePage`, o perfil que a chave antiga (K1) mostra, com a mesma dobra dos leitores (`latestProfile` com as remoções aplicadas), feita só sobre os blocos que o próprio serviço escreveu: numa K1 pausada, os blocos a mais vieram de uma chave vazada, e nem um perfil nem uma remoção escritos com ela contam. Depois que a mudança grava no diretório e na ACL, o serviço acrescenta à chave nova (K2) um `profile` com o mesmo nome e a mesma bio e, se houver foto, a foto guardada de novo na mídia de K2 (`avatarItem`), depois da gênese, do `dm-key` e do `page-link`, quando existem. A cópia não gasta os limites de mídia e de foto, não é uma declaração à parte e é revalidada por `profileRecords`. Se falhar, a mudança vale e o serviço registra `perfil-pendente` (`foto-pendente` quando só a foto falha, e K2 fica com nome e bio). A cópia roda com o bloqueio de K2, para que uma edição de perfil de um admin em K2 não entre no meio (nenhuma rota bloqueia K2 e depois K1, então não há impasse). O comprimento da resposta e o esperado pela ACL contam o que chegou a K2: primeiro `expectLength`, depois `setMedia`, cada um com a sua falha registrada. Um reenvio depois de uma mudança incerta copia o perfil se K2 ainda não tem um, e nunca acrescenta uma segunda cópia.
- `apps/cli/lib/account/pages-writer.js`: `readOwn(key)` devolve os blocos que o escritor gravou (até o comprimento que ele mesmo registrou), sem as remoções aplicadas, e nada quando o núcleo bifurcou ou o estado se perdeu. `itemBytes(key, descriptor)` lê de volta os bytes de um item da própria página (só um item da tabela da página, no núcleo de mídia dela, conferido pelo sha256). Funciona numa K1 já mudada: depois da mudança, o serviço apaga só as chaves de K1, e o diário e a mídia continuam abertos para leitura.
- `docs/protocol.md`, seção "Mudar de chave": K2 recebe a cópia do perfil de K1, com o que acontece numa falha.
- Dono que é delegado de um nó core: o `page-link` em K2 mostra o perfil do diário do nó para o dono, não o perfil da página. A cópia continua necessária e vem depois do `page-link`, como na criação.

## Como verificar

Testes automáticos, a partir da raiz:

```sh
node apps/cli/test/pages-lifecycle.test.js
npm test -w apps/cli
npx standard apps/cli/lib/account/pages-routes.js apps/cli/lib/account/pages-writer.js apps/cli/test/pages-lifecycle.test.js
```

Casos fixados em `apps/cli/test/pages-lifecycle.test.js`:

- Uma página com nome, bio e foto muda de chave: K2 tem o mesmo nome e a mesma bio, e uma foto num núcleo de mídia de K2 cujos bytes têm o mesmo sha256 da foto de K1; uma cópia só (o perfil simples e o mesmo com a foto), depois da gênese; a resposta, a ACL e a contagem de mídia batem com K2; um terceiro membro lê o nome em K2.
- Uma página cujo perfil foi removido não leva nada para K2.
- Uma falha ao acrescentar o perfil em K2 não derruba a mudança: registra `perfil-pendente`, e o comprimento conta o registro de mídia da foto já guardada.
- Uma falha ao guardar a foto em K2: o nome e a bio chegam sem foto, e o serviço registra `foto-pendente`.
- Uma K1 pausada em que uma chave vazada acrescentou um perfil e removeu os do serviço: K2 recebe o nome, a bio e a foto que o serviço escreveu, e nada da chave vazada.
- `itemBytes` recusa um item fora da tabela de K1 (uma foto que uma chave de mídia vazada pôs no núcleo de K1) e um item do núcleo de outra página com os mesmos bytes no mesmo lugar; nos dois casos a mudança leva nome e bio, sem foto.
- Um reenvio depois de uma mudança incerta copia o perfil e a foto uma vez, lendo a mídia de K1 depois de as chaves de K1 serem apagadas, e um reenvio seguinte não acrescenta nada; se K2 já tem um perfil, o reenvio não acrescenta outro.
- Um dono delegado de nó core: K2 tem o `page-link` e, depois dele, o perfil da página.

## Conferir no app (pessoas)

Caminhada na web, no laboratório hospedado (`apps/cli/scripts/hosted-lab.js` com este serviço, navegador sem tela): a dona criou a Página, pôs foto e bio, convidou uma administradora e uma terceira pessoa passou a seguir.

- [x] Ajustes da página › Mudar a chave: "Pronto: a página mudou para uma nova chave", sem `perfil-pendente` nem `foto-pendente` no log.
- [x] No aparelho da dona, Páginas lista a chave antiga "encerrada" e a nova, as duas com nome e @nome; a página na chave nova (a que `/account/username/<@nome>` passou a apontar) mostra o mesmo nome, a mesma bio e a foto, guardada no núcleo de mídia da chave nova.
- [x] Quem segue abre a página pela Busca (já na chave nova) e vê o mesmo nome, a mesma bio e a foto.
- [ ] Uma Página sem foto muda de chave e mostra nome e bio, sem foto: só nos testes.

Android, iOS e PWA: os mesmos passos ficam com o Rodrigo, no APK de preview do EAS (o build de debug não entra com passkey).

## Não verificado / limites conhecidos

- Não conferido em aparelho (Android, iOS) nem no PWA.
- Se a cópia falhar, o dono precisa editar o perfil na chave nova à mão; o app não avisa.
- A cópia não passa de novo pela conferência de palavras: o texto já estava publicado na chave antiga.
- Se o serviço cair entre a gravação da mudança na ACL e a cópia, K2 fica sem perfil e nenhum reenvio retoma a cópia: o dono edita o perfil na chave nova à mão.
- Se o perfil não for acrescentado depois de a foto ser guardada, a foto fica como um item órfão no núcleo de mídia de K2: nenhum perfil aponta para ela, mas os bytes são públicos para quem replica o núcleo, e o item conta na mídia de K2.
