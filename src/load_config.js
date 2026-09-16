/**
 * Resolve live routing config from env.
 *
 * Production path requires non-empty ROUTING_YAML (fail closed).
 * Bundled routing.example.yaml is documentation-only unless
 * ALLOW_EXAMPLE_ROUTING is explicitly enabled (local DX only).
 */

import { parseRoutingYaml } from "./config.js";

export const ROUTING_YAML_MISSING =
  "cf-email-gateway: ROUTING_YAML secret missing or empty";

/**
 * @param {object | undefined | null} env
 * @returns {boolean}
 */
export function hasRoutingYaml(env) {
  return (
    typeof env?.ROUTING_YAML === "string" && env.ROUTING_YAML.trim().length > 0
  );
}

/**
 * Explicit opt-in to parse bundled example YAML (never default for deploy).
 * @param {object | undefined | null} env
 * @returns {boolean}
 */
export function allowExampleRouting(env) {
  const v = env?.ALLOW_EXAMPLE_ROUTING;
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes";
  }
  return false;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRoutingConfigError(err) {
  const msg = err && typeof err === "object" && "message" in err
    ? String(/** @type {{ message?: unknown }} */ (err).message)
    : String(err ?? "");
  return (
    msg.includes("ROUTING_YAML") ||
    msg.includes("routing config:") ||
    msg.includes("ALLOW_EXAMPLE_ROUTING")
  );
}

/**
 * @param {object} env
 * @param {{ exampleYamlText?: string }} [opts]
 * @returns {import('./config.js').RoutingConfig | object}
 */
export function loadConfig(env, opts = {}) {
  if (hasRoutingYaml(env)) {
    return parseRoutingYaml(env.ROUTING_YAML);
  }

  if (allowExampleRouting(env)) {
    const text = opts.exampleYamlText;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(
        "cf-email-gateway: ALLOW_EXAMPLE_ROUTING set but bundled example routing is unavailable",
      );
    }
    console.warn(
      "cf-email-gateway: ALLOW_EXAMPLE_ROUTING — using bundled routing.example.yaml (not for production)",
    );
    return parseRoutingYaml(text);
  }

  throw new Error(ROUTING_YAML_MISSING);
}
