declare const ROOM_ID_BRAND: unique symbol;

/** canonical 且不可重用的房間 instance 身分。 */
export type RoomId = string & { readonly [ROOM_ID_BRAND]: true };

/** 小寫 UUID v4：以標準文字格式表示 122 bit Web Crypto 隨機值。 */
export const ROOM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 僅在不受信任值已是 canonical RoomId 格式時加以轉換。 */
export function parseRoomId(value: unknown): RoomId | null {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value) ? (value as RoomId) : null;
}

/** 由平台密碼學 UUID 來源產生全新房間 instance 身分。 */
export function generateRoomId(
  randomUUID: () => string = () => globalThis.crypto.randomUUID(),
): RoomId {
  const id = parseRoomId(randomUUID());
  if (id === null) throw new TypeError('randomUUID returned a non-canonical UUID v4');
  return id;
}

/** 在不削弱 canonical 身分的情況下，重試機率可忽略的作用中房間碰撞。 */
export async function createUniqueRoomId(
  checkRoomExists: (roomId: RoomId) => Promise<boolean>,
  generate: () => RoomId = generateRoomId,
): Promise<RoomId> {
  for (;;) {
    const roomId = generate();
    if (!(await checkRoomExists(roomId))) return roomId;
  }
}
