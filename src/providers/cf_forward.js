/**
 * cf_forward provider — Cloudflare message.forward
 */

/**
 * @param {ForwardableEmailMessage} message
 * @param {string} to
 * @param {Headers} [extra]
 * @returns {Promise<{ ok: boolean, error?: string, providerMessageId?: string }>}
 */
export async function cfForward(message, to, extra) {
  try {
    if (typeof message.forward !== "function") {
      return { ok: false, error: "cf_forward: message.forward unavailable" };
    }
    if (extra) {
      await message.forward(to, extra);
    } else {
      await message.forward(to);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
