// Invite by @nome through a private message (Conversas), shared by the
// community and the group settings screens.

import { useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import rpc, { isKey } from '@varanda/rpc'
import { isUsername, lookupUsername, usernameMatches } from '../account'
import { classifyFollowInput, PARTIAL_KEY_TEXT } from '../followInput'
import { INVITE_NOTE, INVITE_NO_DM, INVITE_SENT, INVITE_UNSURE } from '../inviteMessage'
import { useMemberSearch } from '../useMemberSearch'
import { whoOf } from '../who'
import { shortKey } from '../format'
import { UNSURE_SEND } from '../dm'
import { Btn, ErrorText, Field, Soft, errorText, useAction } from '../ui'
import { Avatar } from './Avatar'
import { Pill } from './Pill'
import { Skeleton } from './States'
import { colors, type } from './theme'

const { displayText } = rpc
const NOT_FOUND = '@nome não encontrado.'
const NO_LINK = 'Não foi possível montar o link.'
const INVITE_SELF = 'Você já está aqui.'
const INVITE_MEMBER = 'Essa pessoa já é membro.'
const sentTo = (label) => 'Convite enviado para ' + label + ' pelas Conversas.'

// Exported for the group settings, which sends its own link text through
// makeText. The send starts only from a tap: an uncertain answer keeps the
// same { to, text } for one more tap on Tentar de novo (the node re-puts the
// same drop, so there is no duplicate) and is never resent on its own.
export function InviteByName ({ request, hosted, online, ownKey, isMember, makeText }) {
  const [input, setInput] = useState('')
  const [candidate, setCandidate] = useState(null)
  const [resolving, setResolving] = useState(false)
  const [localError, setLocalError] = useState('')
  const [result, setResult] = useState('')
  const [held, setHeld] = useState(null)
  const send = useAction()
  const sendErr = useRef(null)
  const resolveGen = useRef(0)
  const editGen = useRef(0)
  const search = useMemberSearch({ request, hosted, online, ownKey })
  const offline = !online
  const cls = classifyFollowInput(input)
  const searchable = cls.kind === 'name' || cls.kind === 'handle'
  const hits = search.hits.filter((h) => h.author !== ownKey)

  const typeInput = (t) => {
    editGen.current++
    setInput(t)
    setCandidate(null)
    setLocalError('')
    setResult('')
    setHeld(null)
    send.clearError()
    resolveGen.current++
    setResolving(false)
    const c = classifyFollowInput(t)
    search.setQuery(c.kind === 'name' || c.kind === 'handle' ? t : '')
  }

  const find = async () => {
    setLocalError('')
    setResult('')
    if (cls.kind === 'key') return setCandidate({ member: cls.key, label: shortKey(cls.key) })
    if (cls.kind !== 'handle') return
    const name = isUsername(cls.handle)
    if (name === null) return setLocalError('@nome inválido')
    const mine = ++resolveGen.current
    setResolving(true)
    try {
      const found = await lookupUsername(name)
      if (mine !== resolveGen.current) return
      if (found === null || !isKey(found.member) || !usernameMatches(found.usernameRecord, found.member, name)) {
        setLocalError(NOT_FOUND)
      } else {
        setCandidate({ member: found.member, label: '@' + displayText(name) })
      }
    } catch (err) {
      if (mine === resolveGen.current) setLocalError(errorText(err))
    } finally {
      if (mine === resolveGen.current) setResolving(false)
    }
  }

  // The one place dm.send runs, always from a tap.
  const deliver = async (to, text, checkBox, label) => {
    const edit = editGen.current
    sendErr.current = null
    setHeld(null)
    setResult('')
    // A lookup still running must not bring the candidate back after the send.
    resolveGen.current++
    setResolving(false)
    const r = await send.run(async () => {
      try {
        if (checkBox) {
          // Whoever may invite does not always see the member list, so the
          // check is asked of the node; a failed check does not block the send.
          let inside = false
          if (typeof isMember === 'function') {
            try { inside = (await isMember(to)) === true } catch { inside = false }
          }
          if (inside) return 'member'
          const found = await request('dm.lookup', { member: to })
          if (!found || typeof found.box !== 'string') return 'nodm'
        }
        await request('dm.send', { to, text })
        return 'sent'
      } catch (err) {
        sendErr.current = err
        throw err
      }
    })
    const err = sendErr.current
    // Typed while dm.send was in flight: every note of this send names who it
    // was for, so none reads as being about the new draft.
    const who = editGen.current !== edit && typeof label === 'string' && label !== '' ? label : null
    if (r.ok && r.value === 'nodm') return setResult(who === null ? INVITE_NO_DM : who + ' ainda não usa as Conversas. Mande o link pelo Compartilhar.')
    if (r.ok && r.value === 'member') return setLocalError(who === null ? INVITE_MEMBER : who + ' já é membro.')
    if (r.ok) {
      // Keep what the person typed during the send.
      if (editGen.current === edit) {
        resolveGen.current++
        setResolving(false)
        setInput('')
        setCandidate(null)
        search.clear()
        setResult(INVITE_SENT)
      } else {
        setResult(who === null ? INVITE_SENT : sentTo(who))
      }
      return
    }
    if (r.uncertain || (err && err.message === UNSURE_SEND)) {
      setHeld({ to, text, label })
      setResult(who === null ? INVITE_UNSURE : 'Não deu para confirmar se o convite para ' + who + ' foi enviado. Tente de novo: a mensagem não se repete.')
    }
  }

  const invite = (member, label) => {
    if (offline || send.pending) return
    setLocalError('')
    if (typeof ownKey === 'string' && member === ownKey) return setLocalError(INVITE_SELF)
    let text = null
    try { text = makeText() } catch { text = null }
    if (typeof text !== 'string' || text === '') return setLocalError(NO_LINK)
    deliver(member, text, true, label)
  }

  return (
    <View style={styles.block}>
      <Soft>{INVITE_NOTE}</Soft>
      <Field label='Convidar por @nome' placeholder='nome, @nome ou código' value={input} onChangeText={typeInput} maxLength={80} mono />
      {cls.kind === 'partial-key' ? <Soft>{PARTIAL_KEY_TEXT}</Soft> : null}
      {cls.kind === 'key' || cls.kind === 'handle'
        ? <Btn label={cls.kind === 'key' ? 'Conferir pessoa' : 'Procurar @nome'} onPress={find} pending={resolving} disabled={offline} secondary />
        : null}
      {candidate
        ? (
          <View style={styles.inline}>
            <Text style={styles.name} numberOfLines={1}>{candidate.label}</Text>
            <Btn label='Convidar' onPress={() => invite(candidate.member, candidate.label)} pending={send.pending} disabled={offline} />
          </View>
          )
        : null}
      {localError ? <ErrorText>{localError}</ErrorText> : null}
      {searchable && (offline || search.phase === 'offline') ? <Soft>A busca precisa de internet.</Soft> : null}
      {searchable && search.phase === 'short' ? <Soft>Digite pelo menos 2 letras.</Soft> : null}
      {searchable && search.phase === 'error' ? <ErrorText>{search.error}</ErrorText> : null}
      {search.phase === 'loading' && hits.length === 0 ? <Skeleton rows={2} /> : null}
      {hits.map((hit) => {
        const who = whoOf({ name: hit.name, username: hit.username })
        const label = displayText(who.title)
        return (
          <View key={hit.author} style={styles.hit}>
            <View style={styles.hitWho}>
              <Avatar name={who.avatarName} publicKey={hit.author} size={44} />
              <View style={styles.hitText}>
                <Text style={styles.name} numberOfLines={1}>{label}</Text>
                {who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
              </View>
            </View>
            <Pill label='Convidar' onPress={() => invite(hit.author, label)} pending={send.pending} disabled={offline || send.pending} />
          </View>
        )
      })}
      {search.phase === 'ready' && hits.length === 0 && search.unchecked === 0 ? <Soft>Ninguém encontrado com esse nome.</Soft> : null}
      {held ? <Btn label='Tentar de novo' onPress={() => deliver(held.to, held.text, false, held.label)} pending={send.pending} disabled={offline} secondary /> : null}
      {held ? null : <ErrorText>{send.error}</ErrorText>}
      {result ? <Soft>{result}</Soft> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  name: { ...type.postName, color: colors.ink, flex: 1 },
  handle: { ...type.postMeta, color: colors.soft },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  hitWho: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  hitText: { flex: 1 }
})
