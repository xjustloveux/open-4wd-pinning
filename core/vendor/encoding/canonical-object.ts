/** 以 Unicode code unit 的穩定順序比較協定文字。 */
export const compareCanonicalText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** 驗證物件恰好包含指定 keys，不接受缺漏或額外欄位。 */
export function hasExactCanonicalKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const expected = [...keys].sort(compareCanonicalText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
