import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "../src/config.js";
import { handleInbound } from "../src/pipeline.js";
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

function rawMail(messageId, extraHdr = "") {
  return (
    `${extraHdr}From: Alice <alice@a.com>\r\n` +
    `To: shops@example.com\r\n` +
    `Subject: Order\r\n` +
    `Message-ID: ${messageId}\r\n` +
    `\r\n` +
    `Hello`
  );
}

describe("reply token on duplicate inbound", () => {
  it("does not mint a second token when Message-ID already ingested", async () => {
    const DB = createMemoryDb();
    const config = tokenConfig();
    const env = { DB, ARCHIVE: {} };
    const mid = "<same@id>";
    const msg1 = fakeMessage({
      from: "alice@a.com",
      to: "shops@example.com",
      raw: rawMail(mid),
    });
    const msg2 = fakeMessage({
      from: "alice@a.com",
      to: "shops@example.com",
      raw: rawMail(mid, "Received: from cf\r\n"),
    });

    const first = await handleInbound(env, msg1, config, {
      deliver: async () => ({ ok: true }),
    });
    assert.equal(first.status, "completed");
    assert.equal(DB._replyRoutes.size, 1);
    const tokenA = [...DB._replyRoutes.keys()][0];

    const second = await handleInbound(env, msg2, config, {
      deliver: async () => {
        throw new Error("should not re-deliver succeeded dest");
      },
    });
    assert.equal(second.status, "completed");
    assert.equal(DB._replyRoutes.size, 1);
    assert.equal([...DB._replyRoutes.keys()][0], tokenA);
    assert.equal(DB._inbound.size, 1);
  });

  it("reuses the first token on remaining dest retry", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      reply_tokens: { enabled: true },
      defaults: { send_as: { enabled: false } },
      domains: { "example.com": { send_as: { enabled: true } } },
      rules: [
        {
          id: "shops",
          skip_default_inbox: true,
          match: { type: "address", value: "shops@example.com" },
          destinations: [
            { email: "me@gmail.com" },
            { email: "also@gmail.com" },
          ],
        },
      ],
    });
    const env = { DB, ARCHIVE: {} };
    const mid = "<retry@id>";
    const msg1 = fakeMessage({
      from: "alice@a.com",
      to: "shops@example.com",
      raw: rawMail(mid),
    });
    const msg2 = fakeMessage({
      from: "alice@a.com",
      to: "shops@example.com",
      raw: rawMail(mid, "Received: from cf\r\n"),
    });

    await assert.rejects(() =>
      handleInbound(env, msg1, config, {
        deliver: async (_e, _m, t) => {
          if (t.destination === "me@gmail.com") return { ok: true };
          return { ok: false, error: "not verified" };
        },
      }),
    );
    assert.equal(DB._replyRoutes.size, 1);
    const tokenA = [...DB._replyRoutes.keys()][0];

    const seen = [];
    await assert.rejects(() =>
      handleInbound(env, msg2, config, {
        deliver: async (_e, _m, t, _c, rawCtx) => {
          seen.push({
            dest: t.destination,
            token: rawCtx.forwardTokenMeta?.token,
          });
          return { ok: false, error: "not verified" };
        },
      }),
    );
    assert.equal(DB._replyRoutes.size, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].dest, "also@gmail.com");
    assert.equal(seen[0].token, tokenA);
  });
});
