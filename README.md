# bunwa

A Bun/TypeScript rewrite of [gowa](https://github.com/aldinokemal/go-whatsapp-web-multidevice) — a WhatsApp Web multi-device HTTP API — plus features the original does not have.

> Side project. Early stage, nothing works yet.

## Status

| Stage | State |
| --- | --- |
| Project scaffold | ✅ |
| WhatsApp connection | ⏳ |
| REST API | ⏳ |
| Webhooks | ⏳ |
| Web UI | ⏳ |

## Requirements

- [Bun](https://bun.sh) 1.4+

## Getting started

```bash
bun install
bun run dev
```

## Upstream reference

The original Go implementation is cloned into `reference/gowa` for reading only. It is
git-ignored, excluded from `tsconfig.json`, marked read-only in VS Code, and mounted as a
second folder in `bunwa.code-workspace`.

```bash
bun run reference:update   # re-clone / fast-forward to upstream main
```

## Scripts

| Script | Description |
| --- | --- |
| `bun run dev` | Run the app in watch mode |
| `bun run start` | Run the app once |
| `bun run typecheck` | Type-check without emitting |
| `bun run reference:update` | Refresh the gowa reference clone |

## Licence

MIT
