/**
 * Suggesting an instance name.
 *
 * The field has no obviously right answer and an operator staring at an empty
 * box on first run has to invent one — which is how every install ends up
 * called "test" or "bunwa" and shows up indistinguishable from the next one in
 * WhatsApp's linked devices list. A suggestion is not a default: it fills the
 * box so there is something to edit rather than something to compose.
 *
 * Derived from the address the console is being served on, because that is the
 * one fact the browser has that actually identifies this deployment. When the
 * address says nothing useful — localhost, a bare IP — a short random suffix
 * keeps two installs on one machine from colliding, which is exactly the case
 * where telling them apart matters.
 */

/** Kept in step with the server's normaliser; the server normalises again anyway. */
function normalise(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

/** Addresses that identify a machine but not a deployment. */
const ANONYMOUS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", ""]);

/** Four characters of randomness. Enough to separate two installs, short enough to read. */
function suffix(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/**
 * A name to put in the box, ready to be edited.
 *
 * Always returns something usable: the field's whole purpose is defeated by a
 * suggestion that fails validation.
 */
export function suggestInstanceName(hostname = typeof window === "undefined" ? "" : window.location.hostname): string {
  const host = hostname.toLowerCase();

  if (!ANONYMOUS.has(host) && !/^\d+(\.\d+){3}$/.test(host)) {
    // The first label only: "wa.grande.example.com" is a deployment called
    // "wa" at a company whose name is on every other install too, and the
    // whole string does not fit in the 24 characters WhatsApp will show.
    const label = normalise(host.split(".")[0] ?? "");
    if (label !== "" && label.length <= 24) return label;
  }

  return `bunwa-${suffix()}`;
}
