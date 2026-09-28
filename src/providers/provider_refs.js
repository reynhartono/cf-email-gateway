/**
 * Whole-value `${SECRET_NAME}` references for provider config.
 *
 * A config string is a reference if and only if the ENTIRE value matches
 * `${NAME}` — no partial expansion, so stray `$` characters in real
 * passwords are always literal. `$${NAME}` escapes to the literal string
 * `${NAME}` for the corner where a password looks exactly like a reference.
 *
 * Shape errors throw at config load (fail closed, Q41). Missing/empty
 * secrets resolve at send time to `{ ok: false }` — never an empty
 * credential on the wire. Resolved values are never logged; only the
 * secret NAME (never its content) may appear in errors.
 *
 * Intentional asymmetry: `${X}suffix` (whole value opens with `$...{`)
 * throws, while `prefix${X}` is a silent literal — only whole-value
 * matches are special, so a stray `${` mid-string can never trigger a
 * lookup. A mistyped ref in the literal position fails later at send
 * time (bad credential), still fail-closed, never misrouted.
 */

const REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ESCAPE_RE = /^\$\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
// Whole value opens with `$...{` but is neither a valid ref nor an escape:
// a typo'd reference (e.g. `${}`, `${UN CLOSED`) — fail closed, it must
// never silently become a literal password.
const SUSPICIOUS_RE = /^\$+\{/;

/**
 * Classify a raw config string without touching env (safe at load time).
 * @param {unknown} value
 * @param {string} where — dotted path for error messages (no values echoed)
 * @returns {{ kind: "literal" | "ref" | "escaped", name?: string, literal?: string }}
 * @throws {Error} on malformed whole-value `${...}` shapes.
 */
export function classifyRef(value, where = "value") {
  const s = String(value ?? "");
  const ref = REF_RE.exec(s);
  if (ref) return { kind: "ref", name: ref[1] };
  const esc = ESCAPE_RE.exec(s);
  if (esc) return { kind: "escaped", literal: `\${${esc[1]}}` };
  if (SUSPICIOUS_RE.test(s)) {
    throw new Error(
      `routing config: malformed secret reference in ${where} ` +
        `(expected \${NAME} with NAME = [A-Za-z_][A-Za-z0-9_]*, or $$-escape)`,
    );
  }
  return { kind: "literal", literal: s };
}

/**
 * Assert every string leaf of a provider `config` object has a valid
 * reference shape. No env access — runs inside normalizeConfig (Q41).
 * Non-string leaves (numbers, booleans) pass through untouched.
 * @param {unknown} node
 * @param {string} where
 */
export function assertRefShapes(node, where = "providers") {
  if (typeof node === "string") {
    classifyRef(node, where);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      assertRefShapes(v, `${where}.${k}`);
    }
  }
}

/**
 * Resolve a classified string against env (send time).
 * @param {unknown} value
 * @param {object} env
 * @param {string} where — field path; the secret NAME may appear in errors,
 *   never its content.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function resolveRefValue(value, env, where = "value") {
  const s = String(value ?? "");
  const ref = REF_RE.exec(s);
  if (ref) {
    const name = ref[1];
    const secret = env?.[name];
    if (typeof secret !== "string" || !secret.trim()) {
      return {
        ok: false,
        error:
          `secret ${name} for ${where} is missing or empty ` +
          `(refusing to send with an empty credential)`,
      };
    }
    return { ok: true, value: secret };
  }
  const esc = ESCAPE_RE.exec(s);
  if (esc) return { ok: true, value: `\${${esc[1]}}` };
  return { ok: true, value: s };
}

/**
 * Deep-resolve every string leaf of a provider `config` object against env.
 * @param {object} configObj
 * @param {object} env
 * @param {string} where
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
export function resolveConfigRefs(configObj, env, where = "providers") {
  if (!configObj || typeof configObj !== "object") {
    return { ok: true, config: configObj };
  }
  const out = Array.isArray(configObj) ? [] : {};
  for (const [k, v] of Object.entries(configObj)) {
    if (typeof v === "string") {
      const r = resolveRefValue(v, env, `${where}.${k}`);
      if (!r.ok) return r;
      out[k] = r.value;
    } else if (v && typeof v === "object") {
      const r = resolveConfigRefs(v, env, `${where}.${k}`);
      if (!r.ok) return r;
      out[k] = r.config;
    } else {
      out[k] = v;
    }
  }
  return { ok: true, config: out };
}
