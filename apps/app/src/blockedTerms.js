// The terms the official app refuses in public text before it is posted
// (wordCheck.js). The repository is public and the app ships this file, so
// the list is public. It is not a profanity list. A term belongs here only
// when it is severe on its own and almost never has an innocent use: anything
// that needs judgment goes to reports and human moderators instead. Changes go
// through a normal PR, approved by the list's owner.
//
// Format: lowercase ASCII words separated by one space, exactly as wholeTokens
// (search.js) folds them, so accents are left out. A term with several words
// matches only those words in a row, and never part of a longer word. An
// apostrophe separates words: "i'll" is the two words "i" and "ll".

// Racial, ethnic and religious slurs.
const SLURS = [
  'nigger', 'niggers', 'nigga', 'niggas',
  'kike', 'kikes',
  'wetback', 'wetbacks',
  'raghead', 'ragheads',
  'towelhead', 'towelheads',
  'gook', 'gooks',
  'spic', 'spics',
  // "macaco" and "crioulo" alone are an animal and a kind of seed or language,
  // so only the insulting phrases are listed.
  'seu macaco', 'sua macaca',
  'macaco imundo', 'macaca imunda',
  'seu crioulo', 'sua crioula',
  'crioulo imundo', 'crioula imunda',
  'preto imundo', 'preta imunda',
  'preto fedido', 'preta fedida',
  'negro imundo', 'negra imunda',
  'negro fedido', 'negra fedida',
  'judeu imundo', 'judia imunda', 'judeus imundos'
]

// Slurs against gay, lesbian, trans and travesti people. Words the community
// also uses for itself ("viado", "bicha", "sapatao") are left out on purpose.
const ANTI_LGBT = [
  'faggot', 'faggots',
  'tranny', 'trannies',
  'boiola', 'boiolas',
  'baitola', 'baitolas',
  'traveco', 'travecos',
  'viadinho', 'viadinhos'
]

// Calls for violence against a group, and Nazi salutes.
const HATE = [
  'heil hitler', 'sieg heil',
  'gas the jews',
  'kill all jews', 'kill all blacks', 'kill all gays', 'kill all muslims',
  'morte aos judeus', 'morte aos negros', 'morte aos gays', 'morte aos nordestinos',
  'morte aos muculmanos', 'morte aos indios', 'morte aos travestis', 'morte as mulheres'
]

// Sexual content involving children and adolescents.
const MINORS = [
  'pornografia infantil', 'porno infantil', 'sexo infantil',
  'sexo com crianca', 'sexo com criancas',
  'sexo com menor', 'sexo com menores',
  'nude de menor', 'nudes de menor', 'nudes de menores',
  'pack de menor', 'pack de menores', 'pack de novinha', 'pack de novinhas',
  'child porn', 'child porno', 'child pornography',
  'childporn', 'kidporn', 'kid porn', 'kiddie porn', 'kiddy porn',
  'underage porn', 'underage nudes', 'underage sex',
  'preteen porn', 'preteen nudes',
  'sex with kids', 'sex with children', 'sex with a child', 'sex with a minor', 'sex with minors',
  'lolicon', 'shotacon'
]

// Explicit threats and telling someone to kill themselves. "te mato" and "vai
// se matar" are left out: both are everyday jokes and figures of speech.
const THREATS = [
  'vou te matar', 'vou matar voce', 'vou matar vc',
  'vou matar sua familia', 'vou matar a sua familia',
  'vou te estuprar', 'vou estuprar voce', 'vou estuprar vc',
  'vou te esfaquear', 'vou te dar um tiro', 'vou atirar em voce', 'vou atirar em vc',
  'vou atirar na escola', 'vou atacar a escola', 'vou explodir a escola',
  'va se matar', 'se mata logo',
  'kill yourself', 'kys',
  'i will kill you', 'we will kill you', 'll kill you', 'ill kill you',
  'going to kill you', 'gonna kill you',
  'will rape you', 'll rape you', 'ill rape you', 'going to rape you', 'gonna rape you'
]

export const BLOCKED_TERMS = Object.freeze([...SLURS, ...ANTI_LGBT, ...HATE, ...MINORS, ...THREATS])
