# 13 — Owning the data

**Status:** plan · 2026-08-27 · supersedes the "no chat storage" rows in
[02](02-requirements.md)

## Why this reverses an earlier decision

[02](02-requirements.md) ruled out chat storage with a good argument:

> Chat history storage and search — gowa spends 3.9k lines on this. bunwa is a
> proxy; the projects own their data and already have databases.

That held **while gowa was the engine**. gowa kept the session, the Signal
keys, and whatever history it chose to; bunwa could stay a control plane
because something else was the system of record.

Stage 4 removes gowa. Nothing else is holding any of it. "The projects own
their data" stops being a boundary and becomes a gap: a Baileys socket needs
credentials to exist at all, needs Signal session state to decrypt anything,
and receives inbound messages whether or not we have somewhere to put them.

So the decision is not "add a feature". It is that **owning the engine means
owning its state**, and the only question left is where it goes.

## What has to be stored, and what each thing costs if lost

| Data | Volume | Lost means |
| --- | --- | --- |
| `creds` | one blob per device, rewritten often | the device is unrecoverable; the customer re-pairs |
| Signal keys | thousands per device, constant churn | cannot decrypt; effectively unrecoverable |
| Chat history | unbounded, grows for ever | history is gone, the account still works |

The first two are the highest-consequence data in the system. The third is the
largest. They deserve different treatment, and the current file-based store
gets all three wrong at once.

## What is wrong with `useMultiFileAuthState`

Measured, not assumed — one file per key:

```
creds.json
pre-key-1.json  pre-key-2.json  …
session-628111@s.whatsapp.net.json
sender-key-group-1.json
app-state-sync-key-k1.json
```

1. **Plaintext.** `creds.json` carries `noiseKey`, `signedIdentityKey`,
   `signedPreKey` and `advSecretKey`. Anyone who reads it owns the WhatsApp
   account.
2. **Phone numbers in filenames.** One `session-<msisdn>@s.whatsapp.net.json`
   per contact. For an OTP sender that is one file per recipient, so the
   recipient list is reconstructable from a directory listing — and leaks into
   backups, log lines and any `ls`. For this product specifically that is the
   worst available shape.
3. **No transaction with anything else.** The backup story in
   [ADR-0005](adr/0005-postgres-over-sqlite.md) covers the database. A
   credentials directory beside it can be captured mid-write, and a backup
   whose credentials do not match its rows is not a restore point.

## The design

### Credentials and Signal keys

Baileys requires only `{ creds, keys: { get, set, clear? } }`, and `get` takes
**known ids** — it never enumerates. That single fact makes the privacy fix
cheap: store `sha256(id)` rather than the id, and exact lookup still works
while no phone number is ever written down.

```
device_credentials(device_id PK, ciphertext, iv, updated_at)
device_signal_keys(device_id, key_type, key_hash, ciphertext, iv, updated_at,
                   PRIMARY KEY (device_id, key_type, key_hash))
```

- **AES-256-GCM**, key from `CREDENTIAL_ENCRYPTION_KEY`. Refuse to start in
  production without it rather than silently writing plaintext — a secret that
  is optional is a secret that is absent in the deployment that matters.
- Same database, so `VACUUM INTO` already captures credentials and rows
  together and a restore is internally consistent.
- `clear()` deletes by `device_id`, which is also what `purge()` needs.

### Chat history

Distinct from `outbound_messages`, which records *what a tenant asked us to
send* and is part of the delivery contract. History is what the account
actually saw, inbound and outbound, and it is the unbounded one.

```
chat_threads(id PK, device_id, peer_jid, display_name, last_message_at,
             unread_count, UNIQUE (device_id, peer_jid))
chat_messages(id PK, thread_id, device_id, direction, provider_message_id,
              kind, body, media_id, status, occurred_at)
chat_media(id PK, device_id, mime_type, byte_size, sha256, storage_path)
```

- Scoped by `device_id`, and every query joins to the environment that owns the
  device — the tenancy rule the store path instructions already enforce.
- Media on disk, referenced by row. Base64 in SQLite would bloat every backup
  with data that never changes.
- **Retention is required, not optional.** This is the first unbounded table in
  the system; without a sweep it is the disk filling, which
  [02](02-requirements.md) already names as an outage.

### What this changes about the product

bunwa stops being only a proxy. It becomes the system of record for message
history, which means it inherits obligations it did not have: retention
policy, deletion on request, and the fact that a tenant reading another
tenant's history is now a possible bug rather than an impossible one.

## Sequence

1. Encryption helper, with the config refusing production without a key.
2. `SqliteAuthState` implementing Baileys' contract; the port takes it instead
   of `useMultiFileAuthState`.
3. Chat schema and stores.
4. The adapter, storing inbound messages as they arrive.
5. Dashboard: device management, then threads and composer.
6. Retention sweep in housekeeping, wired in the same commit as the tables.

Step 6 is listed last and must not be deferred past step 3. Three sweeps
shipped with no caller in stage 2, and a fourth would be the same mistake with
a bigger table behind it.
