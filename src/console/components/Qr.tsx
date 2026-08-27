/**
 * A scannable QR.
 *
 * Rendered rather than shown as text: the payload the engine returns is a
 * WhatsApp pairing credential, and an operator cannot scan a string. The
 * console displayed the raw payload for one commit, which made the claim flow
 * look complete while being unusable.
 */
import qrcode from "qrcode-generator";

/** Error correction level L. The payload is short and the screen is close. */
export function Qr({ payload, size = 232 }: { payload: string; size?: number }) {
  const qr = qrcode(0, "L");
  qr.addData(payload);
  qr.make();

  const cells = qr.getModuleCount();
  const scale = size / cells;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(cells)} ${String(cells)}`}
      role="img"
      aria-label="Pairing QR code"
      className="rounded-lg bg-white p-2 shadow-sm ring-1 ring-slate-200"
    >
      {/* A white ground under the modules: a transparent QR over a dark theme
          is unscannable, and the console follows the operating system. */}
      <rect width={cells} height={cells} fill="#fff" />
      {Array.from({ length: cells }, (_, row) =>
        Array.from({ length: cells }, (_, col) =>
          qr.isDark(row, col) ? (
            <rect key={`${String(row)}-${String(col)}`} x={col} y={row} width={1} height={1} fill="#0f172a" />
          ) : null,
        ),
      )}
      <desc>{`Scale ${String(Math.round(scale))} px per module`}</desc>
    </svg>
  );
}
