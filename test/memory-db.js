/**
 * Minimal in-memory D1-like stub for unit tests.
 */

export function createMemoryDb() {
  const inbound = new Map(); // dedupe -> row
  const byId = new Map();
  const targets = new Map(); // id -> row
  const targetsByInbound = new Map(); // inbound_id -> ids[]
  const attempts = [];
  const replyRoutes = new Map(); // token -> row
  const replyParticipants = new Map(); // token -> rows[]

  function firstFromSelect(sql, binds) {
    if (sql.includes("FROM inbound_messages WHERE dedupe_key")) {
      return inbound.get(binds[0]) || null;
    }
    if (sql.includes("FROM reply_routes WHERE token")) {
      return replyRoutes.get(binds[0]) || null;
    }
    return null;
  }

  return {
    _inbound: inbound,
    _targets: targets,
    _attempts: attempts,
    _replyRoutes: replyRoutes,
    _replyParticipants: replyParticipants,
    prepare(sql) {
      const self = {
        _binds: [],
        bind(...args) {
          self._binds = args;
          return self;
        },
        async first() {
          return firstFromSelect(sql, self._binds);
        },
        async run() {
          if (sql.startsWith("INSERT INTO inbound_messages")) {
            const [
              id,
              dedupe_key,
              received_at,
              updated_at,
              envelope_from,
              envelope_to,
              recipient_domain,
              subject,
              message_id,
              raw_sha256,
              archive_enabled,
              r2_key,
              raw_size,
              archived_at,
              rule_id,
              status,
              last_error,
            ] = self._binds;
            const row = {
              id,
              dedupe_key,
              received_at,
              updated_at,
              envelope_from,
              envelope_to,
              recipient_domain,
              subject,
              message_id,
              raw_sha256,
              archive_enabled,
              r2_key,
              raw_size,
              archived_at,
              rule_id,
              status,
              last_error,
            };
            inbound.set(dedupe_key, row);
            byId.set(id, row);
            return { success: true };
          }
          if (sql.startsWith("UPDATE inbound_messages SET")) {
            const id = self._binds[self._binds.length - 1];
            const updated_at = self._binds[self._binds.length - 2];
            const row = byId.get(id);
            if (!row) return { success: false };
            // fragile parse: match field names from SQL
            const setPart = sql.match(/SET (.+) WHERE/)[1];
            const fields = setPart.split(",").map((s) => s.trim().split(" = ")[0]);
            // last two binds are updated_at and id; values are earlier
            const vals = self._binds.slice(0, -2);
            // fields includes updated_at at end from our helper
            const dataFields = fields.filter((f) => f !== "updated_at");
            dataFields.forEach((f, i) => {
              row[f] = vals[i];
            });
            row.updated_at = updated_at;
            inbound.set(row.dedupe_key, row);
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO delivery_targets")) {
            const [id, inbound_id, destination, method, provider, send_as] =
              self._binds;
            const row = {
              id,
              inbound_id,
              destination,
              method,
              provider,
              send_as,
              state: "pending",
              attempt_count: 0,
              last_error: null,
              last_provider_message_id: null,
              last_attempt_at: null,
              succeeded_at: null,
            };
            targets.set(id, row);
            if (!targetsByInbound.has(inbound_id)) targetsByInbound.set(inbound_id, []);
            targetsByInbound.get(inbound_id).push(id);
            return { success: true };
          }
          if (sql.startsWith("UPDATE delivery_targets SET")) {
            const id = self._binds[self._binds.length - 1];
            const row = targets.get(id);
            const setPart = sql.match(/SET (.+) WHERE/)[1];
            const fields = setPart.split(",").map((s) => s.trim().split(" = ")[0]);
            const vals = self._binds.slice(0, -1);
            fields.forEach((f, i) => {
              row[f] = vals[i];
            });
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO delivery_attempts")) {
            const keys = [
              "id",
              "inbound_id",
              "delivery_target_id",
              "destination",
              "attempt_number",
              "started_at",
              "finished_at",
              "success",
              "error",
              "method",
              "provider",
              "send_as",
              "provider_message_id",
              "provider_status",
              "invocation_id",
            ];
            const row = {};
            keys.forEach((k, i) => {
              row[k] = self._binds[i];
            });
            attempts.push(row);
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO reply_routes")) {
            const [
              token,
              inbound_id,
              our_domain,
              our_mailbox,
              created_at,
              multiparty,
              subject,
            ] = self._binds;
            replyRoutes.set(token, {
              token,
              inbound_id,
              our_domain,
              our_mailbox,
              created_at,
              multiparty,
              subject,
            });
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO reply_participants")) {
            const [
              id,
              token,
              email,
              display_hint,
              role,
              local_suffix,
              in_primary,
              in_all,
            ] = self._binds;
            const row = {
              id,
              token,
              email,
              display_hint,
              role,
              local_suffix,
              in_primary,
              in_all,
            };
            if (!replyParticipants.has(token)) replyParticipants.set(token, []);
            replyParticipants.get(token).push(row);
            return { success: true };
          }
          return { success: true };
        },
        async all() {
          if (sql.includes("FROM delivery_targets WHERE inbound_id")) {
            const ids = targetsByInbound.get(self._binds[0]) || [];
            return { results: ids.map((id) => ({ ...targets.get(id) })) };
          }
          if (sql.includes("FROM reply_participants WHERE token")) {
            return {
              results: (replyParticipants.get(self._binds[0]) || []).map((r) => ({
                ...r,
              })),
            };
          }
          return { results: [] };
        },
      };
      return self;
    },
  };
}

export function fakeMessage({ from, to, raw }) {
  const bytes =
    typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  return {
    from,
    to,
    raw: bytes,
    rawSize: bytes.byteLength,
    headers: new Map(),
    async forward(dest) {
      this._forwarded = this._forwarded || [];
      this._forwarded.push(dest);
    },
    setReject() {},
  };
}
