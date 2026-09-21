import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "../src/config.js";
import { handleInbound } from "../src/pipeline.js";
import { createMemoryDb, fakeMessage } from "./memory-db.js";

const TOKEN = "tokdomainbind1";

function gatewayConfig() {
  return normalizeConfig({
    version: 1,
    archive: { enabled: false },
    default_inbox: "me@gmail.com",
    token_auth: { authorized_from: ["me@gmail.com"] },
    reply_tokens: { enabled: true },
    defaults: { send_as: { enabled: false } },
    domains: {
      "example.com": { send_as: { enabled: true } },
      "other.example": { send_as: { enabled: true } },
    },
  });
}

async function seedRoute(DB) {
  const { insertReplyRoute, insertReplyParticipant } = await import(
    "../src/db.js"
  );
  await insertReplyRoute(DB, {
    token: TOKEN,
    inbound_id: "inb-domain-bind",
    our_domain: "example.com",
    our_mailbox: "shops@example.com",
    created_at: Date.now(),
    multiparty: false,
    subject: "Order",
  });
  await insertReplyParticipant(DB, {
    id: "p-domain-bind",
    token: TOKEN,
    email: "alice@a.com",
    display_hint: "Alice",
    role: "primary",
    local_suffix: null,
    in_primary: true,
    in_all: true,
  });
  await insertReplyParticipant(DB, {
    id: "p-domain-bind-p1",
    token: TOKEN,
    email: "carol@c.com",
    display_hint: "Carol",
    role: "cc",
    local_suffix: "p1",
    in_primary: false,
    in_all: true,
  });
}

function hopMessage(to, messageId) {
  const raw =
    `From: me@gmail.com\r\n` +
    `To: ${to}\r\n` +
    `Subject: Re: Order\r\n` +
    `Message-ID: ${messageId}\r\n` +
    `\r\n` +
    `reply body`;
  return fakeMessage({ from: "me@gmail.com", to, raw });
}

function captureConsole() {
  const lines = [];
  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const grab = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  return {
    lines,
    restore() {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    },
  };
}

describe("reply token apex bind (issue #24)", () => {
  it("hops when envelope domain matches the mint-time our_domain", async () => {
    const DB = createMemoryDb();
    await seedRoute(DB);
    const config = gatewayConfig();
    const msg = hopMessage(`r+${TOKEN}@example.com`, "<hop-same-apex@t>");

    let sent = null;
    const res = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
      skipCfAuth: true,
      archivePut: async () => ({ ok: true, r2_key: "k" }),
      deliver: async () => {
        throw new Error("must take the reply hop, not the default route");
      },
      smtpSend: async (_env, req) => {
        sent = req;
        return { ok: true, providerMessageId: "hop1" };
      },
    });

    assert.equal(res.status, "reply_token_completed");
    assert.equal(sent?.mailFrom, "shops@example.com");
  });

  it("hops case-insensitively on the mint-time apex", async () => {
    const DB = createMemoryDb();
    await seedRoute(DB);
    const config = gatewayConfig();
    const msg = hopMessage(`R+${TOKEN}@EXAMPLE.COM`, "<hop-upper-apex@t>");

    let sent = null;
    const res = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
      skipCfAuth: true,
      archivePut: async () => ({ ok: true, r2_key: "k" }),
      deliver: async () => {
        throw new Error("must take the reply hop, not the default route");
      },
      smtpSend: async (_env, req) => {
        sent = req;
        return { ok: true, providerMessageId: "hop1" };
      },
    });

    assert.equal(res.status, "reply_token_completed");
    assert.equal(sent?.mailFrom, "shops@example.com");
  });

  it("skips cross-apex hops with suffix forms", async () => {
    // The domain gate runs before suffix branching, so .all/.p1 variants
    // (which would otherwise resolve participants) must also fall through.
    for (const [suffix, mid] of [
      ["all", "<hop-cross-all@t>"],
      ["p1", "<hop-cross-p1@t>"],
    ]) {
      const DB = createMemoryDb();
      await seedRoute(DB);
      const config = gatewayConfig();
      const msg = hopMessage(`r+${TOKEN}.${suffix}@other.example`, mid);

      let forwarded = null;
      let smtpCalled = false;
      const res = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
        skipCfAuth: true,
        archivePut: async () => ({ ok: true, r2_key: "k" }),
        deliver: async (_env, _message, t) => {
          forwarded = t.destination;
          return { ok: true };
        },
        smtpSend: async () => {
          smtpCalled = true;
          return { ok: true };
        },
      });

      assert.equal(res.status, "completed", `suffix .${suffix} must skip`);
      assert.equal(forwarded, "me@gmail.com", `suffix .${suffix} must forward`);
      assert.equal(smtpCalled, false, `suffix .${suffix} must not send`);
    }
  });

  it("skips the hop when the token is presented on another apex", async () => {
    const DB = createMemoryDb();
    await seedRoute(DB);
    const config = gatewayConfig();
    const hopAddr = `r+${TOKEN}@other.example`;
    const msg = hopMessage(hopAddr, "<hop-cross-apex@t>");

    let forwarded = null;
    let smtpCalled = false;
    const cap = captureConsole();
    let res;
    try {
      res = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
        skipCfAuth: true,
        archivePut: async () => ({ ok: true, r2_key: "k" }),
        deliver: async (_env, _message, t) => {
          forwarded = t.destination;
          return { ok: true };
        },
        smtpSend: async () => {
          smtpCalled = true;
          return { ok: true };
        },
      });
    } finally {
      cap.restore();
    }

    assert.equal(res.status, "completed");
    assert.equal(forwarded, "me@gmail.com");
    assert.equal(smtpCalled, false);
    const skipped = cap.lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.event === "reply_token.exception_skipped");
    assert.ok(skipped, "expected reply_token.exception_skipped log");
    assert.equal(skipped.reason, "token_domain_mismatch");
  });

  it("skips the hop when the stored route has an empty domain", async () => {
    // Fail-closed branch: "" must never equal "" at the gate. Both sides
    // are empty here (degenerate stored row + bare r+TOKEN@ envelope), so
    // without the guard the comparison would pass and the hop would run.
    // Seeded directly — mint always sets a domain, so this path is only
    // reachable from degenerate stored data.
    const DB = createMemoryDb();
    const { insertReplyRoute, insertReplyParticipant } = await import(
      "../src/db.js"
    );
    const emptyToken = "tokemptyguard1";
    await insertReplyRoute(DB, {
      token: emptyToken,
      inbound_id: "inb-empty-guard",
      our_domain: "",
      our_mailbox: "shops@example.com",
      created_at: Date.now(),
      multiparty: false,
      subject: "Order",
    });
    await insertReplyParticipant(DB, {
      id: "p-empty-guard",
      token: emptyToken,
      email: "alice@a.com",
      display_hint: "Alice",
      role: "primary",
      local_suffix: null,
      in_primary: true,
      in_all: true,
    });
    const config = gatewayConfig();
    const msg = hopMessage(`r+${emptyToken}@`, "<hop-empty-guard@t>");

    let forwarded = null;
    let smtpCalled = false;
    const cap = captureConsole();
    let res;
    try {
      res = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
        skipCfAuth: true,
        archivePut: async () => ({ ok: true, r2_key: "k" }),
        deliver: async (_env, _message, t) => {
          forwarded = t.destination;
          return { ok: true };
        },
        smtpSend: async () => {
          smtpCalled = true;
          return { ok: true };
        },
      });
    } finally {
      cap.restore();
    }

    assert.equal(res.status, "completed");
    assert.equal(forwarded, "me@gmail.com");
    assert.equal(smtpCalled, false);
    const skipped = cap.lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.event === "reply_token.exception_skipped");
    assert.ok(skipped, "expected reply_token.exception_skipped log");
    assert.equal(skipped.reason, "token_domain_mismatch");
  });
});
