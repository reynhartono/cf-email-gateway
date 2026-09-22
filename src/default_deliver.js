import { resolveDriver } from "./config.js";
import { cfForward } from "./providers/cf_forward.js";
import { buildForwardTokenHeaders } from "./forward_headers.js";

export async function defaultDeliver(env, message, target, config, rawCtx = {}) {
  let method = target.method;
  if (!method && config) {
    method = resolveDriver(config, message.to || "", {
      email: target.destination,
    });
    target.method = method;
  }
  if (method === "cf_forward") {
    let headers;
    if (rawCtx.forwardTokenMeta) {
      headers = buildForwardTokenHeaders(rawCtx.forwardTokenMeta);
    }
    return cfForward(message, target.destination, headers);
  }
  if (method === "provider_send" || method === "smtp") {
    return {
      ok: false,
      error: "provider_send on normal inbound not wired; use send-proxy or r+ token",
    };
  }
  return {
    ok: false,
    error: `unsupported method: ${method}`,
  };
}
