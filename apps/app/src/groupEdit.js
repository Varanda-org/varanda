export const GROUP_ROOT_TEXT = 'Nome, entrada e foto não podem ser mudados neste aparelho.'

export function editState (info, role) {
  if (role !== 'creator') return 'none'
  return info?.rootHere === false ? 'other-device' : 'edit'
}

export function joinOptions (info, { group, general } = {}) {
  if (info?.visibility !== 'public') return []
  if (typeof info.community === 'string' && (typeof general !== 'string' || general === '' || group === general)) return []
  return [
    { value: 'open', label: 'Aberta' },
    { value: 'approval', label: 'Com aprovação' }
  ]
}
