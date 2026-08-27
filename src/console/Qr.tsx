/**
 * A scannable QR, rendered in the browser from the engine's payload.
 *
 * The engine hands back the string WhatsApp encodes, not an image. Showing the
 * payload verbatim — which is what this replaced — is honest but unusable: a
 * developer cannot scan text with their phone, so pairing could not actually be
 * completed from the console, which is half of stage 3's exit criteria.
 *
 * Drawn here rather than by the server on purpose. A QR generated server-side
 * would have to travel as an image, and the payload is a pairing credential:
 * putting it through an image endpoint means it appears in access logs, proxy
 * caches and browser history. It arrives once over the authenticated JSON
 * response and never becomes a URL.
 */

/**
 * A library, not a hand-rolled encoder.
 *
 * QR needs Reed-Solomon error correction and mask selection, and a subtly
 * wrong implementation produces a code that scans to garbage — which is worse
 * than one that visibly fails, because the developer blames the pairing rather
 * than the drawing. qrcode-generator has no dependencies and returns the module
 * matrix directly, so rendering stays here where the payload never becomes a
 * URL.
 */
import qrcode from "qrcode-generator";

interface Props {
  payload: string;
  /** Pixels per module. 6 keeps a version-10 code inside a laptop viewport. */
  scale?: number;
}

export function Qr({ payload, scale = 6 }: Props) {
  let modules: boolean[][];
  try {
    // Type 0 lets the library choose the smallest version that fits. "L" is
    // the right correction level for a screen: the code is not being printed
    // on a box that might get scuffed.
    const qr = qrcode(0, "L");
    qr.addData(payload);
    qr.make();
    const count = qr.getModuleCount();
    modules = Array.from({ length: count }, (_, y) =>
      Array.from({ length: count }, (_, x) => qr.isDark(y, x)),
    );
  } catch {
    // A payload too long for the encoder must not blank the screen. The code
    // is unusable either way, but the developer needs to see that rather than
    // an empty box, and the raw payload still pairs by hand.
    return (
      <div role="status">
        <p>Could not draw this code.</p>
        <pre aria-label="QR payload">{payload}</pre>
      </div>
    );
  }

  const size = modules.length;
  // A quiet zone is part of the spec, not decoration: scanners need the margin
  // to find the code at all.
  const quiet = 4;
  const side = (size + quiet * 2) * scale;

  return (
    <svg
      width={side}
      height={side}
      viewBox={`0 0 ${size + quiet * 2} ${size + quiet * 2}`}
      role="img"
      aria-label="Pairing QR code"
      shapeRendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="#fff" />
      {modules.map((row, y) =>
        row.map((on, x) =>
          on ? <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#000" /> : null,
        ),
      )}
    </svg>
  );
}
