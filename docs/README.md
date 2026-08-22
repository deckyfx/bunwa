# bunwa documentation

Planning and design documents for **bunwa** — a multi-tenant WhatsApp proxy /
control plane, inspired by [gowa][gowa] but solving a problem gowa was never
designed for: **many projects sharing many devices**.

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
| 07 | [Dashboard](07-dashboard.md) | Stage 3 frontend plan |
| 08 | [Roadmap](08-roadmap.md) | Stages, milestones, exit criteria |
| 09 | [Option: Baileys as base SDK](09-baileys-option.md) | Should we rebuild gowa on Baileys? What would it actually cost? |
| 10 | [Single container, Unix socket](10-single-container.md) | Can bunwa and gowa share one container over a socket file? |
| 11 | [Engine decision](11-engine-decision.md) | **gowa or Baileys?** Re-decided against the narrowed v1 scope. |
| 12 | [Stage 0 findings](12-stage0-findings.md) | Measured facts, and corrections to assumptions made above. **Living document.** |

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
| **Engine** | The component that actually holds a WhatsApp socket. Replaceable: gowa today, native Bun later. |
| **Control plane** | bunwa itself — tenancy, consent, routing, rules, delivery. Holds no WhatsApp socket. |
| **Data plane** | The engines. Holds sockets, knows nothing about projects. |

[gowa]: https://github.com/aldinokemal/go-whatsapp-web-multidevice
