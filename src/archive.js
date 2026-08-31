/**
 * R2 archive put
 */

/**
 * @param {R2Bucket} bucket
 * @param {{ id: string, recipient_domain: string, raw: ArrayBuffer|Uint8Array, raw_size: number }} opts
 * @returns {Promise<{ ok: boolean, r2_key?: string, error?: string }>}
 */
export async function putArchive(bucket, opts) {
  const dt = new Date().toISOString().slice(0, 10);
  const domain = (opts.recipient_domain || "unknown").replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `raw/dt=${dt}/domain=${domain}/id=${opts.id}.eml`;
  try {
    const body =
      opts.raw instanceof ArrayBuffer ? opts.raw : opts.raw.buffer.slice(
        opts.raw.byteOffset,
        opts.raw.byteOffset + opts.raw.byteLength,
      );
    await bucket.put(key, body, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        inbound_id: opts.id,
        raw_size: String(opts.raw_size ?? 0),
      },
    });
    return { ok: true, r2_key: key };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
