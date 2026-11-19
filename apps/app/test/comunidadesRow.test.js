'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

test('a community list row title wraps to two lines under large text', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Comunidades.js'), 'utf8')
  t.ok(src.includes('dot && styles.nameUnread]} numberOfLines={2}>{title}'), 'two title lines')
  t.absent(src.includes('styles.nameUnread]} numberOfLines={1}'), 'not cut to one')
})

test('group and community surfaces pass validated image props to their avatars', (t) => {
  const source = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8')
  for (const file of ['screens/Grupo.js', 'screens/Comunidade.js']) {
    const header = source(file).split('<ChatHeader')[1].split('/>')[0]
    t.ok(header.includes('{...pictureProps(info)}'), file + ' real header')
  }
  const communities = source('screens/Comunidades.js')
  t.ok(communities.includes('image={item.image}'))
  t.ok(communities.includes('imageAuthor={item.imageAuthor}'))
  t.ok(communities.includes('{...pictureProps({ image, imageAuthor })}'))
  const community = source('screens/Comunidade.js')
  t.ok(community.includes('publicKey={group} {...pictureProps({ image, imageAuthor })}'))
  const rows = community.match(/<GroupRow\b[^>]*>/g)
  t.is(rows.filter((row) => row.includes('image={g.image}') && row.includes('imageAuthor={g.imageAuthor}')).length, 3, 'all three live group row branches carry their own image')
  t.absent(rows.some((row) => row.includes('info.image')), 'never inherits the community image')
  t.absent(rows[0].includes('image='), 'index-only rows keep initials')
  const box = source('ui/CommunitiesBox.js')
  t.ok(box.includes('const picture = pictureProps(item)') && /<Avatar[^>]*\{\.\.\.picture\}/.test(box), 'Mark passes the validated picture')
  t.ok(box.includes("if (picture.picture === null) return <Icon name='gente'"), 'no image keeps the people icon')
  t.is((box.match(/<Mark item=\{item\}/g) || []).length, 2, 'strip and full list')
})
