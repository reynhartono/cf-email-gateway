import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROUTING_YAML_MISSING,
  allowExampleRouting,
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

  it("allowExampleRouting is explicit opt-in only", () => {
    assert.equal(allowExampleRouting({}), false);
    assert.equal(allowExampleRouting({ ALLOW_EXAMPLE_ROUTING: "0" }), false);
    assert.equal(allowExampleRouting({ ALLOW_EXAMPLE_ROUTING: "false" }), false);
    assert.equal(allowExampleRouting({ ALLOW_EXAMPLE_ROUTING: "1" }), true);
    assert.equal(allowExampleRouting({ ALLOW_EXAMPLE_ROUTING: "true" }), true);
    assert.equal(allowExampleRouting({ ALLOW_EXAMPLE_ROUTING: true }), true);
  });

  it("missing ROUTING_YAML throws (no silent example)", () => {
    assert.throws(
      () => loadConfig({}, { exampleYamlText: exampleYaml }),
      (err) => {
        assert.equal(err.message, ROUTING_YAML_MISSING);
        assert.equal(isRoutingConfigError(err), true);
        return true;
      },
    );
  });

  it("empty ROUTING_YAML throws even when example text is provided", () => {
    assert.throws(
      () =>
        loadConfig(
          { ROUTING_YAML: "" },
          { exampleYamlText: exampleYaml },
        ),
      /ROUTING_YAML secret missing or empty/,
    );
  });

  it("present ROUTING_YAML parses without example opt-in", () => {
    const c = loadConfig({ ROUTING_YAML: exampleYaml });
    assert.ok(c);
    assert.equal(c.version, 1);
    assert.equal(c.default_inbox, "me@gmail.com");
  });

  it("ALLOW_EXAMPLE_ROUTING uses bundled example when secret absent", () => {
    const c = loadConfig(
      { ALLOW_EXAMPLE_ROUTING: "1" },
      { exampleYamlText: exampleYaml },
    );
    assert.ok(c);
    assert.equal(c.version, 1);
  });

  it("ALLOW_EXAMPLE_ROUTING without example text throws", () => {
    assert.throws(
      () => loadConfig({ ALLOW_EXAMPLE_ROUTING: "1" }),
      /bundled example routing is unavailable/,
    );
  });

  it("unparsable ROUTING_YAML throws routing config error", () => {
    assert.throws(
      () => loadConfig({ ROUTING_YAML: "not: [valid\n" }),
      (err) => isRoutingConfigError(err) || /YAML|routing/i.test(String(err)),
    );
  });

  it("secret wins over ALLOW_EXAMPLE_ROUTING", () => {
    const custom = `version: 1
default_inbox: custom@gmail.com
archive:
  enabled: false
domains:
  example.com:
    send_as:
      enabled: false
rules: []
`;
    const c = loadConfig(
      { ROUTING_YAML: custom, ALLOW_EXAMPLE_ROUTING: "1" },
      { exampleYamlText: exampleYaml },
    );
    assert.equal(c.default_inbox, "custom@gmail.com");
  });
});
