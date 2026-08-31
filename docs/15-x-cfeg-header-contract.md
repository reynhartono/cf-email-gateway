# 15 — X-CFEG header contract (producer)

**Version:** `2`  
**Producer:** this repo (`src/forward_headers.js`, `src/reply_tokens.js`)  
**Consumer pin:** `cfeg-reply-extension` → `docs/02-header-contract.md`; **`cfeg-reply-addon`** → `docs/02-header-contract.md` (Workspace Add-on)

Breaking changes → bump `X-CFEG-Version` and coordinate extension release.

---

## Why X-* (not real Reply-To)?

| Approach | Problem |
|----------|---------|
| Rewrite MIME `Reply-To` | May break sender **DKIM** |
| CF `message.forward()` | Only allows **`X-*`** extra headers |

So: **cf_forward** keeps original MIME/DKIM; tokens live in **`X-CFEG-*`**.  
Native Gmail Reply ignores them → **CFEG Reply** extension (or manual `r+TOKEN@`).

---

## Participant selection (normative)

External = not our domain, not `default_inbox`.

### Primary (Reply → one token)

1. First external address on original **`Reply-To`** (if any)  
2. Else first external **`From`**

### Others (Reply-All → `p1`…`pN`)

Remaining external addresses, order:

1. Other **`Reply-To`**  
2. **`From`** (if not primary)  
3. External **`To`**  
4. External **`Cc`**

Deduped by email. Display name prefers From/Reply-To over bare Cc.

**Not tokenized:** `*@ourdomain` (including multi-To on our domain) — they are “us”.

---

## Header table

| Header | Example | Role |
|--------|---------|------|
| `X-CFEG-Version` | `2` | Contract version |
| `X-CFEG-Reply-To` | `"Alice <alice@a.com>" <r+TOKEN@example.com>` | Primary compose mailbox |
| `X-CFEG-Reply-To-Addr` | `r+TOKEN@example.com` | Bare hop addr |
| `X-Reply-To` | same as Reply-To | Alias |
| `X-CFEG-Reply-To-Display` | `Alice <alice@a.com>` | UI label |
| `X-CFEG-Reply-Token` | `TOKEN` | Token id |
| `X-CFEG-Reply-Mailbox` | `desk@example.com` | Envelope To (our_mailbox / hop From) |
| `X-CFEG-Parties` | JSON array (one line) | Multiparty map |
| `X-CFEG-Reply-All-Addr` | `r+T@d, r+T.p1@d, …` | Reply-All bare tokens |
| `X-CFEG-Reply-All` | full mailboxes CSV | Reply-All chips |
| `X-CFEG-Reply-To-pN` | `"Carol <c@…>" <r+T.pN@…>` | Per-party mailbox |
| `X-CFEG-Reply-To-pN-Addr` | bare | Per-party bare hop |
| `X-CFEG-Participant-pN` | `email\|name` | Per-party labels |

### Mailbox form (primary + pN)

```text
"Original Name <original@addr>" <r+TOKEN[.pN]@ourdomain>
```

- **Display-name** = original person (`Name <real@email>` or bare email)  
- **Angle-addr** = hop only (`r+…`) — compose To must deliver here  

### `X-CFEG-Parties` element

```json
{
  "role": "primary|from|reply-to|to|cc|other",
  "header": "from|reply-to|to|cc|…",
  "name": "Alice Example",
  "email": "alice@a.com",
  "token": "r+TOKEN@example.com",
  "suffix": null,
  "mailbox": "\"Alice Example <alice@a.com>\" <r+TOKEN@example.com>"
}
```

---

## Extension mapping

| Action | Compose |
|--------|---------|
| **Reply** | To = primary **token** (`Reply-To-Addr` or angle-addr); chip may show original name |
| **Reply-All** | To = primary token; **Cc** = other parties’ tokens only |

Never put raw external addresses on the wire for reply — **tokens only** so the hop runs.

---

## Reply hop (gateway)

Mail to `r+TOKEN` / `r+TOKEN.pN` / `r+TOKEN.all` from `authorized_from` → SMTP **DATA** 1:1 MIME as **`our_mailbox`** → participant(s).

---

## Example scenarios

### S1 — Simple From only

```text
From: Alice <alice@a.com>
To: desk@example.com
```

| Party | role | token |
|-------|------|--------|
| Alice | primary | `r+TOKEN@example.com` |

```text
X-CFEG-Version: 2
X-CFEG-Reply-To: "Alice <alice@a.com>" <r+TOKEN@example.com>
X-CFEG-Reply-To-Addr: r+TOKEN@example.com
X-CFEG-Reply-Mailbox: desk@example.com
X-CFEG-Parties: [{"role":"primary","header":"from","name":"Alice","email":"alice@a.com","token":"r+TOKEN@example.com","suffix":null,"mailbox":"\"Alice <alice@a.com>\" <r+TOKEN@example.com>"}]
X-CFEG-Reply-All-Addr: r+TOKEN@example.com
```

---

### S2 — From + single Cc

```text
From: Alice Example <alice@a.com>
To: cc-test@example.com
Cc: peer@cc.example
```

| Party | role | token |
|-------|------|--------|
| alice@ | primary | `r+TOKEN@example.com` |
| peer@cc.example | cc | `r+TOKEN.p1@example.com` |

```text
X-CFEG-Reply-To: "Alice Example <alice@a.com>" <r+TOKEN@example.com>
X-CFEG-Reply-To-p1: "peer@cc.example" <r+TOKEN.p1@example.com>
X-CFEG-Reply-All-Addr: r+TOKEN@example.com, r+TOKEN.p1@example.com
X-CFEG-Parties: [
  {"role":"primary","header":"from","name":"Alice Example","email":"alice@a.com","token":"r+TOKEN@example.com","suffix":null,...},
  {"role":"cc","header":"cc","name":"","email":"peer@cc.example","token":"r+TOKEN.p1@example.com","suffix":"p1",...}
]
```

Reply → only Alice hop.  
Reply-All → primary To + p1 on Cc.

---

### S3 — Original Reply-To wins

```text
From: Alice <alice@a.com>
Reply-To: Desk <desk@vendor.com>
To: catch@example.com
Cc: Carol <carol@c.com>
```

| Party | role | token |
|-------|------|--------|
| desk@vendor.com | primary | `r+TOKEN@` |
| alice@a.com | from | `r+TOKEN.p1@` |
| carol@c.com | cc | `r+TOKEN.p2@` |

```text
X-CFEG-Reply-To: "Desk <desk@vendor.com>" <r+TOKEN@example.com>
X-CFEG-Reply-To-p1: "Alice <alice@a.com>" <r+TOKEN.p1@example.com>
X-CFEG-Reply-To-p2: "Carol <carol@c.com>" <r+TOKEN.p2@example.com>
```

---

### S4 — Multiple external To + Cc

```text
From: Alice <alice@a.com>
To: Bob <bob@b.com>, catch@example.com, Dana <dana@d.com>
Cc: Carol <carol@c.com>, Eve <eve@e.com>
```

| # | email | role |
|---|-------|------|
| 0 | alice@a.com | primary |
| p1 | bob@b.com | to |
| p2 | dana@d.com | to |
| p3 | carol@c.com | cc |
| p4 | eve@e.com | cc |

`catch@example.com` omitted (our domain).

```text
X-CFEG-Reply-All-Addr: r+T@example.com, r+T.p1@example.com, r+T.p2@example.com, r+T.p3@example.com, r+T.p4@example.com
```

---

### S5 — Multiple Reply-To

```text
From: Alice <alice@a.com>
Reply-To: R1 <r1@x.com>, R2 <r2@x.com>
To: catch@example.com
```

| # | email | role |
|---|-------|------|
| 0 | r1@x.com | primary |
| p1 | r2@x.com | reply-to |
| p2 | alice@a.com | from |

---

### S6 — Reply-To same as From

```text
From: Alice <alice@a.com>
Reply-To: Alice <alice@a.com>
To: desk@example.com
Cc: carol@c.com
```

Primary once (deduped). Parties: Alice primary, Carol cc.

---

### S7 — Only our-domain To (edge)

```text
From: Alice <alice@a.com>
To: a@example.com, b@example.com
```

Parties: **Alice only**. Multi local To are not external peers.

---

## Test hooks

- Unit: `test/forward_headers.test.js`, `test/reply_tokens.test.js`  
- Live: send S2-style mail → Show original → check `X-CFEG-Parties`
