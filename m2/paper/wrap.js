// PLAIN-TEXT WORD WRAP. Shared by any layout whose text is a string rather than a
// run of differently-marked spans.
//
// `bend-layout.js` does NOT use this, and that is deliberate rather than an
// oversight: a BendScript paragraph is a sequence of spans with different fonts
// that must wrap as one stream, so its flow has to measure per token per font and
// cannot be expressed as "wrap this string". A RuneFort room body is a string.
// Two different problems; sharing the harder one would make the easy caller pay
// for a generality it never uses.

export function wrapPlain(text, f, maxW, measure, { maxLines = Infinity } = {}) {
  const out = []
  for (const para of String(text ?? '').split('\n')) {
    if (para === '') { out.push(''); continue }
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + word : word
      if (line && measure(next, f) > maxW) {
        out.push(line)
        // A single word wider than the box would loop forever if it were re-fed
        // to the same test, so it is placed alone and allowed to overhang. The
        // caller decides whether to clip; this function does not silently drop it.
        line = word
      } else {
        line = next
      }
      if (out.length >= maxLines) return { lines: out.slice(0, maxLines), clipped: true }
    }
    if (line) out.push(line)
    if (out.length >= maxLines) return { lines: out.slice(0, maxLines), clipped: true }
  }
  return { lines: out, clipped: false }
}

// Shorten to fit with an ellipsis. Returns the original when it already fits, so a
// caller can tell "clipped" from "happened to end in a full stop".
export function ellipsize(text, f, maxW, measure) {
  const s = String(text ?? '')
  if (measure(s, f) <= maxW) return { text: s, clipped: false }
  let t = s
  while (t.length > 1 && measure(t + '…', f) > maxW) t = t.slice(0, -1)
  return { text: t + '…', clipped: true }
}
