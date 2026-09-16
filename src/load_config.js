/**
 * Resolve live routing config from env.
 *
 * Runtime SoT is non-empty ROUTING_YAML only (Q41). The example YAML under
 * config/ is documentation / copy-paste — never imported into the Worker.
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
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRoutingConfigError(err) {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String(/** @type {{ message?: unknown }} */ (err).message)
      : String(err ?? "");
  return msg.includes("ROUTING_YAML") || msg.includes("routing config:");
}

/**
 * @param {object} env
 * @returns {import('./config.js').RoutingConfig | object}
 */
export function loadConfig(env) {
  if (!hasRoutingYaml(env)) {
    throw new Error(ROUTING_YAML_MISSING);
  }
  return parseRoutingYaml(env.ROUTING_YAML);
}
