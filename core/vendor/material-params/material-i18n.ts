import type { MaterialId } from '@open4wd/interfaces';

/** 材質 resolver 只依賴框架中立翻譯埠。 */
export interface MaterialTextResolver {
  t(key: string): string;
}

/** 取得指定材質的名稱翻譯鍵。 */
export function materialNameKey(id: MaterialId): `materials.${MaterialId}.name` {
  return `materials.${id}.name`;
}

/** 取得指定材質的玩法說明翻譯鍵。 */
export function materialDescriptionKey(id: MaterialId): `materials.${MaterialId}.description` {
  return `materials.${id}.description`;
}

/** 解析指定材質的本地化名稱。 */
export function materialName(i18n: MaterialTextResolver, id: MaterialId): string {
  return i18n.t(materialNameKey(id));
}

/** 解析指定材質的本地化玩法說明。 */
export function materialDescription(i18n: MaterialTextResolver, id: MaterialId): string {
  return i18n.t(materialDescriptionKey(id));
}

/** 組合下拉選單顯示字串，保留 canonical id 供作者核對。 */
export function materialLabel(i18n: MaterialTextResolver, id: MaterialId): string {
  return `${materialName(i18n, id)} (${id}) — ${materialDescription(i18n, id)}`;
}
