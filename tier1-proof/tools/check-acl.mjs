/* check-acl — the static half, ported from super/cockpit/tools/check-webview-acl.mjs.
   ────────────────────────────────────────────────────────────────────────
   THE LAW
     A command this process registers is reachable only from a webview the
     capability names — and no capability names a WINDOW.

   THREE LISTS THAT EACH DRIFT ALONE:
     src/main.rs     generate_handler![…]        what is REGISTERED
     build.rs        AppManifest::commands(&[…]) what is IN THE ACL
     capabilities/   permissions: […]            what is GRANTED

   A command registered but absent from build.rs is OUTSIDE the ACL and fails
   OPEN. A granted permission for a command that no longer exists reads as
   coverage and is not.

   ROAD_SHELL.md §6 adds one law to the cockpit's set:
     NO CAPABILITY MAY NAME MORE THAN ONE WEBVIEW, and the surface holding a
     privileged grant must be named alone.                                 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let held = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { held++; console.log(`  \x1b[32mheld\x1b[0m         ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAILED\x1b[0m       ${name}${detail ? ` — ${detail}` : ''}`); }
};

const main = readFileSync(`${ROOT}/src/main.rs`, 'utf8');
const build = readFileSync(`${ROOT}/build.rs`, 'utf8');
const principal = readFileSync(`${ROOT}/src/principal.rs`, 'utf8');

const registered = [...main.matchAll(/^\s{12}(\w+),$/gm)].map((m) => m[1]);
const inAcl = [...build.matchAll(/^\s{12}"([\w_]+)",$/gm)].map((m) => m[1]);
const caps = readdirSync(`${ROOT}/capabilities`)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, json: JSON.parse(readFileSync(`${ROOT}/capabilities/${f}`, 'utf8')) }));

console.log(`\n  ${registered.length} registered · ${inAcl.length} in ACL · ${caps.length} capabilities\n`);

check('every registered command is declared to the ACL',
  registered.every((c) => inAcl.includes(c)),
  registered.filter((c) => !inAcl.includes(c)).join(', '));
check('every ACL command is actually registered',
  inAcl.every((c) => registered.includes(c)),
  inAcl.filter((c) => !registered.includes(c)).join(', '));

const granted = new Set(caps.flatMap((c) => c.json.permissions ?? []));
check('every granted permission names a command that exists',
  [...granted].every((p) => inAcl.includes(p.replace(/^allow-/, '').replace(/-/g, '_'))),
  [...granted].filter((p) => !inAcl.includes(p.replace(/^allow-/, '').replace(/-/g, '_'))).join(', '));

/* §6 — the law the substitution reopens with one word. */
for (const c of caps) {
  check(`${c.file} names webviews and NOT windows`,
    Array.isArray(c.json.webviews) && c.json.webviews.length > 0 && !('windows' in c.json),
    'windows' in c.json ? 'a window grant reaches every webview inside that window' : 'no webviews key');
  check(`${c.file} names exactly one webview`,
    (c.json.webviews ?? []).length === 1, `names ${(c.json.webviews ?? []).length}`);
}

/* §6.2 consequence 1 — `by` never reaches a decision. */
check('`by` does not appear in the authority module at all',
  !/\bby\b/.test(principal.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  'the principal module mentions `by` outside comments');
/* STRONGER THAN THE FIRST VERSION, which asserted `surface: &str`. A string
   parameter is a check you can satisfy by building its argument: any caller,
   including one inside this crate, could pass a label the page chose. Taking
   the injected webview puts the rule in the type system. */
check('`authorize` takes the INJECTED webview, never a label string',
  /pub fn authorize\(\s*&self,\s*webview: &tauri::Webview,/.test(principal)
    && !/pub fn authorize\([^)]*surface: &str/.test(principal));
check('`resolve` takes the injected webview too',
  /pub fn resolve\(&self, webview: &tauri::Webview\)/.test(principal));

/* §6.2 — a request must not be able to name the authoritative pane. */
const cmds = [...main.matchAll(/#\[tauri::command\]\s*(?:async\s+)?fn\s+(\w+)\(([^)]*)\)/g)];
check('no command takes a webview label from the page',
  cmds.every(([, , args]) => !/\blabel\s*:/.test(args)),
  cmds.filter(([, n, a]) => /\blabel\s*:/.test(a)).map(([, n]) => n).join(', '));
check('no command takes a grants argument',
  cmds.every(([, , args]) => !/\bgrants?\s*:/.test(args)));

/* §5 — manifest discovery is the coordinator's, so the road fetches nothing. */
const road = readFileSync(`${ROOT}/ui/index.html`, 'utf8');
check('the road page contains no `fetch` at all — the sign comes from the host',
  !/\bfetch\s*\(/.test(road));
check('the CSP does not permit the road to fetch its own origin',
  /* [^;"] and not [^"] — the first version ran past the semicolon into
     `img-src 'self'` and reported a permissive connect-src that was not there.
     A gate that is wrong in the SAFE direction still has to be fixed: it would
     have gone green the day connect-src really did allow 'self'. */
  !/connect-src[^;"]*'self'/.test(readFileSync(`${ROOT}/tauri.conf.json`, 'utf8')));

/* §6.2.1 — a privileged command must be checked before any effect. */
const intent = main.slice(main.indexOf('fn privileged_intent'));
check('privileged_intent authorizes before it can produce anything',
  intent.indexOf('authorize') < intent.indexOf('Ok(json!'));

console.log(`\n  ${held} held · ${failed} failed\n`);
process.exit(failed ? 1 : 0);
