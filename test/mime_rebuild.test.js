import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rebuildOutboundMime,
  splitMime,
  mimeToBase64,
  subjectFromRaw,
} from "../src/mime_rebuild.js";

describe("mime_rebuild 1:1 body", () => {
  const sample = [
    "From: Operator <me@gmail.com>",
    "To: r+tok@example.com",
    "Subject: Re: testing reply",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="00000000000023e8cb0659fe897c"',
    "",
    '--00000000000023e8cb0659fe897c',
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Test the actual reply",
    "",
    "Best regards,",
    "Operator",
    "",
    '--00000000000023e8cb0659fe897c',
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    '<div dir=3D"ltr"><div>Test the actual reply</div></div>',
    "",
    "--00000000000023e8cb0659fe897c--",
    "",
  ].join("\r\n");

  it("keeps body and Content-Type 1:1", () => {
    const out = rebuildOutboundMime({
      rawText: sample,
      from: '"import-test@example.com" <import-test@example.com>',
      to: '"Alice" <alice@a.com>',
    });
    assert.match(
      out,
      /Content-Type: multipart\/alternative; boundary="00000000000023e8cb0659fe897c"/,
    );
    assert.match(out, /Content-Type: text\/html; charset="UTF-8"/);
    assert.match(out, /quoted-printable/);
    assert.match(out, /dir=3D"ltr"/);
    assert.match(out, /Test the actual reply/);
    assert.match(out, /From: "import-test@example\.com"/);
    assert.match(out, /To: "Alice" <alice@a\.com>/);
    // body after blank line unchanged slice
    const { body: origBody } = splitMime(sample);
    const { body: outBody } = splitMime(out);
    assert.equal(outBody, origBody);
  });

  it("subjectFromRaw", () => {
    assert.equal(subjectFromRaw(sample), "Re: testing reply");
  });

  it("mimeToBase64 roundtrip-ish", () => {
    const b64 = mimeToBase64("hello");
    assert.equal(atob(b64), "hello");
  });
});
