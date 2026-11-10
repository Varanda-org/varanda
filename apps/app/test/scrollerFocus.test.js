'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/ui/scrollerFocus.web.js')

function node ({ role = false, tabindex = false, sh = 100, ch = 100, sw = 50, cw = 50, tagName = 'DIV', editable = false } = {}) {
  let blurred = false
  return {
    tagName,
    isContentEditable: editable,
    getAttribute: () => null,
    hasAttribute: (a) => (a === 'role' ? role : a === 'tabindex' ? tabindex : false),
    scrollHeight: sh,
    clientHeight: ch,
    scrollWidth: sw,
    clientWidth: cw,
    blur () { blurred = true },
    get blurred () { return blurred }
  }
}

test('a plain scrolling container gives focus up, a control keeps it', async (t) => {
  const { scrollerFocusProps, isPlainScroller } = await load()
  const body = node({ sh: 900, ch: 400 })
  scrollerFocusProps.onFocus({ target: body })
  t.ok(body.blurred, 'the sheet body that scrolls is skipped by the focus trap')
  const button = node({ role: true, sh: 900, ch: 400 })
  scrollerFocusProps.onFocus({ target: button })
  t.absent(button.blurred, 'a control keeps focus even if it scrolls')
  const tabbable = node({ tabindex: true, sh: 900, ch: 400 })
  t.absent(isPlainScroller(tabbable), 'an element with its own tabindex keeps focus')
  const still = node()
  t.absent(isPlainScroller(still), 'a container that does not scroll is left alone')
  scrollerFocusProps.onFocus({ target: null })
  t.pass('no target is ignored')
})

test('every sheet and menu panel carries the guard, and native is a no-op', (t) => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', f), 'utf8')
  t.ok(read('Sheet.js').includes('{...scrollerFocusProps}'))
  t.ok(read('ActionsSheet.js').includes('{...scrollerFocusProps}'))
  t.ok(read('scrollerFocus.native.js').includes('export const scrollerFocusProps = {}'))
})

test('an overflowing text field keeps focus', async (t) => {
  const { scrollerFocusProps, isPlainScroller } = await load()
  const bio = node({ tagName: 'TEXTAREA', sh: 400, ch: 80 })
  scrollerFocusProps.onFocus({ target: bio })
  t.absent(bio.blurred, 'a long bio can still be edited')
  t.absent(isPlainScroller(node({ tagName: 'INPUT', sw: 900, cw: 200 })), 'a long single-line input')
  t.absent(isPlainScroller(node({ editable: true, sh: 400, ch: 80 })), 'contenteditable')
})
