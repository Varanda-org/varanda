'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

test('a community list row title wraps to two lines under large text', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Comunidades.js'), 'utf8')
  t.ok(src.includes('dot && styles.nameUnread]} numberOfLines={2}>{title}'), 'two title lines')
  t.absent(src.includes('styles.nameUnread]} numberOfLines={1}'), 'not cut to one')
})
