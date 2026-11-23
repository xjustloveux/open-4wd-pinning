/** Editor 與 admission 共用的 canonical 可變 UGC presentation metadata。 */
export interface UgcPresentationMetadata {
  name?: string;
  description?: string;
  tags?: readonly string[];
}

const encoder = new TextEncoder();
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

function canonicalText(value: unknown, maxBytes: number, maxCodePoints?: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.normalize('NFC') === value &&
    !CONTROL_OR_FORMAT.test(value) &&
    encoder.encode(value).byteLength <= maxBytes &&
    (maxCodePoints === undefined || Array.from(value).length <= maxCodePoints)
  );
}

/** 簽署前與 ledger admission 都會執行的 exact-shape validator。 */
export function validateUgcPresentationMetadata(value: unknown): value is UgcPresentationMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['name', 'description', 'tags'].includes(key)))
    return false;
  if (Object.hasOwn(input, 'name') && !canonicalText(input['name'], 256)) return false;
  if (Object.hasOwn(input, 'description') && !canonicalText(input['description'], 2_000, 500))
    return false;
  if (Object.hasOwn(input, 'tags')) {
    if (!Array.isArray(input['tags']) || input['tags'].length > 32) return false;
    if (!input['tags'].every((tag) => canonicalText(tag, 64))) return false;
  }
  return true;
}
