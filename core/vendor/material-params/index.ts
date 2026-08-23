/**
 * material-params — 31 種統一材質物理參數與使用規則
 */
export {
  MATERIALS,
  MATERIAL_BY_ID,
  assertMaterialInvariants,
  type MaterialDef,
  type PartType,
} from './materials';
export {
  isMaterialAllowed,
  materialClass,
  materialsForScope,
  type MaterialClass,
  type MaterialScope,
} from './material-rules';
export {
  materialDescription,
  materialDescriptionKey,
  materialLabel,
  materialName,
  materialNameKey,
  type MaterialTextResolver,
} from './material-i18n';
