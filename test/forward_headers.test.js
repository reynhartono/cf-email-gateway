import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildForwardTokenHeaders,
  parseCfegMailbox,
} from "../src/forward_headers.js";

describe("forward_headers v2", () => {
  it("formats Reply-To as Name <addr> token mailbox", () => {
    const h = buildForwardTokenHeaders({
      token: "abc123tokenxx",
      ourDomain: "example.com",
      ourMailbox: "desk@example.com",
      primary: {
        email: "alice@a.com",
        display_hint: "Alice Example",
        role: "primary",
        header: "from",
      },
      others: [
        {
          email: "carol@c.com",
          display_hint: "Carol",
          local_suffix: "p1",
          role: "cc",
          header: "cc",
        },
        {
          email: "bob@b.com",
          display_hint: "Bob",
          local_suffix: "p2",
          role: "to",
          header: "to",
        },
      ],
      multiparty: true,
    });

    const replyTo = h.get("X-CFEG-Reply-To");
    assert.match(
      replyTo,
      /^"Alice Example <alice@a\.com>"\s*<r\+abc123tokenxx@example\.com>$/,
    );
    assert.equal(h.get("X-CFEG-Reply-To-Addr"), "r+abc123tokenxx@example.com");
    assert.equal(h.get("X-CFEG-Version"), "2");

    const p1 = h.get("X-CFEG-Reply-To-p1");
    assert.match(p1, /^"Carol <carol@c\.com>"\s*<r\+abc123tokenxx\.p1@example\.com>$/);

    const parties = JSON.parse(h.get("X-CFEG-Parties"));
    assert.equal(parties.length, 3);
    assert.equal(parties[0].email, "alice@a.com");
    assert.equal(parties[1].role, "cc");
    assert.equal(parties[2].suffix, "p2");

    const allAddr = h.get("X-CFEG-Reply-All-Addr").split(", ");
    assert.equal(allAddr.length, 3);
    assert.ok(allAddr[0].startsWith("r+"));
  });

  it("parseCfegMailbox", () => {
    const p = parseCfegMailbox(
      '"Alice <alice@a.com>" <r+tok@example.com>',
    );
    assert.equal(p.displayLabel, "Alice <alice@a.com>");
    assert.equal(p.tokenAddr, "r+tok@example.com");
  });
});
