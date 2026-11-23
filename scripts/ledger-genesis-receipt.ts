export const GENESIS_DATABASE_NAME = 'open4wd-ledger' as const;
export const GENESIS_DATABASE_TYPE = 'events' as const;
export const GENESIS_ACCESS_CONTROLLER =
  'open4wd-ledger/open4wd-ledger-admission-v1/write-any/v1' as const;

export interface GenesisReceiptInitialCheckpointProof {
  readonly commitment: string;
  readonly sourceLedgerAddress: string;
  readonly sourceCheckpointCid: string;
  readonly initialStateCid: string;
  readonly sourceCheckpointTimestamp: number;
}

export interface GenesisReceipt {
  readonly version: 1;
  readonly ledgerAddress: string;
  readonly databaseName: typeof GENESIS_DATABASE_NAME;
  readonly databaseType: typeof GENESIS_DATABASE_TYPE;
  readonly accessController: typeof GENESIS_ACCESS_CONTROLLER;
  readonly genesisPeerId: string;
  readonly governanceSigners: readonly string[];
  readonly genesisTimestamp: number;
  readonly genesisMode: 'ordinary' | 'rebirth';
  readonly initialCheckpointProof: GenesisReceiptInitialCheckpointProof | null;
  readonly createdAt: string;
  readonly releaseCommit: string;
}

export function serializeGenesisReceipt<T extends GenesisReceipt>(receipt: T): string {
  const publicReceipt: GenesisReceipt = {
    version: 1,
    ledgerAddress: receipt.ledgerAddress,
    databaseName: GENESIS_DATABASE_NAME,
    databaseType: GENESIS_DATABASE_TYPE,
    accessController: GENESIS_ACCESS_CONTROLLER,
    genesisPeerId: receipt.genesisPeerId,
    governanceSigners: [...receipt.governanceSigners].sort(),
    genesisTimestamp: receipt.genesisTimestamp,
    genesisMode: receipt.genesisMode,
    initialCheckpointProof: receipt.initialCheckpointProof,
    createdAt: receipt.createdAt,
    releaseCommit: receipt.releaseCommit,
  };
  return `${JSON.stringify(publicReceipt, null, 2)}\n`;
}
