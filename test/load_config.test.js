import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROUTING_YAML_MISSING,
  hasRoutingYaml,
  isRoutingConfigError,
  loadConfig,
} from "../src/load_config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleYaml = readFileSync(
  join(__dirname, "../config/routing.example.yaml"),
  "utf8",
);

describe("loadConfig / ROUTING_YAML fail-closed", () => {
  it("hasRoutingYaml rejects missing, empty, whitespace", () => {
    assert.equal(hasRoutingYaml({}), false);
    assert.equal(hasRoutingYaml({ ROUTING_YAML: "" }), false);
    assert.equal(hasRoutingYaml({ ROUTING_YAML: "   \n" }), false);
    assert.equal(hasRoutingYaml({ ROUTING_YAML: null }), false);
    assert.equal(hasRoutingYaml({ ROUTING_YAML: exampleYaml }), true);
  });

  it("missing ROUTING_YAML throws (no silent example)", () => {
    assert.throws(
      () => loadConfig({}),
      (err) => {
        assert.equal(err.message, ROUTING_YAML_MISSING);
        assert.equal(isRoutingConfigError(err), true);
        return true;
      },
    );
  });

  it("empty ROUTING_YAML throws", () => {
    assert.throws(
      () => loadConfig({ ROUTING_YAML: "" }),
      /ROUTING_YAML secret missing or empty/,
    );
  });

  it("present ROUTING_YAML parses", () => {
    const c = loadConfig({ ROUTING_YAML: exampleYaml });
    assert.ok(c);
    assert.equal(c.version, 1);
    assert.equal(c.default_inbox, "me@gmail.com");
  });

  it("unparsable ROUTING_YAML throws routing config error", () => {
    assert.throws(
      () => loadConfig({ ROUTING_YAML: "not: [valid\n" }),
      (err) => isRoutingConfigError(err) || /YAML|routing/i.test(String(err)),
    );
  });
});
