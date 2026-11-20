// Copy and the decision for the one-launch explainer shown to a hosted member
// who is already linked and still needs a Brazilian mobile. Pure: imports
// nothing, so Node's import() tests every branch. The acknowledgement is an
// argument, never stored here: it lasts only for the launch that holds it.

export const CONTINUE_LABEL = 'Confirmar meu celular'
export const DELETE_LABEL = 'Excluir minha conta'

export const EXPLAINER = Object.freeze({
  title: 'Agora a Varanda usa o seu celular',
  points: Object.freeze([
    'O número não é a sua identidade na rede e não aparece no perfil, no diário nem no certificado.',
    'O número não serve para recuperar a conta.',
    'A associação só entrega o número com ordem judicial ou a seu próprio pedido.',
    'Enquanto durar um bloqueio, o mesmo número não pode ser usado em outra conta.',
    'O número fica guardado lacrado no Brasil.',
    'O número fica lacrado por até 180 dias depois de excluir a conta e então é apagado.',
    'O seu @nome e as suas postagens continuam iguais.'
  ])
})

// Only boolean true counts, the same rule as the phone gate: a string or a
// number must not open or close the explainer. A missing acknowledgement
// still shows it, because this launch has not recorded one.
export function showExplainer ({ hosted, linked, gate, acknowledged } = {}) {
  return hosted === true && linked === true && gate === 'needed' && acknowledged !== true
}
