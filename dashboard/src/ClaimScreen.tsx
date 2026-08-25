/**
 * Claiming a number.
 *
 * Three outcomes that docs/07 requires to feel like one flow. The hard one is
 * the third: the number belongs to another project, so a real person has been
 * messaged and is deciding. A developer who reads that as a system fault will
 * retry, and every retry messages that person again — which is why the API
 * rate-limits claims per environment and why this screen says plainly that the
 * wait is human.
 */
import { useRef, useState } from "react";

import { api, ApiError, type ClaimResult } from "./api";
import { Qr } from "./Qr";

interface Props {
  apiKey: string;
  onClaimed: () => void;
}

export function ClaimScreen({ apiKey, onClaimed }: Props) {
  const [msisdn, setMsisdn] = useState("");
  const [alias, setAlias] = useState("");
  const [result, setResult] = useState<ClaimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Two guards, because they catch different things: the counter drops a
  // superseded submission, and the ref catches the key changing underneath one.
  const generation = useRef(0);
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Captured before awaiting, and checked after. A claim started under one
    // key can resolve after the console has connected with another: the
    // continuation would then call onClaimed(), which reloads using the key
    // this closure captured — showing one project's data under another
    // project's credential.
    const startedWith = apiKey;
    const mine = ++generation.current;
    const current = () => generation.current === mine && startedWith === apiKeyRef.current;

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const claimed = await api.claim(startedWith, msisdn, alias);
      if (!current()) return;
      setResult(claimed);
      onClaimed();
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError
          ? `${err.message}${err.detail === null ? "" : ` — ${err.detail}`}`
          : "could not reach the API",
      );
    } finally {
      if (current()) setBusy(false);
    }
  }

  return (
    <section aria-labelledby="claim">
      <h2 id="claim">Claim a number</h2>

      <form onSubmit={submit}>
        <label htmlFor="msisdn">Phone number</label>
        <input
          id="msisdn"
          value={msisdn}
          onChange={(e) => setMsisdn(e.target.value)}
          placeholder="+628123456789"
          required
        />

        <label htmlFor="alias">Alias</label>
        <input
          id="alias"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="otp-sender"
          required
        />

        <button type="submit" disabled={busy}>
          {busy ? "claiming…" : "claim"}
        </button>
      </form>

      {error !== null && <p role="alert">{error}</p>}

      {result !== null && <Outcome result={result} />}
    </section>
  );
}

/** The three outcomes, each said in the terms the reader needs. */
function Outcome({ result }: { result: ClaimResult }) {
  if (result.outcome === "active") {
    return (
      <div role="status">
        <h3>Already yours</h3>
        <p>
          Active as <strong>{result.virtualDevice.alias}</strong>. Nothing to do.
        </p>
      </div>
    );
  }

  if (result.outcome === "awaiting_confirmation") {
    return (
      <div role="status">
        <h3>Used by another project</h3>
        {/* Deliberately says who is waited on. "Pending" would read as a
            queue, and the developer would retry — messaging that person
            again. */}
        <p>
          {result.message ??
            "The phone holder has been asked to confirm. They reply on WhatsApp."}
        </p>
        <p>This waits on a person, not on us. There is nothing to retry.</p>
      </div>
    );
  }

  const pairing = result.pairing;
  return (
    <div role="status">
      <h3>New number</h3>
      {pairing === undefined ? (
        <p>Pairing is starting.</p>
      ) : (
        <>
          {pairing.qr !== undefined && (
            <figure>
              {/* Drawn in the browser from the payload. Rendering it server-side
                  would mean the payload travelling as an image URL, and it is a
                  pairing credential — it would land in access logs, proxy caches
                  and history. It arrives once in this JSON response instead. */}
              <Qr payload={pairing.qr} />
              <figcaption>Scan this in WhatsApp → Linked devices.</figcaption>
            </figure>
          )}
          {pairing.pairCode !== undefined && (
            <p>
              Or enter code <strong>{pairing.pairCode}</strong>
            </p>
          )}
          <p>
            Expires <time dateTime={pairing.expiresAt}>{pairing.expiresAt}</time>
          </p>
        </>
      )}
    </div>
  );
}
