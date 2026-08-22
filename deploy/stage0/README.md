# Stage 0 harness

Answers the four open questions in [docs/01](../../docs/01-gowa-architecture.md)
and [docs/08](../../docs/08-roadmap.md) with measurements instead of guesses.
**No fork of gowa is involved** — this runs the published image unmodified,
which is the v1 engine decision ([ADR-0007](../../docs/adr/0007-gowa-engine-for-v1.md)).

## What each tool establishes

| Tool | Question it answers |
| --- | --- |
| `sink.ts` | Which events gowa actually delivers by webhook — and confirms no lifecycle event ever does |
| `wstap.ts` | What `/ws` broadcasts, and whether it is a viable lifecycle source. **Prototype of the stage 1 adapter bridge.** |
| `measure.ts` | Memory and file descriptors per connected device → engine pool size, container density |
| `drop.ts` | How long whatsmeow takes to notice a dead socket, and to recover → floor on `device.disconnected` latency |

## Run it

Four terminals. The sink must be up before gowa, or the first webhooks are lost.

```bash
# 1 — webhook sink
bun run stage0:sink

# 2 — gowa
docker compose -f deploy/stage0/docker-compose.yml up -d
docker compose -f deploy/stage0/docker-compose.yml logs -f

# 3 — /ws tap
bun run stage0:ws

# 4 — resource sampling
bun run stage0:measure
```

Then open <http://127.0.0.1:3000> and pair a device.

## The measurement sequence

1. **Baseline.** Let `measure.ts` run for two minutes with zero devices. This is
   the fixed cost of the process, and it is **required**: the `MiB/device`
   column anchors on the first sample with no device connected. Start the
   sampler before pairing, or it has nothing to subtract and reports `—` for
   the whole run.
2. **Pair one device.** Watch `wstap.ts` — `QRDATA` then `LOGIN_SUCCESS` should
   appear. Watch `sink.ts` — nothing lifecycle-related should arrive. That
   contrast *is* the finding.
3. **Idle for ten minutes.** Establishes steady-state memory for one device.
4. **Send and receive.** Text, image, PDF, link-with-preview, audio, video — the
   six v1 types. Confirm each produces a `message` webhook at the sink.
5. **Call the paired number.** It must ring the phone normally, and gowa must
   neither answer nor reject (requirement F4b). `call.offer` should appear at the
   sink; nothing else should happen.
6. **Add devices.** Pair a second and third if numbers are available; the
   `MiB/device` column becomes meaningful from the second onward.
7. **Drop test.** `bun run stage0:drop -- --outage 60`.
8. **Remote logout.** Unlink from the phone. `DEVICE_LOGGED_OUT` should appear
   in the tap and **not** at the sink.

## Output

Everything lands in `deploy/stage0/data/` as JSONL, git-ignored:

| File | Contents |
| --- | --- |
| `webhooks.jsonl` | Every **correctly signed** webhook |
| `webhooks-rejected.jsonl` | Posts whose HMAC did not verify, quarantined so they cannot skew a measurement |
| `ws.jsonl` | Every `/ws` broadcast |
| `metrics.jsonl` | Memory, fds, pids, device counts over time |
| `drop.jsonl` | Detection and recovery latency |
| `storages/` | gowa's own SQLite state — **contains WhatsApp session credentials** |

`data/` is git-ignored in full. Treat `storages/` as a secret: it is enough to
impersonate the paired device.

## Notes

- `Ctrl-C` on `sink.ts` and `wstap.ts` prints a summary of what was observed.
- Basic auth is off (`APP_BASIC_AUTH=` empty) so `/ws` needs no credentials. With
  it set, gowa accepts `?authorization=base64(user:pass)` on the WebSocket.
- gowa binds to `127.0.0.1:3000` only — it is not reachable off this machine.
