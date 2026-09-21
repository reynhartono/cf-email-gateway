import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "../src/config.js";
import {
  redactReplyTokenAddressForLog,
  replyTokenLogFields,
  replyTokenLogPrefix,
} from "../src/log.js";
import { handleInbound } from "../src/pipeline.js";
import { sha256Hex } from "../src/util.js";
import { createMemoryDb, fakeMessage } from "./memory-db.js";

function tokenConfig() {
  return normalizeConfig({
    version: 1,
    default_inbox: "me@gmail.com",
    archive: { enabled: false },
    reply_tokens: { enabled: true },
    defaults: { send_as: { enabled: false } },
    domains: {
      "example.com": { send_as: { enabled: true } },
    },
  });
}

function rawMail(messageId) {
  return (
    `From: Alice <alice@a.com>\r\n` +
    `To: shops@example.com\r\n` +
    `Subject: Order\r\n` +
    `Message-ID: ${messageId}\r\n` +
    `\r\n` +
    `Hello`
  );
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

function parsedEvents(lines) {
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // ignore non-JSON (test runner / other)
    }
  }
  return events;
}

describe("reply token log helpers", () => {
  it("exposes prefix and truncated sha256, not the raw token", async () => {
    const token = "capabilitytok";
    const fields = await replyTokenLogFields(token, "example.com");
    assert.equal(fields.token_prefix, "capa");
    assert.equal(replyTokenLogPrefix(token), "capa");
    const hex = await sha256Hex(new TextEncoder().encode(token));
    assert.equal(fields.token_sha256, hex.slice(0, 16));
    assert.equal(fields.token, undefined);
    assert.equal(fields.replyTo, "r+capa…@example.com");
    assert.equal(JSON.stringify(fields).includes(token), false);
  });

  it("redacts r+ hop addresses including suffix forms", () => {
    assert.equal(
      redactReplyTokenAddressForLog("r+capabilitytok@example.com"),
      "r+capa…@example.com",
    );
    assert.equal(
      redactReplyTokenAddressForLog("r+capabilitytok.p1@Example.com"),
      "r+capa….p1@example.com",
    );
    assert.equal(
      redactReplyTokenAddressForLog("shops@example.com"),
      "shops@example.com",
    );
  });
});

describe("reply token Worker logs", () => {
  it("mint logs do not contain the raw token or full r+ address", async () => {
    const DB = createMemoryDb();
    const config = tokenConfig();
    const msg = fakeMessage({
      from: "alice@a.com",
      to: "shops@example.com",
      raw: rawMail("<mint-log@id>"),
    });
    const cap = captureConsole();
    let result;
    let deliveredToken;
    try {
      result = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
        deliver: async (_e, _m, _t, _c, rawCtx) => {
          deliveredToken = rawCtx.forwardTokenMeta?.token;
          return { ok: true };
        },
      });
    } finally {
      cap.restore();
    }

    assert.equal(result.status, "completed");
    assert.equal(DB._replyRoutes.size, 1);
    const token = [...DB._replyRoutes.keys()][0];
    assert.equal(deliveredToken, token);
    assert.ok(token.length >= 8, "minted token should be a capability secret");

    const blob = cap.lines.join("\n");
    assert.equal(
      blob.includes(token),
      false,
      "raw token must not appear in logs",
    );
    assert.equal(
      blob.includes(`r+${token}@`),
      false,
      "full hop address must not appear in logs",
    );

    const mint = parsedEvents(cap.lines).find((e) => e.event === "forward.token");
    assert.ok(mint, "expected forward.token log");
    assert.equal(mint.token, undefined);
    assert.equal(mint.token_prefix, token.slice(0, 4));
    assert.ok(mint.token_sha256);
    assert.ok(!String(mint.replyTo || "").includes(token));
  });

  it("reuse logs do not contain the raw token or full r+ address", async () => {
    const DB = createMemoryDb();
    const config = tokenConfig();
    const mid = "<reuse-log@id>";
    const msg1 = fakeMessage({
      from: "alice@a.com",
      to: "shops@example.com",
      raw: rawMail(mid),
    });
    const msg2 = fakeMessage({
      from: "alice@a.com",
      to: "shops@example.com",
      raw: `Received: from cf\r\n${rawMail(mid)}`,
    });

    await handleInbound({ DB, ARCHIVE: {} }, msg1, config, {
      deliver: async () => ({ ok: true }),
    });
    assert.equal(DB._replyRoutes.size, 1);
    const token = [...DB._replyRoutes.keys()][0];

    const cap = captureConsole();
    let result;
    try {
      result = await handleInbound({ DB, ARCHIVE: {} }, msg2, config, {
        deliver: async () => {
          throw new Error("should not re-deliver succeeded dest");
        },
      });
    } finally {
      cap.restore();
    }

    assert.equal(result.status, "completed");
    const blob = cap.lines.join("\n");
    assert.equal(
      blob.includes(token),
      false,
      "raw token must not appear in reuse logs",
    );
    assert.equal(blob.includes(`r+${token}@`), false);

    const reuse = parsedEvents(cap.lines).find(
      (e) => e.event === "forward.token_reuse",
    );
    assert.ok(reuse, "expected forward.token_reuse log");
    assert.equal(reuse.token, undefined);
    assert.equal(reuse.token_prefix, token.slice(0, 4));
    assert.ok(reuse.token_sha256);
    assert.ok(!String(reuse.replyTo || "").includes(token));
  });

  it("hop logs do not contain the raw token or full r+ address", async () => {
    const DB = createMemoryDb();
    const { insertReplyRoute, insertReplyParticipant } = await import(
      "../src/db.js"
    );
    const token = "tokhopsecret1";
    await insertReplyRoute(DB, {
      token,
      inbound_id: "inb-hop-log",
      our_domain: "example.com",
      our_mailbox: "alice.netflix@example.com",
      created_at: Date.now(),
      multiparty: false,
      subject: "Hi",
    });
    await insertReplyParticipant(DB, {
      id: "p-hop-log",
      token,
      email: "ext@elsewhere.com",
      display_hint: "Ext",
      role: "primary",
      local_suffix: null,
      in_primary: true,
      in_all: true,
    });
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      identities: [
        {
          id: "alice",
          authorized_from: ["alice@gmail.com"],
          can_send_as: [
            {
              type: "local_part_prefix",
              value: "alice.",
              domain: "example.com",
            },
          ],
        },
      ],
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    const hopAddr = `r+${token}@example.com`;
    const raw =
      `From: alice@gmail.com\r\nTo: ${hopAddr}\r\nSubject: Re: Hi\r\n` +
      `Message-ID: <hop-log@t>\r\n` +
      `Authentication-Results: mock; dkim=pass header.i=@gmail.com\r\n\r\nreply body`;
    const msg = fakeMessage({
      from: "alice@gmail.com",
      to: hopAddr,
      raw,
    });
    const cap = captureConsole();
    let result;
    try {
      result = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
        skipCfAuth: true,
        archivePut: async () => ({ ok: true, r2_key: "k" }),
        smtpSend: async () => ({ ok: true, providerMessageId: "hop1" }),
      });
    } finally {
      cap.restore();
    }

    assert.equal(result.status, "reply_token_completed");
    const blob = cap.lines.join("\n");
    assert.equal(blob.includes(token), false, "raw token must not appear in hop logs");
    assert.equal(blob.includes(hopAddr), false, "full hop address must not appear in logs");

    const route = parsedEvents(cap.lines).find(
      (e) => e.event === "inbound.route" && e.kind === "reply_token",
    );
    assert.ok(route, "expected inbound.route reply_token log");
    assert.equal(route.token, undefined);
    assert.equal(route.token_prefix, token.slice(0, 4));
    assert.ok(route.token_sha256);

    const start = parsedEvents(cap.lines).find((e) => e.event === "inbound.start");
    assert.ok(start);
    assert.equal(start.envelopeTo.includes(token), false);
  });

  it("exception_skipped hop logs do not contain the raw token or full r+ address", async () => {
    const DB = createMemoryDb();
    const { insertReplyRoute, insertReplyParticipant } = await import(
      "../src/db.js"
    );
    const token = "tokskipsecret1";
    await insertReplyRoute(DB, {
      token,
      inbound_id: "inb-skip-log",
      our_domain: "example.com",
      our_mailbox: "bob.github@example.com",
      created_at: Date.now(),
      multiparty: false,
      subject: "Hi",
    });
    await insertReplyParticipant(DB, {
      id: "p-skip-log",
      token,
      email: "ext@elsewhere.com",
      display_hint: "Ext",
      role: "primary",
      local_suffix: null,
      in_primary: true,
      in_all: true,
    });
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      default_inbox: "me@gmail.com",
      identities: [
        {
          id: "alice",
          authorized_from: ["alice@gmail.com"],
          can_send_as: [
            {
              type: "local_part_prefix",
              value: "alice.",
              domain: "example.com",
            },
          ],
        },
        {
          id: "bob",
          authorized_from: ["bob@gmail.com"],
          can_send_as: [
            {
              type: "local_part_prefix",
              value: "bob.",
              domain: "example.com",
            },
          ],
        },
      ],
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    const hopAddr = `r+${token}@example.com`;
    const raw =
      `From: alice@gmail.com\r\nTo: ${hopAddr}\r\nSubject: Re: Hi\r\n` +
      `Message-ID: <hop-skip-log@t>\r\n\r\nsteal`;
    const msg = fakeMessage({
      from: "alice@gmail.com",
      to: hopAddr,
      raw,
    });
    const cap = captureConsole();
    let result;
    try {
      result = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
        skipCfAuth: true,
        deliver: async () => ({ ok: true }),
        smtpSend: async () => {
          throw new Error("smtp must not run");
        },
      });
    } finally {
      cap.restore();
    }

    assert.equal(result.status, "completed");
    const blob = cap.lines.join("\n");
    assert.equal(blob.includes(token), false);
    assert.equal(blob.includes(hopAddr), false);
    const skipped = parsedEvents(cap.lines).find(
      (e) => e.event === "reply_token.exception_skipped",
    );
    assert.ok(skipped);
    assert.equal(String(skipped.envelopeTo || "").includes(token), false);
  });
});
