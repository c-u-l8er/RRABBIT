// RUNEFORT LAYOUT TESTS. Run: `node test/rune-layout.mjs` from RRABBIT/.
//
// The load-bearing assertion in this file is §1: a SECOND, unrelated format must
// fit the same three draw commands, or `bend-layout.js`'s "closed set" was only
// ever "what the first format needed".

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { layoutRune, floorsOf, classFor, runeMetrics, RUNE_THEME } from '../m2/paper/rune-layout.js'
import { runeToSpec, walk } from '../m2/paper/dom-spec.js'
import { wrapPlain, ellipsize } from '../m2/paper/wrap.js'

const here = dirname(fileURLToPath(import.meta.url))
const WELCOME = join(here, '..', '..', 'runefort.com', 'forts', 'welcome.json')

const measure = (text, f) => text.length * f.size * (f.weight >= 700 ? 0.62 : 0.6)
let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
}

const doc = JSON.parse(readFileSync(WELCOME, 'utf8'))
const floors = floorsOf(doc)
console.log(`welcome.json: ${floors.length} floors, ${floors.reduce((n, f) => n + (f.rooms?.length ?? 0), 0)} rooms\n`)

const KINDS = new Set(['rect', 'line', 'text'])
const W = 512, H = 340

// ---- 1. THE CLOSED-SET CLAIM ---------------------------------------------
{
  const all = new Set()
  for (const f of floors) for (const c of layoutRune(f, { width: W, height: H, measure }).commands) all.add(c.op)
  ok('a second format needs no fourth command kind', [...all].every((k) => KINDS.has(k)),
    [...all].join(','))
  ok('and it uses all three', all.size === 3, [...all].join(','))
}

// ---- 2. every real floor lays out ----------------------------------------
for (const f of floors) {
  let r = null, threw = null
  try { r = layoutRune(f, { width: W, height: H, measure }) } catch (e) { threw = e }
  ok(`floor ${f.id} lays out`, !threw, threw && threw.message)
  if (!r) continue
  ok(`floor ${f.id} draws every room`, r.stats.rooms === f.rooms.length, `${r.stats.rooms}/${f.rooms.length}`)
  ok(`floor ${f.id} shape detected`, r.stats.shape === 'campus')
  ok(`floor ${f.id} coords all finite`, r.commands.every((c) =>
    Number.isFinite(c.x) && Number.isFinite(c.y) && (c.op !== 'rect' || (Number.isFinite(c.w) && Number.isFinite(c.h)))))

  // Rooms must stay inside the pane. A grid that overflows its box is the bug
  // this format makes easiest to write.
  const rects = r.commands.filter((c) => c.op === 'rect').slice(1) // skip the background
  const out = rects.filter((c) => c.x < -0.5 || c.y < -0.5 || c.x + c.w > W + 0.5 || c.y + c.h > H + 0.5)
  ok(`floor ${f.id} rooms stay in the pane`, out.length === 0, `${out.length} outside`)
}

// ---- 3. both document shapes are accepted --------------------------------
{
  const flat = {
    runefort: '0.1', title: 'flat spec shape', grid: { columns: 4, rows: 2 },
    rooms: [{ id: 'a', position: [0, 0], size: [2, 1], label: 'memory' },
            { id: 'b', position: [2, 0], size: [2, 1], label: 'deploy' }],
    neighbors: [{ from: 'a', to: 'b', kind: 'adjacent' }],
    state_bindings: [{ room: 'a', signal: 'kappa', thresholds: [{ if: '< 0.3', class: 'cold' }, { if: '>= 0.6', class: 'hot' }] }],
  }
  const fs = floorsOf(flat)
  ok('flat spec §3 shape yields one floor', fs.length === 1, `${fs.length}`)
  ok('flat shape is reported as flat', layoutRune(fs[0], { width: W, height: H, measure }).stats.shape === 'flat')

  const r = layoutRune(fs[0], { width: W, height: H, measure })
  ok('flat shape draws its neighbour line', r.stats.neighbors === 1)
  ok('campus shape yields four floors', floors.length === 4, `${floors.length}`)
  ok('nothing at all yields no floors', floorsOf(null).length === 0 && floorsOf({}).length === 0)
}

// ---- 4. state bindings evaluate, and unknown classes degrade -------------
{
  const floor = floorsOf({
    rooms: [{ id: 'a', position: [0, 0], size: [1, 1] }],
    state_bindings: [{ room: 'a', signal: 'kappa', thresholds: [
      { if: '< 0.3', class: 'cold' }, { if: '< 0.6', class: 'warm' }, { if: '>= 0.6', class: 'hot' }] }],
  })[0]
  const room = floor.rooms[0]
  ok('signal 0.1 is cold', classFor(room, floor, { kappa: 0.1 }) === 'cold')
  ok('signal 0.45 is warm', classFor(room, floor, { kappa: 0.45 }) === 'warm')
  ok('signal 0.9 is hot', classFor(room, floor, { kappa: 0.9 }) === 'hot')
  ok('no signal is no class', classFor(room, floor, {}) === null)
  ok('a non-numeric signal is no class', classFor(room, floor, { kappa: 'warm' }) === null)
  ok('a malformed threshold does not throw', (() => {
    try { classFor(room, { state_bindings: [{ room: 'a', thresholds: [{ if: 'yes please' }] }] }, { kappa: 1 }); return true }
    catch { return false }
  })())

  // §2.4: unknown classes "should be ignored gracefully (treat as cold)".
  const uf = floorsOf({ rooms: [{ id: 'a', position: [0, 0], size: [1, 1], state_class: 'incandescent' }] })[0]
  const ur = layoutRune(uf, { width: W, height: H, measure })
  ok('unknown state class is counted', ur.stats.unknownClasses === 1)
  ok('unknown state class renders cold', ur.commands.some((c) => c.op === 'rect' && c.color === RUNE_THEME.state.cold.fill))

  // state_class on the room wins over a binding -- the shipped welcome.json uses
  // the former exclusively, so this is the path that actually runs.
  const both = { id: 'a', state_class: 'hot' }
  ok('explicit state_class beats a binding', classFor(both, floor, { kappa: 0.1 }) === 'hot')
}

// ---- 5. a neighbour to a room that is not here is dropped, not guessed ---
{
  const f = floorsOf({ rooms: [{ id: 'a', position: [0, 0], size: [1, 1] }],
    neighbors: [{ from: 'a', to: 'elsewhere' }, { from: 'ghost', to: 'a' }] })[0]
  const r = layoutRune(f, { width: W, height: H, measure })
  ok('dangling neighbours draw no line', r.stats.neighbors === 0)
  ok('and no line command is emitted for them', r.commands.filter((c) => c.op === 'line' && c.color === RUNE_THEME.neighbor).length === 0)
}

// ---- 6. compression is reported ------------------------------------------
{
  const tall = floorsOf({ rooms: Array.from({ length: 8 }, (_, i) => ({ id: 'r' + i, position: [0, i], size: [1, 1] })), columns: 1 })[0]
  tall.cell_height = '150px'
  const r = layoutRune(tall, { width: W, height: H, measure })
  ok('a floor too tall for the pane compresses', r.compressed === true)
  ok('and still draws all its rooms', r.stats.rooms === 8, `${r.stats.rooms}`)
  ok('rows counted', r.rows === 8, `${r.rows}`)

  const small = floorsOf({ rooms: [{ id: 'a', position: [0, 0], size: [1, 1] }], columns: 1 })[0]
  small.cell_height = '40px'
  ok('a floor that fits is not marked compressed', layoutRune(small, { width: W, height: 400, measure }).compressed === false)
}

// ---- 7. malformed rooms are skipped, never NaN-drawn --------------------
{
  const f = floorsOf({ rooms: [
    { id: 'ok', position: [0, 0], size: [1, 1] },
    { id: 'bad-pos', position: ['x', 0], size: [1, 1] },
    { id: 'no-pos', size: [1, 1] },
    null, 'not a room', 42,
  ] })[0]
  const r = layoutRune(f, { width: W, height: H, measure })
  ok('malformed rooms are skipped', r.stats.rooms === 2, `${r.stats.rooms} (ok + no-pos default)`)
  ok('no NaN geometry reaches the commands', r.commands.every((c) =>
    Object.values(c).every((v) => typeof v !== 'number' || Number.isFinite(v))))
}

// ---- 8. cell_height parsing ---------------------------------------------
{
  const mk = (ch) => { const f = floorsOf({ rooms: [{ id: 'a', position: [0, 0], size: [1, 1] }], columns: 1 })[0]; f.cell_height = ch; return f }
  for (const [ch, label] of [['150px', 'px string'], [150, 'bare number'], ['bogus', 'garbage'], [undefined, 'absent']]) {
    const r = layoutRune(mk(ch), { width: W, height: 900, measure })
    ok(`cell_height ${label} gives finite geometry`, r.commands.every((c) => c.op !== 'rect' || Number.isFinite(c.h)))
  }
}

// ---- 9. wrap helpers -----------------------------------------------------
{
  const f = { size: 12, weight: 400, italic: false, mono: false }
  const { lines } = wrapPlain('one two three four five six seven eight', f, 60, measure)
  ok('wrapPlain wraps', lines.length > 1, `${lines.length}`)
  ok('wrapPlain keeps every word', lines.join(' ').split(/\s+/).length === 8, lines.join('|'))

  const long = wrapPlain('supercalifragilistic', f, 10, measure)
  ok('an unwrappable word does not hang', long.lines.length >= 1)
  ok('and is not dropped', long.lines.join('').includes('supercalifragilistic'))

  ok('wrapPlain honours maxLines', wrapPlain('a b c d e f g h i j k', f, 20, measure, { maxLines: 2 }).lines.length === 2)
  ok('and reports clipping', wrapPlain('a b c d e f g h i j k', f, 20, measure, { maxLines: 2 }).clipped === true)

  ok('ellipsize leaves short text alone', ellipsize('hi', f, 500, measure).clipped === false)
  const e = ellipsize('a very long room label indeed', f, 40, measure)
  ok('ellipsize clips and says so', e.clipped === true && e.text.endsWith('…'), e.text)
  ok('ellipsized text fits', measure(e.text, f) <= 40)
}

// ---- 10. determinism -----------------------------------------------------
{
  const a = layoutRune(floors[0], { width: W, height: H, measure })
  const b = layoutRune(floors[0], { width: W, height: H, measure })
  ok('same floor, same commands', JSON.stringify(a.commands) === JSON.stringify(b.commands))
}

// ---- 11. a missing measure is refused ------------------------------------
{
  let threw = false
  try { layoutRune(floors[0], { width: W, height: H }) } catch { threw = true }
  ok('missing measure is refused', threw)
}

// ---- THE TWO TIERS AGREE ----------------------------------------------------
//
// This is the assertion the `runeMetrics` refactor exists to make, and without it
// the refactor is just moving numbers around. A runefort pane is drawn twice --
// on canvas at distance, as DOM when you enter it -- and the reported fault was
// that entering one re-flowed it: "the text and box sizes janks to a different
// size ... i want it to be consistent as it zooms it".
//
// Two renderers will never be glyph-identical. They CAN agree about geometry, and
// these are the numbers that decide whether a box moves or changes size.
{
  const floors = floorsOf(JSON.parse(readFileSync(WELCOME, 'utf8')))
  for (const f of floors) {
    for (const [W, H] of [[640, 420], [960, 631], [420, 300]]) {
      const M = runeMetrics(f, { width: W, height: H })
      const spec = runeToSpec(f, { classFor, metrics: M })

      const grid = []
      walk(spec, (n) => { if (n.attrs?.role === 'grid') grid.push(n) })
      const cells = []
      walk(spec, (n) => { if (n.attrs?.role === 'gridcell') cells.push(n) })

      // ROW HEIGHT was the worst of them: the canvas compresses rows to fill the
      // pane and a CSS grid with no explicit row size fits them to their content.
      ok(`${f.id} @${W}: the DOM grid uses the canvas row height`,
        grid[0]?.attrs.style.includes(`grid-auto-rows:${M.cellH}px`), grid[0]?.attrs.style)
      ok(`${f.id} @${W}: and the canvas gap`,
        grid[0]?.attrs.style.includes(`gap:${M.gap}px`))

      // The room text sizes the CSS used to hard-code at 13/11.
      const label = cells[0]?.children?.[0]
      ok(`${f.id} @${W}: the room label is the canvas label size`,
        label?.attrs?.style?.includes(`font-size:${M.labelSize}px`), label?.attrs?.style)
      ok(`${f.id} @${W}: rooms use the canvas horizontal padding`,
        cells[0]?.attrs.style.includes(`padding:6px ${M.roomPadX}px`))

      // The heading the DOM tier did not have at all. Its absence moved the whole
      // grid up by headAdvance + ruleGap, so every room was in the wrong place
      // even before any of them was the wrong size.
      const head = []
      walk(spec, (n) => { if (n.attrs?.class === 'rune-floor-head') head.push(n) })
      if (M.heading) {
        ok(`${f.id} @${W}: the DOM draws the floor heading the canvas draws`, head.length === 1)
        ok(`${f.id} @${W}: reserving the same vertical block`,
          head[0]?.attrs.style.includes(`height:${M.headAdvance}px`) &&
          head[0]?.attrs.style.includes(`margin-bottom:${M.ruleGap}px`))
      }

      // And the canvas really is drawing at those metrics, not at its own copy --
      // otherwise the DOM would be agreeing with a table nobody uses.
      const r = layoutRune(f, { width: W, height: H, measure })
      const labels = r.commands.filter((c) => c.op === 'text' && c.font?.weight >= 700 && c.font.size === M.labelSize)
      ok(`${f.id} @${W}: the canvas draws labels at that same size`, labels.length > 0)
      ok(`${f.id} @${W}: rows agree`, r.rows === M.rowsUsed)
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
