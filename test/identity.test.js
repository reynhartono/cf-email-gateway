import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "../src/config.js";
import {
  findIdentityByAuthorizedFrom,
  findIdentityByComposeBearer,
  identityMaySendAs,
  resolveComposeCaller,
  assertMailboxAllowedOrThrow,
} from "../src/identity.js";

function cfg(extra = {}) {
  return normalizeConfig({
    version: 1,
    default_inbox: "me@gmail.com",
    token_auth: {
      authorized_from: ["legacy@gmail.com"],
    },
    domains: {
      "example.com": { send_as: { enabled: true } },
    },
    identities: [
      {
        id: "alice",
        authorized_from: ["alice@gmail.com"],
        compose_bearer: "tok-alice",
        can_send_as: [
          { type: "local_part_prefix", value: "alice.", domain: "example.com" },
          { type: "address", value: "alice@example.com" },
        ],
      },
      {
        id: "bob",
        authorized_from: ["Bob@Gmail.com"],
        compose_bearer: "tok-bob",
        can_send_as: [
          { type: "local_part_prefix", value: "bob.", domain: "example.com" },
        ],
      },
      {
        id: "operator",
        authorized_from: ["me@gmail.com"],
        unrestricted: true,
      },
    ],
    ...extra,
  });
}

describe("identity ACL", () => {
  it("findIdentityByAuthorizedFrom is case-insensitive", () => {
    const c = cfg();
    assert.equal(findIdentityByAuthorizedFrom(c, "Alice@Gmail.com")?.id, "alice");
    assert.equal(findIdentityByAuthorizedFrom(c, "bob@gmail.com")?.id, "bob");
    assert.equal(findIdentityByAuthorizedFrom(c, "nobody@gmail.com"), null);
  });

  it("identityMaySendAs respects prefix and exact address", () => {
    const c = cfg();
    const alice = findIdentityByAuthorizedFrom(c, "alice@gmail.com");
    assert.equal(identityMaySendAs(alice, "alice.netflix@example.com"), true);
    assert.equal(identityMaySendAs(alice, "alice@example.com"), true);
    assert.equal(identityMaySendAs(alice, "bob.github@example.com"), false);
    assert.equal(identityMaySendAs(alice, "alice@other.example"), false);
  });

  it("unrestricted identity may send as any mailbox", () => {
    const c = cfg();
    const op = findIdentityByAuthorizedFrom(c, "me@gmail.com");
    assert.equal(identityMaySendAs(op, "anyone@example.com"), true);
  });

  it("findIdentityByComposeBearer", () => {
    const c = cfg();
    assert.equal(findIdentityByComposeBearer(c, "tok-alice")?.id, "alice");
    assert.equal(findIdentityByComposeBearer(c, "nope"), null);
  });

  it("resolveComposeCaller: principal bearer maps to identity", () => {
    const c = cfg();
    const r = resolveComposeCaller(c, "tok-bob", "env-operator-token");
    assert.equal(r.ok, true);
    assert.equal(r.identity.id, "bob");
  });

  it("resolveComposeCaller: COMPOSE_API_TOKEN maps to unrestricted identity", () => {
    const c = cfg();
    const r = resolveComposeCaller(c, "env-operator-token", "env-operator-token");
    assert.equal(r.ok, true);
    assert.equal(r.identity.id, "operator");
    assert.equal(r.identity.unrestricted, true);
  });

  it("resolveComposeCaller: COMPOSE_API_TOKEN fails when no unrestricted identity", () => {
    const c = cfg({
      identities: [
        {
          id: "alice",
          authorized_from: ["alice@gmail.com"],
          compose_bearer: "tok-alice",
          can_send_as: [
            { type: "local_part_prefix", value: "alice.", domain: "example.com" },
          ],
        },
      ],
    });
    const r = resolveComposeCaller(c, "env-operator-token", "env-operator-token");
    assert.equal(r.ok, false);
    assert.match(r.error, /unrestricted|operator/i);
  });

  it("resolveComposeCaller: legacy mode without identities accepts COMPOSE_API_TOKEN as unrestricted", () => {
    const c = normalizeConfig({
      version: 1,
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    const r = resolveComposeCaller(c, "env-token", "env-token");
    assert.equal(r.ok, true);
    assert.equal(r.identity.unrestricted, true);
    assert.equal(r.legacy, true);
  });

  it("assertMailboxAllowedOrThrow rejects cross-prefix", () => {
    const c = cfg();
    const alice = findIdentityByAuthorizedFrom(c, "alice@gmail.com");
    assert.doesNotThrow(() =>
      assertMailboxAllowedOrThrow(alice, "alice.x@example.com"),
    );
    assert.throws(
      () => assertMailboxAllowedOrThrow(alice, "bob.x@example.com"),
      /not allowed/i,
    );
  });

  it("identitiesConfigured false when empty", () => {
    const c = normalizeConfig({ version: 1, identities: [] });
    assert.equal(c.identities.length, 0);
  });
});
