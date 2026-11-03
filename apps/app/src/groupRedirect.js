// Pure decisions of the /g/ link flow between Grupo and Comunidade (no React,
// no Node built-ins), so the rules that stop a navigation loop are tested.

const MEMBER_ROLES = ['creator', 'admin', 'member']

export function isCommunityMember (role) {
  return MEMBER_ROLES.includes(role)
}

// Grupo opens the group's community only for someone who is not a member of
// it, or after group.join was refused with 'entre na comunidade primeiro'. A
// member whose group root has not arrived stays on the group and waits.
// A refused join always redirects, whatever role the node reports (community.info
// answers 'left' for someone who never joined). Without a refusal, a group the
// person left is not chased into its community.
export function shouldRedirectToCommunity ({ communityRole, refused, groupRole }) {
  if (refused === true) return true
  if (groupRole === 'left') return false
  return communityRole !== undefined && !isCommunityMember(communityRole)
}

// Comunidade opens the queued group at most once, and only when the person
// was not a member when the screen first loaded and is one now (a join that
// changed the role). Someone who already was a member never gets pushed to a
// group that sent them here.
export function shouldOpenQueued ({ queued, firstRole, role }) {
  if (typeof queued !== 'string' || queued === '') return false
  if (firstRole === null || firstRole === undefined) return false
  return !isCommunityMember(firstRole) && isCommunityMember(role)
}
