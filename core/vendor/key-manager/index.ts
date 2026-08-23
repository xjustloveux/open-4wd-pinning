/**
 * key-manager — 助記詞／Ed25519 身分／簽章／PIN 加密儲存／SignedPayload
 */
export {
  Open4wdKeyManager,
  type Open4wdKeyManagerOptions,
  type ProfileDeletionContext,
  type ProfileDeletionFinalizer,
} from './key-manager';
export { generateMnemonic, mnemonicToSeed, validateMnemonic } from './mnemonic';
export {
  deriveKeyPair,
  peerIdToPublicKey,
  publicKeyToPeerId,
  signMessage,
  verifyMessage,
} from './ed25519';
export {
  DEFAULT_ARGON2,
  decryptSeed,
  encryptSeed,
  type Argon2Params,
  type EncryptedSeed,
} from './seed-crypto';
export {
  IndexedDbProfileStore,
  MemoryProfileStore,
  type ProfileStore,
  type StoredProfile,
  type StoredIdentityContainer,
} from './profile-store';
export type { SealedIdentityDomain } from './identity-domain-crypto';
export {
  IdentityContainerWorkspace,
  type IdentityDomainDecoder,
} from './identity-container-workspace';
export { PIN_LOCK_DURATION_MS, PIN_MAX_ATTEMPTS } from './pin-guard';
export { buildSignedMessage, verifySignedPayload } from './signed-payload';
export {
  IDENTITY_LOCK_EPOCH_KEY,
  IDENTITY_SESSION_CHANNEL,
  IdentitySessionCoordinator,
  makeBrowserIdentitySessionCoordinator,
  type IdentitySessionBroadcastChannel,
  type IdentitySessionCoordinatorOptions,
  type IdentitySessionEventSource,
  type IdentitySessionStorage,
} from './identity-session-coordinator';
