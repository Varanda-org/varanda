// Imported by index.js right after the crypto polyfill: the first boot mark,
// and so the origin every later mark of this run counts from (the extra word
// says so in the log).
import { bootMark, perfOn } from './perfMarks'

if (perfOn) bootMark('js-entry', 'origin')
