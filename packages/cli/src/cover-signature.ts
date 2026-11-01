export const JPEG_SIGNATURE = Buffer.from([255, 216, 255]);
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function coverExtensionFromHeader(header: Buffer): "jpg" | "png" | null {
  if (header.subarray(0, 3).equals(JPEG_SIGNATURE)) return "jpg";
  if (header.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  return null;
}
