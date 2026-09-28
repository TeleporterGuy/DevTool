import QRCode from 'qrcode'

/**
 * Renders a pairing URI as a QR code image (data URL), or resolves null if
 * encoding fails — Settings then still shows the link with a Copy action, which
 * the phone app accepts through "Paste pairing link".
 */
export async function renderPairingQr(uri: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
  } catch {
    return null
  }
}
