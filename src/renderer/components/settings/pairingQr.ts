/**
 * Renders a pairing URI as a QR code image (data URL), or resolves null when no
 * QR renderer is available — Settings then shows the link with a Copy action,
 * which the phone app accepts through "Paste pairing link".
 *
 * Meant to use the `qrcode` package once it is installed:
 *   import QRCode from 'qrcode'
 *   return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
 */
export async function renderPairingQr(_uri: string): Promise<string | null> {
  return null
}
