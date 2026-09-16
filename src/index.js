/**
 * Cloudflare Email + HTTP Worker — Phase 1 inbound + Phase 2a compose
 */

import { handleInbound } from "./pipeline.js";
import { handleCompose } from "./compose.js";
import {
  allowExampleRouting,
  hasRoutingYaml,
  loadConfig,
} from "./load_config.js";
import routingYaml from "../config/routing.example.yaml";

function exampleYamlText() {
  return typeof routingYaml === "string" ? routingYaml : String(routingYaml);
}

/**
 * @param {object} env
 */
function configFromEnv(env) {
  return loadConfig(env, { exampleYamlText: exampleYamlText() });
}

/**
 * @param {object} obj
 * @param {number} [status]
 */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async email(message, env, _ctx) {
    if (!env.DB) {
      console.error("DB binding missing");
      throw new Error("cf-email-gateway: DB binding missing");
    }
    if (!env.ARCHIVE) {
      console.error("ARCHIVE binding missing");
      throw new Error("cf-email-gateway: ARCHIVE binding missing");
    }
    let config;
    try {
      config = configFromEnv(env);
    } catch (err) {
      console.error("ROUTING_YAML / config load failed", err);
      throw err instanceof Error
        ? err
        : new Error("cf-email-gateway: ROUTING_YAML secret missing or empty");
    }
    await handleInbound(env, message, config);
  },

  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    // Health stays up without a valid routing SoT so probes work; clients must
    // check routing_ok (secret present + parseable, or explicit example opt-in).
    if (request.method === "GET" && url.pathname === "/health") {
      let routing_ok = false;
      if (hasRoutingYaml(env) || allowExampleRouting(env)) {
        try {
          configFromEnv(env);
          routing_ok = true;
        } catch (err) {
          console.error("health: routing config load failed", err);
        }
      }
      return json({
        ok: true,
        service: env.SERVICE_NAME || "cf-email-gateway",
        routing_ok,
      });
    }

    let config;
    try {
      config = configFromEnv(env);
    } catch (err) {
      console.error("config load failed", err);
      const message =
        err instanceof Error ? err.message : "routing config load failed";
      // Absent, empty, or unparsable ROUTING_YAML → fail closed (no example ACL).
      return json({ ok: false, error: message }, 503);
    }
    return handleCompose(request, env, config);
  },
};

// Re-export for unit tests (Node can import load_config without .yaml)
export {
  loadConfig,
  hasRoutingYaml,
  allowExampleRouting,
  isRoutingConfigError,
} from "./load_config.js";
