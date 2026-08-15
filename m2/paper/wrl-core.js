// VENDORED FROM `WRL/wrl.js` -- the browser port of the identity spine.
//
// A COPY, and copies drift. `test/wiring.mjs` seals WRL's own pinned conformance
// fixture with THIS file and asserts the upstream id, so a stale or damaged copy
// fails a test rather than silently sealing roads to ids nobody else computes.
//
// Copied rather than imported because the shell's build root is `RRABBIT/` and the
// spine lives outside it. Re-copy with:
//   cp ../WRL/wrl.js m2/paper/wrl-core.js   (then re-add this header)

/* wrl.js -- WallRiderLang Core 0.1.2 identity spine, ported to the browser.
 *
 * A re-implementation of the Forge front-half:
 *
 *     WRL Core source
 *       -> desugarCore        (wrl_sugar.py, sugar.v2)
 *       -> parseWrlCore       (wrl_ir.py, the STRICT world mouth)
 *       -> canonicalizeGraph  (wrl_canonical.py)
 *       -> graphToIr          (Forge Semantic IR v1)
 *       -> serializeArtifact  (deterministic canonical bytes)
 *       -> semanticArtifactId (sem- + sha256)
 *
 * The reference implementation's canonical bytes are
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"))`, and every value in
 * a sealed artifact is an ASCII string, an integer, a boolean, or a list/object
 * of those. So a recursive key-sorted serializer reproduces them EXACTLY, and
 * WebCrypto SHA-256 reproduces the id.
 *
 * Ground truth (checked against the Python spine):
 *   the starter world seals to
 *   sem-67e954cfe3115166b49388366df3f062a46572ba2baf53380f1520f4050b60ae
 *   the pinned conformance fixture seals to
 *   sem-8ae91fe9cbc5fd086ce4356d587c403211e5c7b2b3ebdd316496367429ecfe4a
 *
 * ---------------------------------------------------------------------------
 * TWO STATED DIVERGENCES FROM THE CURRENT FORGE PYTHON PARSER
 * ---------------------------------------------------------------------------
 * Both are REJECTIONS. Neither can move an id: for every world both mouths
 * accept, the canonical bytes are identical.
 *
 *   1. SURFACE HYGIENE (this module is stricter). `wrl_ir._parse_core_permissive`
 *      silently drops unknown config keys and bare flags, keeps the last of a
 *      duplicated key, discards edge role prefixes, collapses a duplicated port
 *      name, and installs the default profile when no `profile` line appears.
 *      Visible source is never silently ignored here: each of those is a typed
 *      rejection. This is the intended Core 0.1.3 tightening, implemented in
 *      the browser spine first because it is the surface an author touches.
 *
 *   2. INTEGER EXACTNESS (this module was previously looser). Python's `int()`
 *      is exact and total-or-raise; a first cut of this port used `parseInt`,
 *      which accepts numeric PREFIXES ("2x" -> 2) and silently rounds past
 *      2^53. Every artifact integer now goes through `strictInt`, and rotor
 *      lanes are carried as BigInt, so `9223372036854775807` serializes as
 *      itself rather than as 9223372036854776000.
 *
 * `parseWrlLegacyDocument` is a MIGRATION BRIDGE and keeps the permissive
 * profile behaviour on purpose; the surface-hygiene checks apply to it too.
 *
 * This is the SEMANTIC half only. Lowering to a backend, compiling to
 * interaction-calculus terms, and reducing to a Film all live in TRVM.
 */

export const IR_VERSION = "1.0";
export const IR_VERSION_V1_1 = "1.1";
export const PROFILE_ID = "forge.world.core.v1";
export const RULEPACK_ID = "forge.world.core.rules.v1";
export const ADMIT_POLICY_ID = "admit_candidate_min_firstreceipt_v1";
export const MAILBOX_ADMIT_POLICY_ID = "admit_mailbox_deliver_all_v1";
export const FILM_SCHEMA_ID = "film.v0.7";
export const FILM_SCHEMA_ID_MAILBOX = "film.v0.7.mailbox.v1";
export const NUMERIC_POLICY_IDS = ["POLICY_FORGE"];
export const SUGAR_VERSION = "sugar.v2";

export const ROLE_IDS = ["Pulser", "Relay", "Door", "Spinner", "Orb", "Mailbox"];
export const MAILBOX_ROLE = "Mailbox";
export const EDGE_KINDS = ["SignalWire", "SocketControl"];

/* The registry is NOT the text surface. `SURFACE_ROLE_IDS` is the projection
 * of ROLE_IDS that WRL Core source can spell; UNWRITABLE_ROLE_IDS are frozen
 * registry roles with ports, a config schema and runtime meaning but no
 * surface form yet (Core 0.1.2 sec.14b). The parser refuses to read them and
 * `formatCore` refuses to WRITE them -- an emitter that produced text its own
 * parser rejects would break the round-trip law it exists to serve. */
export const SURFACE_ROLE_IDS = ["Pulser", "Relay", "Door", "Spinner", "Orb"];
export const UNWRITABLE_ROLE_IDS = ROLE_IDS.filter(
  (r) => !SURFACE_ROLE_IDS.includes(r));

/* per-role port signatures (frozen) */
export const PORTS = {
  Pulser:  { out: ["sig_out"], in: [] },
  Relay:   { out: ["sig_out"], in: ["sig_in"] },
  Door:    { out: [],          in: ["sig_in"] },
  Spinner: { out: ["socket"],  in: ["sig_in"] },
  Orb:     { out: [],          in: ["pose"] },
  Mailbox: { out: [],          in: [] },
};

export const EDGE_PORTS = {
  SignalWire:    ["sig_out", "sig_in"],
  SocketControl: ["socket", "pose"],
};

export const ROLE_CONFIG_SCHEMA = {
  Pulser:  { surface_keys: ["mode", "period", "phase", "epoch"],
             static_config_keys: ["clock"] },
  Relay:   { surface_keys: [], static_config_keys: [] },
  Door:    { surface_keys: [], static_config_keys: [] },
  Spinner: { surface_keys: ["w", "n", "rotor", "configurable"],
             static_config_keys: ["w", "n", "rotor", "configurable"] },
  Orb:     { surface_keys: [], static_config_keys: [] },
  Mailbox: { surface_keys: ["w", "cap"], static_config_keys: ["w", "cap"] },
};

export const MAILBOX_WIDTH_MAX = 32;

/* ------------------------------------------------------------ error codes */

/* The FULL Forge toolchain catalog. Codes marked `browser: false` below belong
 * to stages this module does not run (sealing wrappers, backend lowering
 * profiles, artifact round-tripping) and are listed so the published table is
 * the toolchain's, not this module's. `browserCodes()` is the honest subset. */
export const CODES = {
  WRL_DUPLICATE_ID: "a second object claims an id already declared",
  WRL_UNKNOWN_ENDPOINT: "an edge names an object that was never declared",
  WRL_ILLEGAL_PORT_PAIR: "an edge asks for a port the role does not have",
  WRL_CONTROLLER_CONFLICT: "two controllers reach the same input port",
  WRL_CLOCK_RANGE: "a pulser clock is outside its legal range",
  WRL_NUMERIC_RANGE: "a numeric field is outside its legal range",
  WRL_EPOCH_RANGE: "an epoch index is outside the declared run",
  WRL_UNSUPPORTED_FEATURE: "the construct is outside frozen Semantic IR v1",
  WRL_UNSEALED_POLICY: "a semantic policy id is null or empty",
  WRL_MALFORMED_ARTIFACT: "the artifact record has the wrong shape",
  WRL_PORT_SIGNATURE: "a {ports} group does not match the frozen signature",
  WRL_BAD_LOWERING_PROFILE: "a backend lowering profile is half-specified",
  WRL_SEALED_IMMUTABLE: "something tried to write to a sealed object",
  WRL_UNKNOWN_ARTIFACT_FIELD: "a sealed record carries an unknown field",
  WRL_WORLD_SOURCE_HAS_SCENARIO: "run inputs appeared in world source",
  WRL_SUGAR_MALFORMED: "a sugared spelling could not be expanded",
  WRL_MISSING_PROFILE: "world source did not open with a profile line",
  WRL_DUPLICATE_PROFILE: "world source declares the profile more than once",
  WRL_MALFORMED_PROFILE: "the profile line is not exactly 'profile <id>'",
  WRL_UNKNOWN_CONFIG_KEY: "a declaration carries a key the role does not define",
  WRL_DUPLICATE_CONFIG_KEY: "a declaration sets the same key twice",
  WRL_ROLE_PREFIX_MISMATCH: "an edge asserts a role the object does not have",
};

/* Codes this browser module can actually raise. Everything else in CODES
 * belongs to a Forge stage that runs outside the browser. */
export const BROWSER_CODE_IDS = [
  "WRL_DUPLICATE_ID", "WRL_UNKNOWN_ENDPOINT", "WRL_ILLEGAL_PORT_PAIR",
  "WRL_CONTROLLER_CONFLICT", "WRL_CLOCK_RANGE", "WRL_NUMERIC_RANGE",
  "WRL_EPOCH_RANGE", "WRL_UNSUPPORTED_FEATURE", "WRL_MALFORMED_ARTIFACT",
  "WRL_PORT_SIGNATURE", "WRL_WORLD_SOURCE_HAS_SCENARIO", "WRL_SUGAR_MALFORMED",
  "WRL_MISSING_PROFILE", "WRL_DUPLICATE_PROFILE", "WRL_MALFORMED_PROFILE",
  "WRL_UNKNOWN_CONFIG_KEY", "WRL_DUPLICATE_CONFIG_KEY",
  "WRL_ROLE_PREFIX_MISMATCH",
];

export function browserCodes() {
  return Object.fromEntries(BROWSER_CODE_IDS.map((k) => [k, CODES[k]]));
}

export class WrlError extends Error {
  constructor(code, message, opts = {}) {
    super(`[${code}] ${message}`);
    this.name = "WrlError";
    this.code = code;
    this.detail = message;
    this.line = opts.line ?? null;
    this.locator = opts.locator ?? null;
    this.fieldPath = opts.fieldPath ?? null;
  }
}

function fail(code, message, opts) {
  throw new WrlError(code, message, opts);
}

/* =========================================================== EXACT INTEGERS */

/* Python's `int()` is exact and total-or-raise. `parseInt` is neither: it
 * accepts a numeric PREFIX ("2x" -> 2, "181x.0.0.181" -> 181) and it rounds
 * silently once the value passes 2^53. Both defects are identity defects --
 * the first invents a value the author did not write, the second writes a
 * value into the canonical bytes that the author did not write. So every
 * artifact integer goes through here. */
const INT_LITERAL_RE = /^[+-]?\d+$/;

/** An exact BigInt from a COMPLETE integer literal, or a typed rejection. */
export function strictBigInt(text, what, opts) {
  const s = String(text ?? "").trim();
  if (!INT_LITERAL_RE.test(s)) {
    fail("WRL_NUMERIC_RANGE",
      `${what} must be a complete integer literal, got '${text}'`, opts);
  }
  return BigInt(s);
}

/* Artifact scalars other than rotor lanes (w, n, period, phase, epoch, cap)
 * are carried as JS numbers, so they are bounded to the safe integer range.
 * That bound is DECLARED, not hoped for: a value outside it is refused rather
 * than rounded. Rotor lanes have no such bound because they are BigInt. */
export const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;   // 2^53 - 1

/** An exact JS integer, guaranteed representable, or a typed rejection. */
export function strictInt(text, what, opts) {
  const v = strictBigInt(text, what, opts);
  if (v > BigInt(SAFE_INT_MAX) || v < -BigInt(SAFE_INT_MAX)) {
    fail("WRL_NUMERIC_RANGE",
      `${what} = ${v} is outside the declared exact-integer range ` +
      `+/-${SAFE_INT_MAX}; rotor lanes are the only unbounded artifact ` +
      `integers (they are carried as BigInt)`, opts);
  }
  return Number(v);
}

/** Strict booleans. `configurable=maybe` is not a false -- it is a rejection. */
function strictBool(text, what, opts) {
  const s = String(text).trim();
  if (s === "true") return true;
  if (s === "false") return false;
  fail("WRL_UNSUPPORTED_FEATURE",
    `${what} must be 'true' or 'false', got '${text}'`, opts);
}

/* ============================================================ VALUE SUGAR */

/* The frozen EXACT named-rotor table. Each entry is a pure function of the
 * spinner's fractional width n; all four are exact at ANY n because their
 * quaternion components are 0 or 1 (unit = 1 << n). */
export const NAMED_ROTOR_TABLE = {
  identity:  (n) => [1n << BigInt(n), 0n, 0n, 0n],
  reverse_x: (n) => [0n, 1n << BigInt(n), 0n, 0n],
  reverse_y: (n) => [0n, 0n, 1n << BigInt(n), 0n],
  reverse_z: (n) => [0n, 0n, 0n, 1n << BigInt(n)],
};

export const NAMED_ROTOR_RNE_SYM_POLICY = "forge_named_rotor_rne_sym_v1";

/* integer square root over BigInt (Newton), so the projection below never
 * touches a float. */
function isqrtBig(v) {
  if (v < 2n) return v;
  let x = v, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + v / x) / 2n; }
  return x;
}

/* round(2^n / sqrt(2)) by EXACT integer arithmetic. With U = 2^n:
 *   q0 = floor(U/sqrt(2)) = isqrt(2*U*U) // 2
 *   round up iff 2*U*U > 4*q0^2 + 4*q0 + 1
 * so q4 = 11, q8 = 181, q16 = 46341. */
export function roundUOverSqrt2(n) {
  const u = 1n << BigInt(n);
  const twoUU = 2n * u * u;
  const q0 = isqrtBig(twoUU) / 2n;
  return twoUU > 4n * q0 * q0 + 4n * q0 + 1n ? q0 + 1n : q0;
}

/* The forge_named_rotor_rne_sym_v1 projection of a 90-degree turn about z:
 * (q,0,0,q), each lane rounded INDEPENDENTLY to nearest, NO residual
 * redistribution, canonical sign scalar > 0. Because the value depends on n,
 * the SemanticArtifactID is geometry-dependent: the same name at a different
 * spinner n lowers to a different rotor and hence a different id. */
export const NAMED_ROTOR_POLICY_TABLE = {
  quarter_turn_z: [NAMED_ROTOR_RNE_SYM_POLICY, (n) => {
    const q = roundUOverSqrt2(n);
    return [q, 0n, 0n, q];
  }],
};

export const ROTOR_TABLE_NAMES = Object.keys(NAMED_ROTOR_TABLE);
export const POLICY_ROTOR_NAMES = Object.keys(NAMED_ROTOR_POLICY_TABLE);
export const ALL_ROTOR_NAMES = [...ROTOR_TABLE_NAMES, ...POLICY_ROTOR_NAMES];

export const CLOCK_SUGAR_FORMS = ["every K", "every K, phase P", "once at E"];

export function namedRotor(name, n) {
  if (name in NAMED_ROTOR_TABLE) return NAMED_ROTOR_TABLE[name](n);
  if (name in NAMED_ROTOR_POLICY_TABLE) return NAMED_ROTOR_POLICY_TABLE[name][1](n);
  fail("WRL_UNSUPPORTED_FEATURE",
    `named rotor '${name}' not in the accepted vocabulary ` +
    `[${ALL_ROTOR_NAMES.slice().sort().join(", ")}]`);
}

/** The build-provenance policy governing a named rotor, or null when exact.
 *  The policy id is provenance only -- it never enters the artifact bytes. */
export function namedRotorPolicy(name) {
  if (name in NAMED_ROTOR_TABLE) return null;
  if (name in NAMED_ROTOR_POLICY_TABLE) return NAMED_ROTOR_POLICY_TABLE[name][0];
  fail("WRL_UNSUPPORTED_FEATURE",
    `named rotor '${name}' not in the accepted vocabulary`);
}

/* ======================================================= STRUCTURAL SUGAR */

export const REPLICATION_BASE = 0;
export const REPLICATION_MAX = 1024;
export const FANOUT_MAX = 1024;
export const EXPANSION_MAX_LINES = 65536;
const MAX_COUNT_DIGITS = 9;

const REPL_DECL_RE = /^\s*\[(\w+):(\w+)\*(\d+)\]\s*(.*)$/;
const REPL_REF_RE  = /^((?:\w+:)?)(\w+)\*(\d+)$/;
const FANOUT_RE    = /^\s*\[([^\]]+)\]\s*--(\w+)-->\s*\{([^}]*)\}\s*$/;
const EDGE_SUGAR_RE = /^\s*\[([^\]]+)\]\s*--(\w+)-->\s*\[([^\]]+)\]\s*$/;

function checkedCount(digits, where) {
  /* The digit cap is checked BEFORE the value is read, so that an absurd
   * literal is refused as a literal rather than being turned into a number
   * first. Note it is a cap on DIGITS, not on the count -- reporting
   * REPLICATION_MAX here would answer a question nobody asked. */
  if (digits.length > MAX_COUNT_DIGITS) {
    fail("WRL_NUMERIC_RANGE",
      `replication count in '${where}' has ${digits.length} digits; ` +
      `at most ${MAX_COUNT_DIGITS} are read (and the count itself may not ` +
      `exceed ${REPLICATION_MAX})`);
  }
  const n = strictInt(digits, `replication count in '${where}'`);
  if (n < 1) fail("WRL_NUMERIC_RANGE", `replication count must be >= 1, got '${where}'`);
  if (n > REPLICATION_MAX) {
    fail("WRL_NUMERIC_RANGE",
      `replication count ${n} in '${where}' exceeds REPLICATION_MAX=` +
      `${REPLICATION_MAX}; write the members explicitly if a group this ` +
      `large is intended`);
  }
  return n;
}

const member = (prefix, base, i) => `${prefix}${base}${REPLICATION_BASE + i}`;

function replParts(endpoint) {
  const m = REPL_REF_RE.exec(endpoint.trim());
  if (!m) return null;
  return [m[1], m[2], checkedCount(m[3], endpoint.trim())];
}

function desugarDeclReplication(code) {
  const m = REPL_DECL_RE.exec(code);
  if (!m) return null;
  const [, role, base, digits, tail] = m;
  const n = checkedCount(digits, code.trim());
  const out = [];
  for (let i = 0; i < n; i++) out.push(`[${role}:${member("", base, i)}]${tail}`);
  return out;
}

function desugarEdgeReplication(code) {
  const m = EDGE_SUGAR_RE.exec(code);
  if (!m) return null;
  const [, src, tag, dst] = m;
  const rs = replParts(src), rd = replParts(dst);
  if (rs === null && rd === null) return null;
  const out = [];
  if (rs !== null && rd !== null) {
    if (rs[2] !== rd[2]) {
      fail("WRL_NUMERIC_RANGE",
        `positional replication needs equal counts, got ${rs[2]} and ` +
        `${rd[2]} in '${code.trim()}'`);
    }
    for (let i = 0; i < rs[2]; i++) {
      out.push(`[${member(rs[0], rs[1], i)}] --${tag}--> [${member(rd[0], rd[1], i)}]`);
    }
    return out;
  }
  if (rs !== null) {
    for (let i = 0; i < rs[2]; i++) {
      out.push(`[${member(rs[0], rs[1], i)}] --${tag}--> [${dst.trim()}]`);
    }
    return out;
  }
  for (let i = 0; i < rd[2]; i++) {
    out.push(`[${src.trim()}] --${tag}--> [${member(rd[0], rd[1], i)}]`);
  }
  return out;
}

function desugarFanout(code) {
  const m = FANOUT_RE.exec(code);
  if (!m) return null;
  const [, src, tag, body] = m;
  const members = body.split(",").map((t) => t.trim()).filter(Boolean);
  if (!members.length) {
    fail("WRL_UNSUPPORTED_FEATURE", `empty fan-out group in '${code.trim()}'`);
  }
  if (members.length > FANOUT_MAX) {
    fail("WRL_NUMERIC_RANGE",
      `fan-out group in '${code.trim()}' has ${members.length} members; ` +
      `the maximum is ${FANOUT_MAX}`);
  }
  return members.map((tok) => {
    if (!(tok.startsWith("[") && tok.endsWith("]"))) {
      fail("WRL_UNSUPPORTED_FEATURE",
        `fan-out member '${tok}' must be a bracketed endpoint`);
    }
    return `[${src.trim()}] --${tag}--> [${tok.slice(1, -1).trim()}]`;
  });
}

function desugarStructural(code) {
  if (!code.trim()) return [code];
  if (code.includes("-->")) {
    const fan = desugarFanout(code);
    if (fan !== null) {
      const out = [];
      for (const ln of fan) {
        const rep = desugarEdgeReplication(ln);
        (rep || [ln]).forEach((x) => out.push(x));
        if (out.length > EXPANSION_MAX_LINES) {
          fail("WRL_NUMERIC_RANGE",
            `fan-out x replication in '${code.trim()}' exceeds ` +
            `EXPANSION_MAX_LINES=${EXPANSION_MAX_LINES}`);
        }
      }
      return out;
    }
    return desugarEdgeReplication(code) || [code];
  }
  return desugarDeclReplication(code) || [code];
}

/* ------------------------------------------------------------ value pass */
const ROTOR_NAME_RE = /rotor=([A-Za-z_]\w*)/;
const N_RE = /\bn=(\d+)/;
const PAREN_RE = /\(([^)]*)\)/;

/* The three clock sugar forms are an EXACT closed grammar, not a keyword
 * search. The earlier reading scanned for the word "phase" anywhere and
 * ignored every token it did not recognize, so `(every 2 garbage phase 1
 * nonsense)` expanded happily -- visible source silently discarded, which is
 * precisely what the sugar tier is not allowed to do. */
function desugarClock(body) {
  if (body.includes("mode=") || body.includes("period=") ||
      body.includes("phase=") || body.includes("epoch=")) {
    return null;   /* already explicit; the core parser owns it */
  }
  const toks = body.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const bad = (why) =>
    fail("WRL_SUGAR_MALFORMED",
      `${why}: '(${body})' -- the clock forms are exactly ` +
      `${CLOCK_SUGAR_FORMS.map((f) => `'${f}'`).join(", ")}`);

  if (toks[0] === "every") {
    if (toks.length !== 2 && !(toks.length === 4 && toks[2] === "phase")) {
      bad("unreadable 'every' clock");
    }
    const period = strictInt(toks[1], "clock period");
    const phase = toks.length === 4 ? strictInt(toks[3], "clock phase") : 0;
    return `mode=periodic, period=${period}, phase=${phase}`;
  }
  if (toks[0] === "once") {
    if (toks.length !== 3 || toks[1] !== "at") bad("unreadable 'once' clock");
    return `mode=once, epoch=${strictInt(toks[2], "clock epoch")}`;
  }
  return null;
}

function desugarCode(code) {
  const mrot = ROTOR_NAME_RE.exec(code);
  if (mrot) {
    const mn = N_RE.exec(code);
    if (mn === null) {
      fail("WRL_UNSUPPORTED_FEATURE",
        `named rotor '${mrot[1]}' needs the spinner fractional width n on ` +
        `the same declaration`);
    }
    const lanes = namedRotor(mrot[1], strictInt(mn[1], "spinner n"));
    code = code.slice(0, mrot.index) + "rotor=" + lanes.join(".") +
           code.slice(mrot.index + mrot[0].length);
  }
  if (code.trimStart().startsWith("[pulser:")) {
    const mg = PAREN_RE.exec(code);
    if (mg) {
      const next = desugarClock(mg[1]);
      if (next !== null) {
        code = code.slice(0, mg.index) + "(" + next + ")" +
               code.slice(mg.index + mg[0].length);
      }
    }
  }
  return code;
}

/**
 * WRL Core source with sugar -> canonical WRL Core source.
 *
 * Returns `{ text, origins }`. `origins` is the generated-line -> authored-line
 * sidecar (a PRESENTATION sidecar: it is not hashed, enters no artifact, and
 * discarding it changes no identity).
 *
 * THE LAW: there is no sugar-specific identity. Desugaring is not exempt from
 * identity -- it is upstream of it. A sugared program and its explicit twin
 * lower to identical canonical bytes because the sugar is gone before a graph
 * exists.
 */
export function desugarCoreMapped(src) {
  const out = [], origins = [];
  const lines = src.split("\n");
  if (src.endsWith("\n")) lines.pop();
  lines.forEach((raw, idx) => {
    const srcLineNo = idx + 1;
    const semi = raw.indexOf(";");
    const code = semi === -1 ? raw : raw.slice(0, semi);
    const tail = semi === -1 ? "" : raw.slice(semi);
    let expansion;
    try {
      expansion = desugarStructural(desugarCode(code));
    } catch (e) {
      if (e instanceof WrlError && e.line === null) e.line = srcLineNo;
      throw e;
    }
    if (out.length + expansion.length > EXPANSION_MAX_LINES) {
      fail("WRL_NUMERIC_RANGE",
        `desugaring this source would emit more than ` +
        `EXPANSION_MAX_LINES=${EXPANSION_MAX_LINES} lines`, { line: srcLineNo });
    }
    const expanded = expansion.length > 1;
    expansion.forEach((line, i) => {
      /* line 0 keeps the ORIGINAL slot's layout and (per decision D-c) its
       * inline comment; members 1..N-1 are newly minted. */
      out.push(i === 0 ? line + tail : line.replace(/\s+$/, ""));
      origins.push({
        emittedLine: out.length, sourceLine: srcLineNo, sourceText: raw,
        expanded, memberIndex: i, memberCount: expansion.length,
        emittedText: out[out.length - 1],
      });
    });
  });
  const text = out.join("\n") + (src.endsWith("\n") ? "\n" : "");
  return { text, origins };
}

/** The text-only face of `desugarCoreMapped`. Idempotent; a no-op on
 *  already-explicit source. */
export function desugarCore(src) {
  return desugarCoreMapped(src).text;
}

/* ============================================================ CORE PARSER */

const NODE_RE  = /^\[(\w+):(\w+)\]\s*(\([^)]*\))?\s*(\{[^}]*\})?$/;
const EDGE_RE  = /^\[(?:(\w+):)?(\w+)\]\s*--(\w+)-->\s*\[(?:(\w+):)?(\w+)\]$/;
const EPOCH_RE = /^\[epoch:(\d+)\]\s*(.*)$/;

const ROLE_TOKEN = { pulser: "Pulser", relay: "Relay", door: "Door",
                     spinner: "Spinner", orb: "Orb" };
const EDGE_TAG = { sig: "SignalWire", socket: "SocketControl" };

const RUN_INPUT_PERIODS = "periods ";
const RUN_INPUT_CLAIM = "[epoch:";

function isRunInputLine(line) {
  return line.startsWith(RUN_INPUT_PERIODS) || line.startsWith(RUN_INPUT_CLAIM);
}

/** Every (1-based line number, stripped line) carrying ScenarioV1 syntax. */
export function runInputLines(text) {
  const out = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.split(";")[0].trim();
    if (isRunInputLine(line)) out.push([i + 1, line]);
  });
  return out;
}

/** A combined pre-v0.4-0 document -> `{ world, runInputs }`. The split is
 *  LEXICAL and layout-preserving, so no identity can move across it. */
export function splitLegacyDocument(text) {
  const world = [], runs = [];
  for (const raw of text.split("\n")) {
    (isRunInputLine(raw.split(";")[0].trim()) ? runs : world).push(raw);
  }
  return { world: world.join("\n"), runInputs: runs.join("\n") };
}

/* A `(k=v, k=v, bareflag)` group. Duplicate keys are a REJECTION, not a
 * last-one-wins: `(period=2, period=3)` is two different intentions on one
 * line and the parser has no standing to pick. */
function parenKv(group, opts) {
  const kv = {}, flags = new Set();
  if (!group) return { kv, flags };
  const body = group.trim().slice(1, -1).trim();
  if (!body) return { kv, flags };
  for (let item of body.split(",")) {
    item = item.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq !== -1) {
      const k = item.slice(0, eq).trim();
      if (k in kv) {
        fail("WRL_DUPLICATE_CONFIG_KEY",
          `key '${k}' is set twice in '${group.trim()}'`, opts);
      }
      kv[k] = item.slice(eq + 1).trim();
    } else {
      if (flags.has(item)) {
        fail("WRL_DUPLICATE_CONFIG_KEY",
          `flag '${item}' appears twice in '${group.trim()}'`, opts);
      }
      flags.add(item);
    }
  }
  return { kv, flags };
}

/* The CLOSED per-role declaration grammar. `keys` is what may appear as
 * `k=v`; `flags` is what may appear bare. A role absent from this table takes
 * no declaration group at all. Anything else in the parentheses is refused --
 * `(banana=7)` is not a comment. */
const CONFIG_GRAMMAR = {
  Pulser:  { keys: ["mode", "period", "phase", "epoch"], flags: [] },
  Spinner: { keys: ["w", "n", "rotor", "configurable"], flags: ["configurable"] },
  Mailbox: { keys: ["w", "cap"], flags: [] },
  Relay:   { keys: [], flags: [] },
  Door:    { keys: [], flags: [] },
  Orb:     { keys: [], flags: [] },
};

/** Reject every key and flag the role does not define, BEFORE reading values. */
function checkConfigGrammar(role, kv, flags, opts) {
  const g = CONFIG_GRAMMAR[role];
  const listed = (xs) => (xs.length ? `[${xs.join(", ")}]` : "nothing");
  for (const k of Object.keys(kv)) {
    if (!g.keys.includes(k)) {
      fail("WRL_UNKNOWN_CONFIG_KEY",
        `${role} has no config key '${k}'; it accepts ${listed(g.keys)}`,
        { ...opts, fieldPath: `static_config.${k}` });
    }
  }
  for (const f of flags) {
    if (!g.flags.includes(f)) {
      fail("WRL_UNKNOWN_CONFIG_KEY",
        `${role} has no bare flag '${f}'; it accepts ${listed(g.flags)}`,
        { ...opts, fieldPath: `static_config.${f}` });
    }
  }
}

/** Exactly the fields the selected clock mode needs -- no more, no fewer. */
function checkClockFields(mode, kv, opts) {
  const want = mode === "periodic" ? ["mode", "period", "phase"]
                                   : ["mode", "epoch"];
  for (const k of Object.keys(kv)) {
    if (!want.includes(k)) {
      fail("WRL_UNKNOWN_CONFIG_KEY",
        `a '${mode}' pulser has no field '${k}'; it takes ` +
        `[${want.join(", ")}]`, { ...opts, fieldPath: `static_config.${k}` });
    }
  }
  for (const k of want) {
    if (k !== "mode" && !(k in kv)) {
      fail("WRL_CLOCK_RANGE",
        `a '${mode}' pulser needs '${k}'`,
        { ...opts, fieldPath: `static_config.clock` });
    }
  }
}

/* A `{ports}` group is a projection of a SET, so a repeated name is a typo,
 * not a set operation. Collapsing it with a Set hid the typo. */
function portsSet(group, opts) {
  const seen = new Set();
  for (const tok of group.trim().slice(1, -1).split(",")) {
    const t = tok.trim();
    if (!t) continue;
    if (seen.has(t)) {
      fail("WRL_PORT_SIGNATURE",
        `port '${t}' is named twice in '${group.trim()}'`, opts);
    }
    seen.add(t);
  }
  return seen;
}

/* ------------------------------------------------------- the profile header */

const PROFILE_LINE_RE = /^profile(?:\s+(\S+))?(\s+\S[\s\S]*)?$/;

/**
 * The profile declaration is REQUIRED, SINGULAR, and FIRST.
 *
 * The documentation has always said naming the profile is not optional. It was
 * not enforced: `WrlGraph` starts with the only profile already installed, so
 * an empty document and a profile-only document sealed to the SAME id and a
 * document with three profile lines sealed as if it had one. A world's stated
 * dialect is load-bearing -- it is the one line that says which frozen
 * semantics the rest of the text is written against.
 */
export function validateProfileHeader(text) {
  const hits = [];
  let firstCodeLine = null;
  text.split("\n").forEach((raw, i) => {
    const line = raw.split(";")[0].trim();
    if (!line) return;
    if (firstCodeLine === null) firstCodeLine = i + 1;
    if (line === "profile" || line.startsWith("profile ") ||
        line.startsWith("profile\t")) {
      hits.push([i + 1, line]);
    }
  });

  if (!hits.length) {
    fail("WRL_MISSING_PROFILE",
      `world source must open with 'profile ${PROFILE_ID}'`,
      { line: firstCodeLine });
  }
  if (hits.length > 1) {
    fail("WRL_DUPLICATE_PROFILE",
      `the profile is declared ${hits.length} times (lines ` +
      `${hits.map(([n]) => n).join(", ")}); a world has exactly one dialect`,
      { line: hits[1][0] });
  }
  const [lineNo, line] = hits[0];
  if (lineNo !== firstCodeLine) {
    fail("WRL_MISSING_PROFILE",
      `the profile must be the first non-comment line; line ` +
      `${firstCodeLine} declares something before it`, { line: lineNo });
  }
  const m = PROFILE_LINE_RE.exec(line);
  if (!m || !m[1] || m[2] !== undefined) {
    fail("WRL_MALFORMED_PROFILE",
      `'${line}' is not exactly 'profile <id>'`, { line: lineNo });
  }
  return m[1];
}

/** The full frozen port SET of a role. */
export function portProjection(role) {
  return new Set([...PORTS[role].in, ...PORTS[role].out]);
}

/** A `{ports}` brace group is a CHECKED projection of the role's frozen ports:
 *  it must reveal the signature exactly. `{}` or a bogus token is rejected --
 *  visible source is never silently ignored. */
export function validatePortProjection(role, tokens, opts) {
  const want = [...portProjection(role)].sort();
  const got = [...tokens].sort();
  if (want.join(",") !== got.join(",")) {
    fail("WRL_PORT_SIGNATURE",
      `${role} ports [${got.join(", ")}] do not match the frozen signature ` +
      `[${want.join(", ")}]`, opts);
  }
}

/* Rotor lanes are the ONE artifact field with no small bound: at w = 64 a lane
 * may legally reach 2^64 - 1, which a JS number cannot hold. They are carried
 * as BigInt end to end and serialized as their own decimal digits, so an
 * authored 9223372036854775807 stays 9223372036854775807 instead of becoming
 * 9223372036854776000 and quietly minting a different id. */
function rotorDots(tok, opts) {
  const parts = String(tok).split(".");
  if (parts.length !== 4) {
    fail("WRL_NUMERIC_RANGE", `rotor must have 4 lanes, got '${tok}'`, opts);
  }
  return parts.map((x, i) => strictBigInt(x, `rotor lane ${i}`, opts));
}

function intField(kv, key, opts) {
  return strictInt(kv[key], `'${key}'`, opts);
}

/** A canonical WRL graph. `periods`/`batches` are RUN INPUTS -- they never
 *  enter the SemanticArtifactID. */
export class WrlGraph {
  constructor() {
    this.profile = PROFILE_ID;
    this.periods = 0;
    this.nodes = [];   // [role, name, config]
    this.edges = [];   // [kind, src, dst]
    this.batches = [];
  }
}

/**
 * STRICT WRL Core WORLD source -> canonical WRL graph.
 *
 * RUN INPUTS ARE NOT WORLD SOURCE. A `periods N` line or an `[epoch:N]` claim
 * is refused with WRL_WORLD_SOURCE_HAS_SCENARIO; they belong to ScenarioV1.
 * Use `parseWrlLegacyDocument` to read a pre-v0.4-0 combined document.
 *
 * Lexical law: comments are `;` (full-line or inline). `#` is reserved for
 * content identity and is NEVER a comment marker.
 */
export function parseWrlCore(text) {
  const offenders = runInputLines(text);
  if (offenders.length) {
    const [n, line] = offenders[0];
    fail("WRL_WORLD_SOURCE_HAS_SCENARIO",
      `run inputs are not world source: line ${n}, '${line}' -- run inputs ` +
      `live in ScenarioV1 (the v0.4-0 document boundary)`, { line: n });
  }
  validateProfileHeader(text);
  return parseCorePermissive(text);
}

/** COMPATIBILITY PATH -- a pre-v0.4-0 COMBINED document. A migration bridge,
 *  not the normative surface. */
export function parseWrlLegacyDocument(text) {
  return parseCorePermissive(text);
}

function addClaim(g, epoch, wid, seq, body, opts) {
  if (!(epoch >= 1 && epoch <= g.periods)) {
    fail("WRL_EPOCH_RANGE",
      `epoch ${epoch} out of range [1, ${g.periods}]`, opts);
  }
  const op = body[0];
  let payload;
  if (op === "SetRotor") payload = ["SetRotor", body[1], rotorDots(body[2], opts)];
  else if (op === "ResetFault") payload = ["ResetFault", body[1]];
  else {
    fail("WRL_UNSUPPORTED_FEATURE",
      `claim op '${op}' (only SetRotor|ResetFault in IR v1)`, opts);
  }
  g.batches[epoch - 1].push({ writer_id: wid, sequence: seq, payload });
}

function parseCorePermissive(text) {
  const g = new WrlGraph();
  text.split("\n").forEach((raw, idx) => {
    const opts = { line: idx + 1 };
    const line = raw.split(";")[0].trim();
    if (!line) return;

    if (line.startsWith("profile ")) { g.profile = line.split(/\s+/)[1]; return; }
    if (line.startsWith("periods ")) {
      g.periods = strictInt(line.split(/\s+/)[1], "periods", opts);
      g.batches = Array.from({ length: g.periods }, () => []);
      return;
    }

    const me = EPOCH_RE.exec(line);
    if (me) {
      const epoch = strictInt(me[1], "epoch", opts);
      let body = me[2].split(/\s+/).filter(Boolean);
      let wid = null, seq = null;
      const wm = /@(\d+),(\d+)/.exec(me[2]);
      if (wm) {
        wid = strictInt(wm[1], "writer id", opts);
        seq = strictInt(wm[2], "sequence", opts);
        body = body.filter((b) => !b.startsWith("@"));
      }
      addClaim(g, epoch, wid, seq, body, opts);
      return;
    }

    if (line.includes("-->")) {
      const m = EDGE_RE.exec(line);
      if (!m) fail("WRL_UNSUPPORTED_FEATURE", `bad edge notation '${line}'`, opts);
      const [, srcRole, src, tag, dstRole, dst] = m;
      if (!(tag in EDGE_TAG)) {
        fail("WRL_UNSUPPORTED_FEATURE",
          `edge tag '${tag}' (only sig|socket in IR v1)`, opts);
      }
      /* A role prefix on an endpoint is OPTIONAL, but when written it is a
       * CHECKED ASSERTION about the object it names, not decoration. It used
       * to be captured by a non-capturing group and dropped, so
       * `[door:p] --sig--> [spinner:d]` sealed happily with p a Pulser and d a
       * Door. The prefixes ride along here and validateGraph judges them. */
      const edge = [EDGE_TAG[tag], src, dst];
      edge.srcRole = srcRole || null;
      edge.dstRole = dstRole || null;
      edge.line = opts.line;
      g.edges.push(edge);
      return;
    }

    if (line.includes("~~") || line.includes("!!") || line.includes("==")) {
      fail("WRL_UNSUPPORTED_FEATURE",
        `route texture in '${line}': async ~~ / fault !! / verified == are ` +
        `transition classes, not IR v1 edges`, opts);
    }

    const m = NODE_RE.exec(line);
    if (!m) fail("WRL_UNSUPPORTED_FEATURE", `unrecognized WRL notation '${line}'`, opts);
    const rtok = m[1], name = m[2];
    if (!(rtok in ROLE_TOKEN)) {
      fail("WRL_UNSUPPORTED_FEATURE",
        `role '${rtok}' not in the frozen v1 surface registry ` +
        `[${Object.keys(ROLE_TOKEN).join(", ")}]`, opts);
    }
    const role = ROLE_TOKEN[rtok];
    if (m[4] !== undefined) validatePortProjection(role, portsSet(m[4], opts), opts);
    const { kv, flags } = parenKv(m[3], opts);
    checkConfigGrammar(role, kv, flags, opts);

    if (role === "Pulser") {
      const mode = kv.mode ?? "periodic";
      if (mode !== "periodic" && mode !== "once") {
        fail("WRL_UNSUPPORTED_FEATURE",
          `pulser clock mode '${mode}' (only periodic|once)`, opts);
      }
      checkClockFields(mode, kv, opts);
      const clock = mode === "periodic"
        ? ["periodic", intField(kv, "period", opts), intField(kv, "phase", opts)]
        : ["once", intField(kv, "epoch", opts)];
      g.nodes.push(["Pulser", name, { clock }]);
    } else if (role === "Spinner") {
      if (flags.has("configurable") && "configurable" in kv) {
        fail("WRL_DUPLICATE_CONFIG_KEY",
          `spinner ${name}: 'configurable' is given both as a flag and as a ` +
          `key`, opts);
      }
      g.nodes.push(["Spinner", name, {
        w: "w" in kv ? intField(kv, "w", opts) : null,
        n: "n" in kv ? intField(kv, "n", opts) : null,
        rotor: "rotor" in kv ? rotorDots(kv.rotor, opts) : null,
        configurable: flags.has("configurable") ||
          ("configurable" in kv
            ? strictBool(kv.configurable, `spinner ${name}: 'configurable'`, opts)
            : false),
      }]);
    } else {
      g.nodes.push([role, name, {}]);
    }
    /* remember where each node was authored, for diagnostics only */
    g.nodes[g.nodes.length - 1].line = opts.line;
  });
  return g;
}

/* ============================================================= VALIDATION */

const IDENT_OK = /^[A-Za-z0-9_]+$/;

/** Typed structural validation against the frozen IR v1 registries. The IR
 *  validator -- not the runtime -- owns these errors. */
export function validateGraph(g) {
  if (g.profile !== PROFILE_ID) {
    fail("WRL_UNSUPPORTED_FEATURE",
      `unknown profile '${g.profile}'; this compiler only serves ${PROFILE_ID}`);
  }

  /* Duplicate ids are reported at the LATER declaration, in the order the
   * AUTHOR wrote them. `validateGraph` sees a canonicalized graph, whose nodes
   * are sorted by (id, role); scanning that order would blame whichever
   * spelling happened to sort second -- the `[relay:r]` on line 2 rather than
   * the `[door:r]` on line 3 that actually collided with it. So the duplicate
   * scan gets its own pass in authored order, and names both lines. */
  const declaredAt = new Map();
  for (const node of g.nodes.slice().sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
    const name = node[1];
    if (declaredAt.has(name)) {
      const first = declaredAt.get(name);
      fail("WRL_DUPLICATE_ID",
        `duplicate object id '${name}'` +
        (first == null ? "" : `; already declared on line ${first}`),
        { line: node.line ?? null, locator: `object ${name}` });
    }
    declaredAt.set(name, node.line ?? null);
  }

  const roleOf = new Map();
  for (const node of g.nodes) {
    const [role, name, cfg] = node;
    const opts = { line: node.line ?? null, locator: `object ${name}` };
    if (!ROLE_IDS.includes(role)) {
      fail("WRL_UNSUPPORTED_FEATURE",
        `role '${role}' not in the frozen v1 registry`, { ...opts, fieldPath: "role" });
    }
    if (!name || !IDENT_OK.test(name) || name.includes("__")) {
      fail("WRL_UNSUPPORTED_FEATURE",
        `bad object id '${name}' (alnum/_ only, no '__')`,
        { ...opts, fieldPath: "object_id" });
    }
    roleOf.set(name, role);
    validateConfig(role, name, cfg, opts);
  }

  const sigIn = new Map(), socketIn = new Map();
  for (const edge of g.edges) {
    const [kind, s, d] = edge;
    const opts = { line: edge.line ?? null, locator: `edge ${kind}:${s}->${d}` };
    if (!EDGE_KINDS.includes(kind)) {
      fail("WRL_UNSUPPORTED_FEATURE", `edge kind '${kind}' not in frozen v1 edges`, opts);
    }
    if (!roleOf.has(s)) fail("WRL_UNKNOWN_ENDPOINT", `edge source '${s}' not declared`, opts);
    if (!roleOf.has(d)) fail("WRL_UNKNOWN_ENDPOINT", `edge destination '${d}' not declared`, opts);
    /* an OPTIONAL role prefix is a checked assertion (see the parser) */
    for (const [written, id, which] of [[edge.srcRole, s, "source"],
                                        [edge.dstRole, d, "destination"]]) {
      if (!written) continue;
      const actual = roleOf.get(id);
      if (ROLE_TOKEN[written] !== actual) {
        fail("WRL_ROLE_PREFIX_MISMATCH",
          `this edge calls its ${which} '${written}:${id}', but ${id} was ` +
          `declared a ${actual}`, opts);
      }
    }
    const [outPort, inPort] = EDGE_PORTS[kind];
    if (!PORTS[roleOf.get(s)].out.includes(outPort)) {
      fail("WRL_ILLEGAL_PORT_PAIR",
        `${s} (${roleOf.get(s)}) has no out-port ${outPort} for a ${kind}`, opts);
    }
    if (!PORTS[roleOf.get(d)].in.includes(inPort)) {
      fail("WRL_ILLEGAL_PORT_PAIR",
        `${d} (${roleOf.get(d)}) has no in-port ${inPort} for a ${kind}`, opts);
    }
    const bucket = kind === "SignalWire" ? sigIn : socketIn;
    bucket.set(d, (bucket.get(d) || 0) + 1);
  }
  for (const [d, c] of sigIn) {
    if (c > 1) {
      fail("WRL_CONTROLLER_CONFLICT",
        `${d} has ${c} signal-wire inputs (a node admits one)`,
        { locator: `object ${d}` });
    }
  }
  for (const [d, c] of socketIn) {
    if (c > 1) {
      fail("WRL_CONTROLLER_CONFLICT",
        `${d} has ${c} controllers (an orb admits one)`, { locator: `object ${d}` });
    }
  }

  if (!Number.isInteger(g.periods) || g.periods < 0) {
    fail("WRL_EPOCH_RANGE", "periods must be a non-negative integer");
  }
  return g;
}

function validateConfig(role, name, cfg, opts) {
  if (role === "Pulser") {
    const clock = cfg.clock;
    if (!Array.isArray(clock) || !clock.length) {
      fail("WRL_CLOCK_RANGE", `pulser ${name}: missing clock`,
        { ...opts, fieldPath: "static_config.clock" });
    }
    if (clock[0] === "periodic") {
      const [, p, ph] = clock;
      if (!(Number.isInteger(p) && p >= 1)) {
        fail("WRL_CLOCK_RANGE", `pulser ${name}: period >= 1`,
          { ...opts, fieldPath: "static_config.clock" });
      }
      if (!(Number.isInteger(ph) && ph >= 0 && ph < p)) {
        fail("WRL_CLOCK_RANGE", `pulser ${name}: phase in [0, period)`,
          { ...opts, fieldPath: "static_config.clock" });
      }
    } else if (clock[0] === "once") {
      if (!(Number.isInteger(clock[1]) && clock[1] >= 0)) {
        fail("WRL_CLOCK_RANGE", `pulser ${name}: once epoch >= 0`,
          { ...opts, fieldPath: "static_config.clock" });
      }
    } else {
      fail("WRL_UNSUPPORTED_FEATURE",
        `pulser ${name}: clock mode '${clock[0]}' (only periodic|once)`, opts);
    }
  } else if (role === "Spinner") {
    for (const key of ["w", "n", "rotor"]) {
      if (cfg[key] === null || cfg[key] === undefined) {
        fail("WRL_UNSUPPORTED_FEATURE", `spinner ${name}: missing '${key}'`,
          { ...opts, fieldPath: `static_config.${key}` });
      }
    }
    const w = cfg.w, n = cfg.n;
    /* 0 <= n <= w, matching the frozen validator exactly. Note that n = w is
     * legal but degenerate: the Q-format unit is 1 << n, so at n = w the unit
     * itself is 2^w and falls outside the lane bound below. A rotor of unit
     * magnitude therefore needs n < w. */
    if (!(Number.isInteger(w) && w > 0 && Number.isInteger(n) && n >= 0 && n <= w)) {
      fail("WRL_NUMERIC_RANGE", `spinner ${name}: bad lane geometry`,
        { ...opts, fieldPath: "static_config.n" });
    }
    if (cfg.rotor.length !== 4) {
      fail("WRL_NUMERIC_RANGE", `spinner ${name}: rotor must have 4 lanes`,
        { ...opts, fieldPath: "static_config.rotor" });
    }
    const lim = 1n << BigInt(w);   /* exact at any w -- see rotorDots */
    if (!cfg.rotor.every((v) => BigInt(v) >= 0n && BigInt(v) < lim)) {
      fail("WRL_NUMERIC_RANGE", `spinner ${name}: rotor lanes out of [0, 2^${w})`,
        { ...opts, fieldPath: "static_config.rotor" });
    }
  } else if (role === MAILBOX_ROLE) {
    for (const key of ["w", "cap"]) {
      if (cfg[key] === null || cfg[key] === undefined) {
        fail("WRL_UNSUPPORTED_FEATURE", `mailbox ${name}: missing '${key}'`,
          { ...opts, fieldPath: `static_config.${key}` });
      }
    }
    if (!(Number.isInteger(cfg.w) && cfg.w >= 1 && cfg.w <= MAILBOX_WIDTH_MAX)) {
      fail("WRL_NUMERIC_RANGE",
        `mailbox ${name}: body width must be in 1..${MAILBOX_WIDTH_MAX}`, opts);
    }
    if (!(Number.isInteger(cfg.cap) && cfg.cap >= 1)) {
      fail("WRL_NUMERIC_RANGE", `mailbox ${name}: capacity must be >= 1`, opts);
    }
  }
}

/* ========================================================= CANONICALIZE */

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function canonConfig(role, cfg) {
  const out = {};
  for (const k of Object.keys(cfg)) {
    if (k.startsWith("_")) continue;   /* diagnostics-only fields never hash */
    out[k] = cfg[k];
  }
  if (role === "Spinner" && cfg.rotor != null) {
    out.rotor = cfg.rotor.map((v) => BigInt(v));   /* exact, never narrowed */
    out.configurable = Boolean(cfg.configurable);
  }
  return out;
}

/** An order-independent canonical graph: objects sorted IDENTITY-FIRST by
 *  (object_id, role), edges by (kind, src, dst). Declaration order and surface
 *  syntax no longer affect the bytes. */
export function canonicalizeGraph(g) {
  const cg = new WrlGraph();
  cg.profile = g.profile;
  cg.periods = g.periods;
  cg.nodes = g.nodes
    .map((node) => {
      const out = [node[0], node[1], canonConfig(node[0], node[2])];
      out.line = node.line ?? null;
      return out;
    })
    .sort((a, b) => cmp(a[1], b[1]) || cmp(a[0], b[0]));
  cg.edges = g.edges.slice()
    .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]));
  cg.batches = g.batches.map((b) => b.slice());
  return cg;
}

/* ========================================================== GRAPH -> IR */

/** The frozen NON-EMPTY port groups of a role. An empty group is OMITTED --
 *  a Door carries `{"in":["sig_in"]}` and no "out" key at all. */
export function objectPorts(role) {
  const out = {};
  for (const k of ["out", "in"]) {
    if (PORTS[role][k].length) out[k] = PORTS[role][k].slice();
  }
  return out;
}

/** The four role-derived semantic identity fields, decided together so they
 *  cannot drift apart. */
export function semanticSurfaceForRoles(roles) {
  const hasMailbox = roles.includes(MAILBOX_ROLE);
  return {
    ir_version: hasMailbox ? IR_VERSION_V1_1 : IR_VERSION,
    runtime_state_schema: hasMailbox ? "RuntimeStateV1_1" : "RuntimeStateV1",
    admit_policy_id: hasMailbox ? MAILBOX_ADMIT_POLICY_ID : ADMIT_POLICY_ID,
    film_schema_id: hasMailbox ? FILM_SCHEMA_ID_MAILBOX : FILM_SCHEMA_ID,
  };
}

export function schemasForRoles(roles) {
  return {
    runtime_state_schema: semanticSurfaceForRoles(roles).runtime_state_schema,
    epoch_input_schema: "EpochInputV1",
    observable_schema: "EpochResultV1",
  };
}

/** Canonical WRL graph -> ForgeSemanticArtifactV1, the STATIC artifact ONLY.
 *  Run inputs are NOT part of it. */
export function graphToIr(g) {
  validateGraph(g);
  const objects = g.nodes
    .slice()
    .sort((a, b) => cmp(a[1], b[1]) || cmp(a[0], b[0]))
    .map(([role, name, cfg]) => ({
      object_id: name,
      role,
      static_config: canonConfig(role, cfg),
      state_schema_ref: `state.${role.toLowerCase()}.v1`,
      ports: objectPorts(role),
    }));
  const edges = g.edges
    .slice()
    .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]))
    .map(([kind, src, dst]) => ({ kind, src, dst }));
  const roles = g.nodes.map((n) => n[0]);
  const surface = semanticSurfaceForRoles(roles);
  return {
    ir_version: surface.ir_version,
    profile_id: g.profile,
    semantic_policies: {
      rulepack_id: RULEPACK_ID,
      numeric_policy_ids: NUMERIC_POLICY_IDS.slice(),
      admit_policy_id: surface.admit_policy_id,
      film_schema_id: surface.film_schema_id,
    },
    schemas: schemasForRoles(roles),
    objects,
    edges,
  };
}

/* ===================================================== SERIALIZE / IDENTITY */

/* Python: json.dumps(obj, sort_keys=True, separators=(",", ":")).
 * Every value here is an ASCII string, an integer, a boolean, or a container
 * of those, so a recursive key-sorted serializer is byte-identical.
 *
 * BigInt is emitted as its own decimal digits, which is exactly what Python's
 * arbitrary-precision `int` prints. This is why the serializer is hand-rolled
 * rather than JSON.stringify with a replacer: JSON.stringify THROWS on BigInt,
 * and the alternative -- narrowing to Number first -- is the silent rounding
 * this exists to prevent. */
function canonicalJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(
      (k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  if (typeof value === "number" && !Number.isSafeInteger(value) &&
      Number.isFinite(value)) {
    fail("WRL_NUMERIC_RANGE",
      `${value} cannot be serialized exactly; artifact scalars are bounded to ` +
      `+/-${SAFE_INT_MAX}`);
  }
  return JSON.stringify(value);
}

/** Deterministic canonical bytes of the STATIC semantic artifact. */
export function serializeArtifact(artifact) {
  return canonicalJson(artifact);
}

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SemanticArtifactID = "sem-" + sha256(canonical artifact bytes).
 *
 * A pure function of the frozen semantic graph and NOTHING of the backend
 * encoding, the run plan, or the claim batches. Swapping one-hot for binary
 * counters moves the BackendArtifactID and leaves this fixed.
 */
export async function semanticArtifactId(artifact) {
  return "sem-" + await sha256Hex(serializeArtifact(artifact));
}

/**
 * Translate a GENERATED line number back through the desugaring sidecar to the
 * line the author actually typed.
 *
 * Building the sidecar and then reporting generated coordinates anyway is the
 * worst of both: a three-member replication on authored line 3 emits lines
 * 3, 4, 5, so a duplicate id at emitted line 5 used to be reported as "line 5"
 * -- a line the author cannot see, in a file they never wrote. Every
 * diagnostic that escapes `sealWorld` is mapped here.
 *
 * The sidecar is line-granular, so this returns LINES, not spans. Column
 * ranges are not implemented and are not claimed.
 */
export function mapDiagnostic(err, origins) {
  const out = { code: err.code, message: err.detail, line: err.line,
                locator: err.locator, fieldPath: err.fieldPath,
                authoredLine: err.line, authoredText: null,
                generatedLine: null, fromExpansion: false };
  if (!origins || err.line === null || err.line === undefined) return out;
  const o = origins[err.line - 1];
  if (!o || o.emittedLine !== err.line) return out;
  out.authoredLine = o.sourceLine;
  out.authoredText = o.sourceText;
  out.fromExpansion = o.expanded;
  if (o.expanded) {
    out.generatedLine = o.emittedLine;
    out.memberIndex = o.memberIndex;
    out.memberCount = o.memberCount;
    out.generatedText = o.emittedText;
  }
  out.line = o.sourceLine;
  return out;
}

/**
 * The whole pipeline: sugared WRL Core world source -> a sealed result.
 *
 * Returns `{ ok, source, desugared, graph, artifact, bytes, semanticId,
 *            origins, sugared }` on success, or
 *         `{ ok: false, code, message, line, authoredLine, ... }` on a typed
 *         rejection, with `line` ALREADY mapped back to authored coordinates.
 */
export async function sealWorld(source) {
  let origins = null;
  try {
    const mapped = desugarCoreMapped(source);
    origins = mapped.origins;
    const desugared = mapped.text;
    const graph = canonicalizeGraph(parseWrlCore(desugared));
    const artifact = graphToIr(graph);
    const bytes = serializeArtifact(artifact);
    const semanticId = "sem-" + await sha256Hex(bytes);
    return { ok: true, source, desugared, origins, graph, artifact, bytes,
             semanticId, sugared: desugared !== source };
  } catch (e) {
    if (e instanceof WrlError) {
      return { ok: false, ...mapDiagnostic(e, origins) };
    }
    return { ok: false, code: "WRL_MALFORMED_ARTIFACT", message: String(e),
             line: null, authoredLine: null };
  }
}

/* ============================================================== FORMATTER */

const ROLE_SURFACE = { Pulser: "pulser", Relay: "relay", Door: "door",
                       Spinner: "spinner", Orb: "orb", Mailbox: "mailbox" };
const EDGE_SURFACE = { SignalWire: "sig", SocketControl: "socket" };

function surfaceConfig(role, cfg) {
  if (role === "Pulser") {
    const c = cfg.clock;
    return c[0] === "periodic"
      ? `(mode=periodic, period=${c[1]}, phase=${c[2]})`
      : `(mode=once, epoch=${c[1]})`;
  }
  if (role === "Spinner") {
    const bits = [`w=${cfg.w}`, `n=${cfg.n}`, `rotor=${cfg.rotor.join(".")}`];
    if (cfg.configurable) bits.push("configurable");
    return `(${bits.join(", ")})`;
  }
  if (role === MAILBOX_ROLE) return `(w=${cfg.w}, cap=${cfg.cap})`;
  return "";
}

/**
 * Canonical WRL Core world source from a canonical graph.
 *
 * The formatter emits the EXPLICIT numeric surface: sugar washes out here
 * exactly as declaration order and whitespace do. Formatting is normalization,
 * never a compiler gate -- an unformatted world seals to the same id.
 *
 * A role with no surface form is REFUSED, not invented. This function used to
 * carry a `Mailbox: "mailbox"` spelling and would emit `[mailbox:m](w=8,
 * cap=4)` -- text that `parseWrlCore` then rejected, because Mailbox is
 * IR/runtime-grounded and has no surface form (Core 0.1.2 sec.14b). An emitter
 * whose output its own parser refuses does not round-trip; use
 * `formatIrDebug` when you want to LOOK at such a graph.
 */
export function formatCore(g) {
  for (const [role, name] of g.nodes) {
    if (!SURFACE_ROLE_IDS.includes(role)) {
      fail("WRL_UNSUPPORTED_FEATURE",
        `${role} (object '${name}') is in the frozen v1 registry but has no ` +
        `WRL Core surface form, so it cannot be written as source; ` +
        `formatIrDebug() will show it`, { locator: `object ${name}` });
    }
  }
  return formatLines(g).join("\n") + "\n";
}

function formatLines(g, mark = () => "") {
  const out = [`profile ${g.profile}`, ""];
  for (const [role, name, cfg] of g.nodes) {
    const ports = [...portProjection(role)].sort().join(", ");
    out.push(mark(role) +
             `[${ROLE_SURFACE[role]}:${name}]${surfaceConfig(role, cfg)}` +
             (ports ? `{${ports}}` : ""));
  }
  if (g.edges.length) out.push("");
  for (const [kind, s, d] of g.edges) {
    out.push(`[${s}] --${EDGE_SURFACE[kind]}--> [${d}]`);
  }
  return out;
}

/**
 * A DEBUG rendering of a graph, including registry roles with no surface form.
 *
 * This is a viewer, not a surface. Unwritable roles are prefixed with `;! ` so
 * the output is never mistakable for WRL Core source -- feeding it back to
 * `parseWrlCore` yields a world without them rather than a lie about them.
 */
export function formatIrDebug(g) {
  return formatLines(g, (role) =>
    SURFACE_ROLE_IDS.includes(role) ? "" : ";! ").join("\n") + "\n";
}

/* ========================================================= THE TWO FIXTURES */

/**
 * THE STARTER WORLD -- a signal, a rotation, a pose.
 *
 * The four-object chain the documentation teaches with. It is a world in its
 * own right with its own id; it is NOT a shortened drawing of the pinned
 * fixture below, and the two must never be shown wearing each other's id.
 */
export const STARTER_WORLD = `profile forge.world.core.v1

[pulser:p0](every 2){sig_out}
[relay:r0]{sig_in, sig_out}
[spinner:sp](w=16, n=8, rotor=quarter_turn_z, configurable){sig_in, socket}
[orb:ob]{pose}

[p0] --sig--> [r0]
[r0] --sig--> [sp]
[sp] --socket--> [ob]
`;

export const STARTER_WORLD_SEMANTIC_ID =
  "sem-67e954cfe3115166b49388366df3f062a46572ba2baf53380f1520f4050b60ae";

/** The pinned Forge Spinner Bench conformance fixture -- the starter world
 *  plus a one-shot pulser and a door. Seals to
 *  sem-8ae91fe9cbc5fd086ce4356d587c403211e5c7b2b3ebdd316496367429ecfe4a --
 *  the id every WRL/TRVM battery folds against. */
export const DEMO_WORLD = `profile forge.world.core.v1

[pulser:p0](every 2){sig_out}
[relay:r0]{sig_in, sig_out}
[spinner:sp](w=16, n=8, rotor=quarter_turn_z, configurable){sig_in, socket}
[orb:ob]{pose}
[pulser:p1](once at 1){sig_out}
[door:d0]{sig_in}

[pulser:p0] --sig--> [relay:r0]
[relay:r0] --sig--> [spinner:sp]
[spinner:sp] --socket--> [orb:ob]
[pulser:p1] --sig--> [door:d0]
`;

export const DEMO_WORLD_SEMANTIC_ID =
  "sem-8ae91fe9cbc5fd086ce4356d587c403211e5c7b2b3ebdd316496367429ecfe4a";

/** The pinned fixtures, by name. */
export const FIXTURES = {
  starter: { source: STARTER_WORLD, semanticId: STARTER_WORLD_SEMANTIC_ID },
  demo:    { source: DEMO_WORLD,    semanticId: DEMO_WORLD_SEMANTIC_ID },
};

/**
 * A self-check: re-seal BOTH pinned fixtures and confirm each reproduces its
 * own frozen id.
 *
 * Checking one fixture proved one thing and was read as proving the spine.
 * It stayed green while the documentation showed the four-object starter world
 * wearing the six-object fixture's id, because nothing ever sealed the starter
 * world. Two fixtures is still a floor, not a conformance suite -- `test/`
 * holds that.
 */
export async function selfCheck() {
  const results = {};
  let ok = true;
  for (const [name, fx] of Object.entries(FIXTURES)) {
    const r = await sealWorld(fx.source);
    const good = r.ok && r.semanticId === fx.semanticId;
    ok = ok && good;
    results[name] = { ok: good, semanticId: r.ok ? r.semanticId : null,
                      expected: fx.semanticId, error: r.ok ? null : r };
  }
  return {
    ok,
    fixtures: results,
    /* kept for callers that only ever asked about the pinned fixture */
    semanticId: results.demo.semanticId,
    expected: DEMO_WORLD_SEMANTIC_ID,
    error: ok ? null : (results.starter.error || results.demo.error ||
      { code: "WRL_MALFORMED_ARTIFACT", message: "a fixture id moved" }),
  };
}
