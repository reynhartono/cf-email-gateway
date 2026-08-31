/**
 * D1 access helpers
 */

export async function getInboundByDedupe(db, dedupeKey) {
  return db
    .prepare("SELECT * FROM inbound_messages WHERE dedupe_key = ?")
    .bind(dedupeKey)
    .first();
}

export async function insertInbound(db, row) {
  await db
    .prepare(
      `INSERT INTO inbound_messages (
        id, dedupe_key, received_at, updated_at,
        envelope_from, envelope_to, recipient_domain,
        subject, message_id, raw_sha256,
        archive_enabled, r2_key, raw_size, archived_at,
        rule_id, status, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.dedupe_key,
      row.received_at,
      row.updated_at,
      row.envelope_from,
      row.envelope_to,
      row.recipient_domain,
      row.subject,
      row.message_id,
      row.raw_sha256,
      row.archive_enabled ? 1 : 0,
      row.r2_key,
      row.raw_size,
      row.archived_at,
      row.rule_id,
      row.status,
      row.last_error,
    )
    .run();
}

export async function updateInbound(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const vals = keys.map((k) => fields[k]);
  await db
    .prepare(`UPDATE inbound_messages SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...vals, Date.now(), id)
    .run();
}

export async function ensureTargets(db, inboundId, destinations) {
  const existing = await db
    .prepare("SELECT * FROM delivery_targets WHERE inbound_id = ?")
    .bind(inboundId)
    .all();
  const byDest = new Map((existing.results || []).map((r) => [r.destination, r]));
  const out = [];
  for (const d of destinations) {
    let t = byDest.get(d.email);
    if (!t) {
      const id = crypto.randomUUID();
      const method = d.method || "cf_forward";
      await db
        .prepare(
          `INSERT INTO delivery_targets (
            id, inbound_id, destination, method, provider, send_as, state, attempt_count
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`,
        )
        .bind(id, inboundId, d.email, method, d.provider, d.send_as)
        .run();
      t = {
        id,
        inbound_id: inboundId,
        destination: d.email,
        method,
        provider: d.provider,
        send_as: d.send_as,
        state: "pending",
        attempt_count: 0,
      };
    } else {
      // Repair null/stale method from newer config
      const method = d.method || t.method || "cf_forward";
      if (t.method !== method || t.state === "pending") {
        await db
          .prepare(
            `UPDATE delivery_targets SET method = ?, provider = COALESCE(?, provider), send_as = COALESCE(?, send_as) WHERE id = ?`,
          )
          .bind(method, d.provider ?? null, d.send_as ?? null, t.id)
          .run();
        t.method = method;
        if (d.provider) t.provider = d.provider;
        if (d.send_as) t.send_as = d.send_as;
      }
      t.inbound_id = inboundId;
    }
    out.push(t);
  }
  return out;
}

export async function listTargets(db, inboundId) {
  const r = await db
    .prepare("SELECT * FROM delivery_targets WHERE inbound_id = ?")
    .bind(inboundId)
    .all();
  return r.results || [];
}

export async function insertAttempt(db, row) {
  await db
    .prepare(
      `INSERT INTO delivery_attempts (
        id, inbound_id, delivery_target_id, destination, attempt_number,
        started_at, finished_at, success, error, method, provider, send_as,
        provider_message_id, provider_status, invocation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.inbound_id,
      row.delivery_target_id,
      row.destination,
      row.attempt_number,
      row.started_at,
      row.finished_at,
      row.success ? 1 : 0,
      row.error,
      row.method,
      row.provider,
      row.send_as,
      row.provider_message_id,
      row.provider_status,
      row.invocation_id,
    )
    .run();
}

export async function updateTarget(db, id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  await db
    .prepare(`UPDATE delivery_targets SET ${sets} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id)
    .run();
}

export async function insertReplyRoute(db, row) {
  await db
    .prepare(
      `INSERT INTO reply_routes (token, inbound_id, our_domain, our_mailbox, created_at, multiparty, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.token,
      row.inbound_id,
      row.our_domain,
      row.our_mailbox || null,
      row.created_at,
      row.multiparty ? 1 : 0,
      row.subject || null,
    )
    .run();
}

export async function insertReplyParticipant(db, row) {
  await db
    .prepare(
      `INSERT INTO reply_participants (
        id, token, email, display_hint, role, local_suffix, in_primary, in_all
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.token,
      row.email,
      row.display_hint || null,
      row.role,
      row.local_suffix || null,
      row.in_primary ? 1 : 0,
      row.in_all ? 1 : 0,
    )
    .run();
}

export async function getReplyRoute(db, token) {
  return db
    .prepare("SELECT * FROM reply_routes WHERE token = ?")
    .bind(token)
    .first();
}

export async function listReplyParticipants(db, token) {
  const r = await db
    .prepare("SELECT * FROM reply_participants WHERE token = ?")
    .bind(token)
    .all();
  return r.results || [];
}
