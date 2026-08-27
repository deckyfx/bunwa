# bunwa documentation

Planning and design documents for **bunwa** — a multi-tenant WhatsApp proxy /
control plane, inspired by [gowa][gowa] but solving a problem gowa was never
designed for: **many projects sharing many devices**. bunwa was built in front
of gowa and then replaced it; the engine is [Baileys][baileys], in-process,
since stage 4.

## Read in this order

| # | Document | What it answers |
| --- | --- | --- |
| 00 | [Assessment](00-assessment.md) | Is this worth building? What already exists? What should we *not* build? |
| 01 | [How gowa works](01-gowa-architecture.md) | Stage 1 study notes: gowa's architecture, and exactly where its limits are |
| 02 | [Requirements](02-requirements.md) | What bunwa must do, and explicitly must not |
| 03 | [Architecture](03-architecture.md) | Target design: control plane, engine adapters, blast radius |
| 04 | [Data model](04-data-model.md) | Projects, owners, devices, links, consent |
| 05 | [Events and rules](05-events-and-rules.md) | Lifecycle events, normalised event bus, the trigger engine |
| 06 | [API design](06-api-design.md) | HTTP surface, auth, gowa compatibility |
| 07 | [Console](07-dashboard.md) | Stage 3 frontend plan, and what the build actually did |
| 08 | [Roadmap](08-roadmap.md) | Stages, milestones, exit criteria |
| 09 | [Option: Baileys as base SDK](09-baileys-option.md) | Should we rebuild gowa on Baileys? What would it actually cost? |
| 10 | [Single container, Unix socket](10-single-container.md) | Can bunwa and gowa share one container over a socket file? **Moot since stage 4** — kept for the Bun transport measurements |
| 11 | [Engine decision](11-engine-decision.md) | **gowa or Baileys?** Re-decided against the narrowed v1 scope. |
| 12 | [Stage 0 findings](12-stage0-findings.md) | Measured facts, and corrections to assumptions made above. **Living document.** |
| 13 | [Owning the data](13-owning-the-data.md) | What removing gowa made bunwa responsible for: credentials, Signal keys, history |

Documents 00, 01, 09, 10, 11 and 12 study a dependency that stage 4 removed.
They are kept rather than deleted because most of what they contain is not
documentation *of* gowa but the evidence for decisions that still stand — the
203-second blind window in [12](12-stage0-findings.md) is why a send is
confirmed by an ack rather than by the engine accepting it, and deleting the
measurement would leave that design looking arbitrary. Where such a document
now describes something that no longer exists, it says so at the top.

Those documents — and [02](02-requirements.md), [05](05-events-and-rules.md),
[ADR-0003](adr/0003-process-isolation.md) and
[ADR-0004](adr/0004-durable-delivery.md) — cite `reference/gowa/…`, a read-only
clone of upstream that was never committed and no longer exists locally either.
Every such link is dead. Read the paths as citations into [gowa's
repository][gowa], at `main` @ `0427b9f`, which is the revision every
measurement here was taken against. They are left as paths rather than rewritten
into URLs because the path is the citation and a rewritten link would be
asserting that a line number still means what it meant.

Architecture decisions with lasting consequences live in [adr/](adr/).

## Vocabulary

These words are used precisely throughout. Getting them confused is the fastest
way to design the wrong thing.

| Term | Meaning |
| --- | --- |
| **Device** | One WhatsApp identity — a phone number and its paired session. **System-owned and global**; belongs to no project. |
| **Phone holder** | The human whose phone it is. Not a bunwa user; consents by replying to a WhatsApp challenge. |
| **Project** | A tenant application (`grande`). Has a customer-facing display name. |
| **Environment** | `development` · `staging` · `production` within a project. Owns the API keys, webhook and settings. |
| **Virtual Device** | An Environment ↔ Device binding, with its own alias, scopes and filters. **This is bunwa's reason to exist.** |
| **Consent** | Granted per (Device, Project); every environment of that project inherits it. |
| **Engine** | The component that actually holds a WhatsApp socket. Replaceable behind `DeviceEngine`: gowa was engine #1, Baileys is the engine now. |
| **Control plane** | bunwa itself — tenancy, consent, routing, rules, delivery. |
| **Data plane** | The engines. Holds sockets, knows nothing about projects. Since stage 4 it is in the same process, which is what [ADR-0003](adr/0003-process-isolation.md) is about. |

[gowa]: https://github.com/aldinokemal/go-whatsapp-web-multidevice
[baileys]: https://github.com/WhiskeySockets/Baileys
