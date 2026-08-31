/**
 * Email send-proxy (hide-my-email style via Gmail → special To).
 *
 * Address format (local-part @ our domain):
 *
 *   {alias}[+optional]{Display Name}?+{rcptLocal}{Display}?={rcptDomain}
 *
 * Examples:
 *   shops+alice=gmail.com@example.com
 *        → From: shops@example.com  To: alice@gmail.com
 *
 *   shops{Shop}+alice{Alice}=gmail.com@example.com
 *        → From: "Shop" <shops@example.com>  To: alice@gmail.com
 *          (To display name optional for SMTP to field)
 *
 * Braces { } are optional display-name tags; + separates alias from recipient;
 * = separates recipient local from recipient domain.
 */

/**
 * @param {string} envelopeTo
 * @returns {null | {
 *   aliasLocal: string,
 *   aliasDisplay?: string,
 *   rcptLocal: string,
 *   rcptDisplay?: string,
 *   rcptDomain: string,
 *   ourDomain: string,
 *   rcptEmail: string,
 *   fromEmail: string,
 * }}
 */
export function parseSendProxyAddress(envelopeTo) {
  const raw = String(envelopeTo || "").trim().toLowerCase();
  // keep original for display extraction (case) — re-parse on original
  const orig = String(envelopeTo || "").trim();
  const at = orig.lastIndexOf("@");
  if (at < 0) return null;
  const localOrig = orig.slice(0, at);
  const ourDomain = orig.slice(at + 1).toLowerCase();
  if (!ourDomain || !localOrig.includes("+") || !localOrig.includes("=")) {
    return null;
  }

  // alias [ {display} ] + rcptLocal [ {display} ] = rcptDomain
  const m = localOrig.match(
    /^([^+{]+)(?:\{([^}]*)\})?\+([^=,{]+)(?:\{([^}]*)\})?=([^@]+)$/i,
  );
  if (!m) return null;

  const aliasLocal = m[1].trim().toLowerCase();
  const aliasDisplay = decodeDisplayName(m[2]);
  const rcptLocal = m[3].trim().toLowerCase();
  const rcptDisplay = decodeDisplayName(m[4]);
  const rcptDomain = m[5].trim().toLowerCase();

  if (!aliasLocal || !rcptLocal || !rcptDomain || rcptDomain.includes(" ")) {
    return null;
  }
  // basic domain shape
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(rcptDomain) && !rcptDomain.includes(".")) {
    // allow single-label only if dotted — require a dot
    return null;
  }
  if (!rcptDomain.includes(".")) return null;

  const fromEmail = `${aliasLocal}@${ourDomain}`;
  const rcptEmail = `${rcptLocal}@${rcptDomain}`;

  return {
    aliasLocal,
    aliasDisplay,
    rcptLocal,
    rcptDisplay,
    rcptDomain,
    ourDomain,
    rcptEmail,
    fromEmail,
  };
}

/**
 * Display names cannot safely use raw spaces inside an SMTP local-part
 * (many clients/MTAs reject or mangle them). Conventions inside {…}:
 *   _  → space
 *   .  → space   (optional, only for multi-word names you prefer dotted)
 * Literal underscore: use __
 * Literal dot for "space-dot" is not supported; use _
 */
export function decodeDisplayName(raw) {
  if (raw == null) return undefined;
  let s = String(raw).trim();
  if (!s) return undefined;
  // __ → temporary, _ → space, restore __
  s = s.replace(/__/g, "\u0000").replace(/_/g, " ").replace(/\u0000/g, "_");
  return s;
}

/**
 * Encode for putting a display name into {…} in a To address.
 */
export function encodeDisplayName(name) {
  if (name == null || !String(name).trim()) return "";
  return String(name)
    .trim()
    .replace(/_/g, "__")
    .replace(/ /g, "_");
}

/**
 * @param {string} email
 * @param {string[]} allowlist lowercased emails
 */
export function isAuthorizedSender(email, allowlist) {
  const e = String(email || "")
    .trim()
    .toLowerCase()
    .replace(/^.*</, "")
    .replace(/>.*$/, "");
  const list = (allowlist || []).map((x) => String(x).trim().toLowerCase());
  return list.includes(e);
}

/**
 * Crude body extract: prefer text/plain part, else strip headers.
 * @param {string} rawText
 */
export function extractBodyAndSubject(rawText) {
  const subjectMatch = rawText.match(/^Subject:\s*(.*)$/im);
  let subject = subjectMatch ? subjectMatch[1].trim() : "(no subject)";
  // unfold simple subject
  subject = subject.replace(/\s+/g, " ");

  const parts = rawText.split(/\r?\n\r?\n/);
  const headers = parts[0] || "";
  let body = parts.slice(1).join("\n\n");

  const ct = (headers.match(/^Content-Type:\s*([^\r\n;]+)/im) || [])[1] || "";
  if (/multipart\//i.test(ct)) {
    const plain = body.match(
      /Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)*\r?\n([\s\S]*?)(?=\r?\n--)/i,
    );
    if (plain) {
      body = plain[1].trim();
    }
  }

  // drop trailing MIME noise lightly
  body = body.replace(/\r\n--[^\r\n]*--\s*$/g, "").trim();
  if (!body) body = "(empty body)";

  return { subject, text: body };
}
