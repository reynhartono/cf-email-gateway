/**
 * Cloudflare Email + HTTP Worker — Phase 1 inbound + Phase 2a compose
 */

import { parseRoutingYaml } from "./config.js";
import { handleInbound } from "./pipeline.js";
import { handleCompose } from "./compose.js";
import routingYaml from "../config/routing.example.yaml";

let cachedConfig;

function loadConfig(env) {
  if (env.ROUTING_YAML && typeof env.ROUTING_YAML === "string") {
    return parseRoutingYaml(env.ROUTING_YAML);
  }
  if (!cachedConfig) {
    const text =
      typeof routingYaml === "string" ? routingYaml : String(routingYaml);
    cachedConfig = parseRoutingYaml(text);
  }
  return cachedConfig;
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
    const config = loadConfig(env);
    await handleInbound(env, message, config);
  },

  async fetch(request, env, _ctx) {
    const config = loadConfig(env);
    return handleCompose(request, env, config);
  },
};
