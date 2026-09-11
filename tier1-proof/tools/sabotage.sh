#!/usr/bin/env bash
# sabotage — prove the battery can go red. ROAD_SHELL.md §12.2.
#
# A green suite is evidence only if a broken implementation turns it red. Each
# sabotage breaks ONE law and names the assertion that must fail.
#
# RESTORE MUST REBUILD. Restoring the source alone leaves the SABOTAGED BINARY
# in target/release and the next run silently measures it — that happened, and
# cost a confused re-run. Same class as the baked-UI trap (ROAD_SHELL.md
# §10.7): the artifact is not the source.
set -u
cd "$(dirname "$0")/.."
BK=$(mktemp -d)
cp src/principal.rs src/main.rs "$BK/"
restore() {
  cp "$BK/principal.rs" "$BK/main.rs" src/
  cargo build --release >/dev/null 2>&1
}
trap restore EXIT

run() {  # $1 = label, $2 = text that MUST appear in a FAILED line
  if ! cargo build --release >/dev/null 2>&1; then
    echo "  DOES NOT COMPILE  $1"
    echo "      (a sabotage the type system refuses is hardening, not coverage —"
    echo "       the law still needs a falsifier that CAN be written)"
    return
  fi
  out=$(timeout 300 node tools/proof-battery.mjs 2>&1)
  # THREE OUTCOMES, NOT TWO. The first version printed "the battery stayed
  # green over a broken law" whenever its grep missed — and it missed twice,
  # on sabotages that HAD reddened the battery, just not on the line the
  # pattern named. A sweep that reports a red run as green is worse than no
  # sweep: it retires a law that is in fact tested, and it did.
  if echo "$out" | grep -q "FAILED.*$2"; then
    echo "  IS A FALSIFIER    $1"
    echo "$out" | grep "FAILED" | sed 's/^/      /'
  elif echo "$out" | grep -q "FAILED"; then
    echo "  RED, BUT NOT ON THE NAMED LAW    $1"
    echo "      expected a FAILED line matching: $2"
    echo "$out" | grep "FAILED" | sed 's/^/      /'
  else
    echo "  NOT A FALSIFIER   $1  — the battery stayed green over a broken law"
    echo "$out" | tail -2 | sed 's/^/      /'
  fi
}

echo
echo "  S1 · give the road the \`intent\` grant (breaks §6.2: grants are host-assigned)"
sed -i 's|"main" => &\["place", "promote", "demote", "status", "manifest"\],|"main" => \&["place", "promote", "demote", "status", "manifest", "intent"],|' src/principal.rs
run "S1 road holds intent" "privileged op"
restore

echo
echo "  S2 · drop the generation check (breaks §6.2 #4: a revoked binding still acts)"
sed -i 's|        if generation != gen_now {|        if false \&\& generation != gen_now {|' src/principal.rs
run "S2 no generation check" "generation"
restore

echo
echo "  S3 · let the clock say \`gone\` (breaks §10.1: a timeout may only say unresponsive)"
sed -i 's|Some(t) if t.elapsed() > BEAT_TIMEOUT => "unresponsive",|Some(t) if t.elapsed() > BEAT_TIMEOUT => "gone",|' src/principal.rs
run "S3 timeout reports gone" "unresponsive"
restore

# S4 HAD TO BE REWRITTEN. The original passed `by` to `authorize` as the
# surface — and once `authorize` takes the injected `&tauri::Webview`, that
# sabotage NO LONGER COMPILES. Making a falsifier inexpressible is the
# hardening working; but a law with no writable falsifier is untested, so the
# sabotage moved to the shape the type system cannot prevent: a short-circuit
# BEFORE the check.
echo
echo "  S4 · short-circuit on the caller's \`by\` before authorize (breaks §6.2 #1)"
python3 - <<'PY'
s = open('src/main.rs').read()
old = '    match bindings.authorize(&webview, generation, "intent") {'
new = ('    if by.as_deref() == Some("cockpit") {\n'
       '        return Ok(json!({ "accepted": payload, "by_annotation": by }));\n'
       '    }\n'
       '    match bindings.authorize(&webview, generation, "intent") {')
assert old in s, 'S4 anchor missing'
open('src/main.rs', 'w').write(s.replace(old, new, 1))
PY
run "S4 by short-circuits the check" "forging by"
restore

# S5 — the geometry gate must be a falsifier too, or "the road survives its own
# pane" is a sentence rather than a check. This is the one the STATIC gate
# cannot catch: an identical sabotage was injected here by accident and only
# the live geometry assertion found it.
echo
# S5's LAW MOVED, and the sweep is what said so. It used to break "the road
# collapses to one pixel" — but once the pane is contained until its
# allocation is correct, skipping the layout means the pose never arrives and
# the promote is ABANDONED, so the road never sees a collapsed surface at all.
# The reporter called it RED, BUT NOT ON THE NAMED LAW, which is exactly what
# it is for: the sabotage still bites, on a different assertion. What it now
# exercises is containment plus abandonment.
echo "  S5 · skip the read-pose layout (now: the pose never arrives, so the promote is abandoned)"
python3 - <<'PY'
s = open('src/main.rs').read()
old = '    if let Err(e) = layout::place(&child, &rect) {'
new = '    if let Err(e) = (if true { Ok(()) } else { layout::place(&child, &rect) }) {'
assert old in s, 'S5 anchor missing'
open('src/main.rs', 'w').write(s.replace(old, new, 1))
PY
run "S5 no read-pose layout" "never visible or interactive outside its rectangle"
restore
echo

# S6 — the `whoami` hole. Revert the pane label to a REUSABLE constant, which
# is what the design looked like before instance-scoped bindings. An old
# instance that outlives its close can then call `whoami`, resolve the name to
# whichever binding now holds it, and come back carrying the SUCCESSOR's
# generation — it stops being old. The registry unit tests exercise the
# refusal deterministically; this proves the LIVE battery notices the shape.
echo
echo "  S6 · make the pane label reusable again (breaks §6.2: whoami leaks the successor)"
python3 - <<'PYX'
s = open('src/principal.rs').read()
old = 'format!("pane-{}", g.next_generation + 1)'
new = '"pane-1".to_string()'
assert old in s, 'S6 anchor missing'
open('src/principal.rs', 'w').write(s.replace(old, new, 1))
PYX
run "S6 reusable pane label" "NEW instance label"
restore

# S7 — reveal the pane before its allocation is the read pose. THE CONTAINMENT
# LAW. Eventual geometry was already green while an untrusted pane covered the
# whole road and took input over all of it for ~2.7 s. Nothing static can
# catch this: an identical sabotage has now been injected by accident TWICE,
# and both times the live geometry gate was the only thing that noticed.
echo
echo "  S7 · reveal before the pose is reached (breaks §10.6.3: containment)"
python3 - <<'PYX'
s = open('src/main.rs').read()
old = '        if (got.0 - want.0).abs() <= 2 && (got.1 - want.1).abs() <= 2 {'
new = '        if true || ((got.0 - want.0).abs() <= 2 && (got.1 - want.1).abs() <= 2) {'
assert old in s, 'S7 anchor missing'
open('src/main.rs', 'w').write(s.replace(old, new, 1))
PYX
run "S7 revealed before the pose" "never visible or interactive outside its rectangle"
restore
echo
