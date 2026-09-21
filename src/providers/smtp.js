/**
 * Generic SMTP client via cloudflare:sockets (RFC5321 DATA).
 *
 * Secrets (required):
 *   SMTP_USERNAME
 *   SMTP_PASSWORD
 * Optional:
 *   SMTP_HOST   (default mail.smtp2go.com — set explicitly for your ESP)
 *   SMTP_PORT   (default 465 = implicit TLS)
 *   SMTP_TLS    (optional explicit override: "on" | "starttls" for rare ports)
 *   SMTP_TIMEOUT_MS (default 20000)
 *
 * TLS is fail-closed: ports outside the known implicit-TLS / STARTTLS lists
 * return ok:false instead of connecting in plaintext. Port 80 is not a
 * default mail path — it requires an explicit SMTP_TLS override.
 *
 * CF: connect(address, { secureTransport: "on"|"starttls" })
 */

/**
 * @param {object} env
 * @param {{ mailFrom: string, to: string|string[], mimeText: string }} req
 */
export async function smtpSend(env, req) {
  const user = env.SMTP_USERNAME || env.SMTP_USER;
  const pass = env.SMTP_PASSWORD || env.SMTP_PASS;
  if (!user || !pass) {
    return {
      ok: false,
      error: "SMTP credentials missing (SMTP_USERNAME + SMTP_PASSWORD)",
    };
  }

  const host = env.SMTP_HOST || "localhost";
  if (!env.SMTP_HOST) {
    // Prefer explicit host; allow default only if set later — fail closed if missing?
    // Keep a sensible default empty check:
  }
  const smtpHost = env.SMTP_HOST;
  if (!smtpHost) {
    return {
      ok: false,
      error: "SMTP_HOST missing (e.g. mail.smtp2go.com)",
    };
  }

  const port = parseSmtpPort(env);
  const tls = resolveSmtpSecureTransport(env, port);
  if (!tls.ok) {
    return { ok: false, error: tls.error };
  }
  const secureTransport = tls.secureTransport;

  const mailFrom = bareEmail(req.mailFrom);
  const rcpts = (Array.isArray(req.to) ? req.to : [req.to])
    .map(bareEmail)
    .filter(Boolean);
  if (!mailFrom || !rcpts.length) {
    return { ok: false, error: "smtp mailFrom/to required" };
  }
  if (!req.mimeText) {
    return { ok: false, error: "smtp mimeText required" };
  }
  const ehlo = resolveSmtpEhloDomain(mailFrom);
  if (!ehlo.ok) {
    return { ok: false, error: ehlo.error };
  }
  const ehloHost = ehlo.ehlo;

  let connect;
  try {
    ({ connect } = await import("cloudflare:sockets"));
  } catch (e) {
    return {
      ok: false,
      error: `cloudflare:sockets unavailable: ${e?.message || e}`,
    };
  }

  const deadline = Date.now() + Number(env.SMTP_TIMEOUT_MS || 20000);

  let socket;
  try {
    socket = connect(
      { hostname: smtpHost, port },
      { secureTransport, allowHalfOpen: false },
    );
  } catch (e) {
    return { ok: false, error: `smtp connect: ${e?.message || e}` };
  }

  try {
    if (socket.opened) {
      await withTimeout(socket.opened, deadline, "socket.opened");
    }
  } catch (e) {
    try {
      socket.close?.();
    } catch {
      /* ignore */
    }
    return { ok: false, error: e?.message || String(e) };
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  let buf = "";

  async function readLine() {
    while (true) {
      if (Date.now() > deadline) throw new Error("smtp timeout read");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        return line;
      }
      const { value, done } = await withTimeout(
        reader.read(),
        deadline,
        "smtp read",
      );
      if (done) throw new Error("smtp connection closed");
      buf += decoder.decode(value, { stream: true });
    }
  }

  async function readResponse() {
    const lines = [];
    while (true) {
      const line = await readLine();
      lines.push(line);
      if (/^\d{3}(?:$|[ \t])/.test(line)) break;
    }
    const code = parseInt(lines[0].slice(0, 3), 10);
    return { code, full: lines.join("\n"), lines };
  }

  async function writeRaw(s) {
    await withTimeout(writer.write(encoder.encode(s)), deadline, "smtp write");
  }

  async function cmd(line) {
    await writeRaw(line + "\r\n");
    return readResponse();
  }

  try {
    let r = await readResponse();
    if (r.code !== 220) throw new Error(`banner ${r.full}`);

    r = await cmd(`EHLO ${ehloHost}`);
    if (r.code !== 250) throw new Error(`EHLO ${r.full}`);

    if (secureTransport === "starttls") {
      if (!/STARTTLS/i.test(r.full)) {
        throw new Error("server has no STARTTLS");
      }
      r = await cmd("STARTTLS");
      if (r.code !== 220) throw new Error(`STARTTLS ${r.full}`);
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      try {
        writer.releaseLock();
      } catch {
        /* ignore */
      }
      socket = socket.startTls();
      if (socket.opened) {
        await withTimeout(socket.opened, deadline, "startTls.opened");
      }
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
      buf = "";
      r = await cmd(`EHLO ${ehloHost}`);
      if (r.code !== 250) throw new Error(`EHLO after TLS ${r.full}`);
    }

    r = await cmd("AUTH LOGIN");
    if (r.code !== 334) throw new Error(`AUTH LOGIN ${r.full}`);
    r = await cmd(btoa(user));
    if (r.code !== 334) throw new Error(`AUTH user ${r.full}`);
    r = await cmd(btoa(pass));
    if (r.code !== 235) throw new Error(`AUTH pass ${r.full}`);

    r = await cmd(`MAIL FROM:<${mailFrom}>`);
    if (r.code !== 250) throw new Error(`MAIL FROM ${r.full}`);

    for (const rcpt of rcpts) {
      r = await cmd(`RCPT TO:<${rcpt}>`);
      if (r.code !== 250 && r.code !== 251) {
        throw new Error(`RCPT ${rcpt}: ${r.full}`);
      }
    }

    r = await cmd("DATA");
    if (r.code !== 354) throw new Error(`DATA ${r.full}`);

    let data = String(req.mimeText).replace(/\r?\n/g, "\r\n");
    if (!data.endsWith("\r\n")) data += "\r\n";
    data = data.replace(/^\./gm, "..");
    await writeRaw(data + ".\r\n");
    r = await readResponse();
    if (r.code !== 250) throw new Error(`after DATA ${r.full}`);

    const idMatch =
      r.full.match(/queued as\s+(\S+)/i) ||
      r.full.match(/\bid=(\S+)/i) ||
      r.full.match(/OK\s+(\S+)/i);

    try {
      await cmd("QUIT");
    } catch {
      /* ignore */
    }

    return {
      ok: true,
      providerMessageId: idMatch ? idMatch[1] : undefined,
      providerStatus: 250,
      raw: { smtp: r.full },
    };
  } catch (e) {
    try {
      await writeRaw("QUIT\r\n");
    } catch {
      /* ignore */
    }
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await socket.close?.();
    } catch {
      /* ignore */
    }
  }
}

const SMTP_IMPLICIT_TLS_PORTS = new Set([465, 8465, 443]);
const SMTP_STARTTLS_PORTS = new Set([587, 2525, 8025]);

/**
 * Derive the SMTP EHLO hostname from the envelope MAIL FROM domain.
 *
 * req.mailFrom is available before connect, so no env override:
 * the sending domain is always at hand. Fail-closed: single-label names
 * (`localhost`), bare IPs, and malformed domains return ok:false instead
 * of falling back to a default host.
 *
 * @param {string} mailFrom — already-normalized envelope sender
 * @returns {{ ok: true, ehlo: string } | { ok: false, error: string }}
 */
export function resolveSmtpEhloDomain(mailFrom) {
  const addr = bareEmail(mailFrom);
  const at = addr.lastIndexOf("@");
  const domain = at > 0 ? addr.slice(at + 1).toLowerCase() : "";
  if (isValidEhloDomain(domain)) {
    return { ok: true, ehlo: domain };
  }
  return {
    ok: false,
    error: `refusing SMTP with invalid EHLO domain from MAIL FROM "${addr || mailFrom || ""}" (expected an FQDN such as mail.example.com)`,
  };
}

/**
 * Strict FQDN check for EHLO: dot-required (rejects `localhost` and other
 * single-label names), valid hostname labels, and a non-numeric TLD
 * (rejects bare IPs, which belong in `[...]` literals, not EHLO).
 */
function isValidEhloDomain(domain) {
  if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return false;
  }
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return /[a-z]/.test(tld);
}

/**
 * Parse the configured SMTP port. Unset (`undefined`/`null`) or blank
 * (empty/whitespace string) → 465 default. Anything else → `Number(raw)`;
 * non-numeric / out-of-range values flow through for
 * `resolveSmtpSecureTransport` to reject fail-closed.
 *
 * @param {object} env
 * @returns {number}
 */
export function parseSmtpPort(env) {
  const raw = env?.SMTP_PORT ?? 465;
  if (typeof raw === "string" && raw.trim() === "") return 465;
  return Number(raw);
}

/**
 * Fail-closed TLS mapping for outbound SMTP.
 *
 * Known implicit-TLS ports → "on"; known submission ports → "starttls".
 * Anything else (including port 80 and non-numeric ports) returns ok:false
 * instead of falling back to plaintext. An explicit SMTP_TLS="on"|"starttls"
 * override allows a rare port when the operator opts in.
 *
 * @param {object} env
 * @param {number} port — must be the parsed SMTP port
 *   (`parseSmtpPort(env)`); callers must not pass a value derived
 *   any other way, since the invalid-port error echoes `env.SMTP_PORT`.
 * @returns {{ ok: true, secureTransport: "on"|"starttls" } | { ok: false, error: string }}
 */
export function resolveSmtpSecureTransport(env, port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return {
      ok: false,
      error: `refusing plaintext SMTP: invalid SMTP_PORT "${env?.SMTP_PORT ?? port}" (parsed port: ${port}; expected a known TLS port or explicit SMTP_TLS="on"|"starttls")`,
    };
  }
  const override = String(env?.SMTP_TLS || "")
    .trim()
    .toLowerCase();
  if (override) {
    if (override === "on") {
      return { ok: true, secureTransport: "on" };
    }
    if (override === "starttls") {
      return { ok: true, secureTransport: "starttls" };
    }
    return {
      ok: false,
      error: `unknown SMTP_TLS value "${env.SMTP_TLS}" (expected "on" or "starttls")`,
    };
  }
  if (SMTP_IMPLICIT_TLS_PORTS.has(port)) {
    return { ok: true, secureTransport: "on" };
  }
  if (SMTP_STARTTLS_PORTS.has(port)) {
    return { ok: true, secureTransport: "starttls" };
  }
  return {
    ok: false,
    error: `refusing plaintext SMTP: unknown SMTP_PORT "${port}" (expected 465/8465/443/587/2525/8025 or explicit SMTP_TLS="on"|"starttls")`,
  };
}

function bareEmail(v) {
  // Never retain CR/LF — SMTP RCPT / envelope must stay single-token.
  let s = String(v || "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  const m = s.match(/<([^>]+@[^>]+)>/);
  if (m) s = m[1].trim();
  else if (s.includes("@")) s = s.replace(/^mailto:/i, "").trim();
  else return "";
  // Drop interior whitespace left by CRLF collapse; reject if still not addr-like.
  s = s.replace(/\s+/g, "");
  if (!/^[^\s<>@"\\]+@[^\s<>@"\\]+$/.test(s)) return "";
  return s.toLowerCase();
}

function withTimeout(promise, deadline, label) {
  const ms = Math.max(0, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timeout after ${ms}ms`)),
      ms || 1,
    );
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function hasSmtp(env) {
  const user = env?.SMTP_USERNAME || env?.SMTP_USER;
  const pass = env?.SMTP_PASSWORD || env?.SMTP_PASS;
  return Boolean(user && pass && env?.SMTP_HOST);
}

export { bareEmail };
