/**
 * GhostWire — génération de QR code (SVG) pour importer la config
 * dans l'app mobile WireGuard. Wrappe le paquet `qrcode`.
 */
import QRCode from 'qrcode';

/** Rend un QR code au format SVG (string) à partir d'un texte. */
export async function renderQrSvg(text) {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'L',
    margin: 1,
    width: 320,
  });
}
