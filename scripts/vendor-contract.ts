export const PINNED_PACKAGES = [
  '@orbitdb/core',
  'libp2p',
  'helia',
  '@helia/libp2p',
  '@helia/bitswap',
  'multiformats',
  '@ipld/dag-cbor',
  '@noble/hashes',
  '@noble/curves',
  '@scure/base',
  '@scure/bip39',
  '@libp2p/crypto',
  '@libp2p/peer-id',
  '@libp2p/bootstrap',
  '@libp2p/circuit-relay-v2',
  '@libp2p/gossipsub',
  '@libp2p/identify',
  '@libp2p/kad-dht',
  '@libp2p/memory',
  '@libp2p/ping',
  '@libp2p/websockets',
  '@libp2p/webrtc',
  '@chainsafe/libp2p-noise',
  '@chainsafe/libp2p-yamux',
  '@multiformats/multiaddr',
] as const;

export const normalizeSemanticVersion = (value: string | undefined): string | undefined =>
  value?.replace(/^[\^~]/, '');

export interface VendorManifestEntry {
  path: string;
  upstream: string;
  sha256: string;
}

export interface VendorManifest {
  schemaVersion: 1;
  upstreamRepo: 'xjustloveux/open-4wd';
  semanticPackages: Record<string, string>;
  files: VendorManifestEntry[];
}
