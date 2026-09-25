import { createHash } from 'node:crypto';
import {
  address,
  getAddressDecoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import {
  atomic,
  decodeClassicTokenAccount,
  decodeTenancy,
  deriveEscrowAddresses,
  observeSolanaSignature,
  resolveSolanaManifest,
  SOLANA_IDS,
  SOLANA_MAINNET_MANIFEST,
  validateKaminoAccounts,
  validateMintObservation,
  type AccountObservation,
  type DeploymentManifest,
  type ExpectedTokenDelta,
  type TenancyAccount,
} from '../finance/solana/index.ts';

export type SolanaConfiguration = DeploymentManifest & {
  setupMode: 'joint' | 'staged';
  rpcUrl: string;
  agreementId: string;
  tenancyAddress: string;
  programCodeLength: number;
  upgradeAuthority: string | null;
  maximumSponsorLamports: string;
};
export type SolanaSnapshot = {
  tenancy: TenancyAccount;
  slot: string;
  genesisHash: string;
  cashAtomic: string;
  receiptsAtomic: string;
  tenantCashAtomic: string;
  landlordCashAtomic: string;
  receiptValueAtomic: string;
  availableLiquidityAtomic: string;
  requiresRefresh: boolean;
};
export type SolanaSimulation = {
  slot: string;
  sponsorDebitCeilingLamports: string;
  networkFeeLamports: string;
};
export type SolanaGateway = {
  snapshot(): Promise<SolanaSnapshot>;
  lifetime(): Promise<{ blockhash: string; lastValidBlockHeight: string; blockHeight: string }>;
  simulate(bytes: Uint8Array, sponsor: string, actor: string): Promise<SolanaSimulation>;
  broadcast(bytes: Uint8Array): Promise<string>;
  reconcile(
    signature: string,
    messageSha256: string,
    expectedDeltas: readonly ExpectedTokenDelta[],
  ): ReturnType<typeof observeSolanaSignature>;
};
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
const immutableLoader = 'BPFLoader2111111111111111111111111111111111';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('RPC object unavailable');
  return value as Record<string, unknown>;
}
function numeric(value: unknown): string {
  if (typeof value === 'string') {
    atomic(value);
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error('Unsafe RPC integer');
}
function bytes(value: unknown): Uint8Array {
  if (
    !Array.isArray(value) ||
    value[1] !== 'base64' ||
    typeof value[0] !== 'string' ||
    value[0].length > 30_000_000
  )
    throw new Error('RPC base64 unavailable');
  const decoded = Buffer.from(value[0], 'base64');
  if (decoded.toString('base64') !== value[0]) throw new Error('Invalid base64');
  return new Uint8Array(decoded);
}
function account(key: string, value: unknown): AccountObservation & { lamports: string } {
  const row = object(value);
  if (typeof row.owner !== 'string' || typeof row.executable !== 'boolean')
    throw new Error('RPC account unavailable');
  return {
    address: key,
    owner: row.owner,
    executable: row.executable,
    data: bytes(row.data),
    lamports: numeric(row.lamports),
  };
}

export function solanaConfiguration(
  environment: Record<string, string | undefined>,
): SolanaConfiguration | null {
  if (!environment.SOLANA_RPC_URL || !environment.SOLANA_DEPLOYMENT_MANIFEST) return null;
  const candidate = object(JSON.parse(environment.SOLANA_DEPLOYMENT_MANIFEST));
  if (candidate.cluster !== 'devnet' && candidate.cluster !== 'localnet')
    throw new Error('Only localnet/devnet execution is supported');
  if (
    typeof candidate.genesisHash !== 'string' ||
    candidate.genesisHash === SOLANA_MAINNET_MANIFEST.genesisHash
  )
    throw new Error('Mainnet execution is disabled');
  const deployment = candidate as DeploymentManifest;
  if (deployment.escrowVersion !== undefined && deployment.escrowVersion !== 'direct-v1' && deployment.escrowVersion !== 'pull-v2')
    throw new Error('Invalid escrow version');
  if (
    !resolveSolanaManifest({
      cluster: deployment.cluster,
      genesisHash: deployment.genesisHash,
      deployment,
    }).available
  )
    throw new Error('Invalid Solana deployment manifest');
  if (
    typeof candidate.agreementId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(candidate.agreementId) ||
    typeof candidate.tenancyAddress !== 'string'
  )
    throw new Error('Configure an existing accepted agreement and tenancy');
  if (candidate.setupMode !== undefined && candidate.setupMode !== 'joint' && candidate.setupMode !== 'staged')
    throw new Error('Invalid Solana setup mode');
  if (candidate.setupMode === 'staged' && candidate.escrowProgram === 'BiwaGavQUsSsg48UPpRAGWoXSiUnzgvdDs7rd8WizvPD')
    throw new Error('Staged setup requires a separate verified escrow deployment');
  address(candidate.tenancyAddress);
  if (
    !Number.isSafeInteger(candidate.programCodeLength) ||
    Number(candidate.programCodeLength) < 1000 ||
    Number(candidate.programCodeLength) > 2_000_000
  )
    throw new Error('Invalid program code length');
  if (candidate.upgradeAuthority !== null) address(String(candidate.upgradeAuthority));
  const budget = atomic(candidate.maximumSponsorLamports, false);
  if (budget > 10_000_000n) throw new Error('Sponsor ceiling exceeds prototype limit');
  const url = new URL(environment.SOLANA_RPC_URL);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('RPC must use HTTPS or loopback');
  return {
    ...deployment,
    setupMode: candidate.setupMode === 'staged' ? 'staged' : 'joint',
    rpcUrl: url.toString(),
    agreementId: candidate.agreementId,
    tenancyAddress: candidate.tenancyAddress,
    programCodeLength: Number(candidate.programCodeLength),
    upgradeAuthority: candidate.upgradeAuthority as string | null,
    maximumSponsorLamports: budget.toString(),
  };
}

export function verifyDeployedProgram(
  config: SolanaConfiguration,
  program: AccountObservation,
  programData?: AccountObservation,
) {
  if (program.address !== config.escrowProgram || !program.executable)
    throw new Error('Escrow program unavailable');
  let code: Uint8Array;
  if (program.owner === loader) {
    if (
      program.data.length !== 36 ||
      new DataView(program.data.buffer, program.data.byteOffset).getUint32(0, true) !== 2 ||
      !programData ||
      programData.address !== getAddressDecoder().decode(program.data.subarray(4, 36)) ||
      programData.owner !== loader ||
      programData.executable ||
      programData.data.length < 45 + config.programCodeLength
    )
      throw new Error('Invalid upgradeable program accounts');
    const data = programData.data,
      view = new DataView(data.buffer, data.byteOffset);
    if (view.getUint32(0, true) !== 3 || (data[12] !== 0 && data[12] !== 1))
      throw new Error('Invalid program data metadata');
    const authority = data[12] === 0 ? null : getAddressDecoder().decode(data.subarray(13, 45));
    if (authority !== config.upgradeAuthority) throw new Error('Program upgrade authority changed');
    code = data.subarray(45);
  } else if (program.owner === immutableLoader && config.upgradeAuthority === null)
    code = program.data;
  else throw new Error('Unreviewed program loader');
  if (
    code.length < config.programCodeLength ||
    code.subarray(config.programCodeLength).some((byte) => byte !== 0)
  )
    throw new Error('Program code size changed');
  const hash = createHash('sha256')
    .update(code.subarray(0, config.programCodeLength))
    .digest('hex');
  if (hash !== config.programSha256) throw new Error('Program code hash changed');
}

export class RpcSolanaGateway implements SolanaGateway {
  config: SolanaConfiguration;
  fetcher: typeof fetch;
  constructor(config: SolanaConfiguration, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }
  async rpc(method: string, params: unknown[]) {
    let response: Response;
    // Rate-limited requests were not processed; resending identical bytes (even a signed
    // transaction) is idempotent, so a short bounded backoff is safe for every method here.
    for (let attempt = 0; ; attempt++) {
      response = await this.fetcher(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 429 || attempt >= 4) break;
      const hinted = Number(response.headers.get('retry-after'));
      const pause = Promise.withResolvers<void>();
      setTimeout(pause.resolve, Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted, 5) * 1000 : 500 * 2 ** attempt);
      await pause.promise;
    }
    if (!response.ok) throw new Error('RPC unavailable');
    const body = object(await response.json());
    if (body.error || !('result' in body)) throw new Error('RPC request failed');
    return body.result;
  }
  async checkedGenesis() {
    const genesis = await this.rpc('getGenesisHash', []);
    if (genesis !== this.config.genesisHash || genesis === SOLANA_MAINNET_MANIFEST.genesisHash)
      throw new Error('RPC genesis mismatch');
    return String(genesis);
  }
  async multiple(keys: readonly string[]) {
    const result = object(
      await this.rpc('getMultipleAccounts', [
        keys,
        { encoding: 'base64', commitment: 'finalized' },
      ]),
    );
    if (!Array.isArray(result.value) || result.value.length !== keys.length)
      throw new Error('Account observation incomplete');
    return {
      slot: numeric(object(result.context).slot),
      accounts: result.value.map((value, index) =>
        value === null ? null : account(keys[index], value),
      ),
    };
  }
  async snapshot(): Promise<SolanaSnapshot> {
    const c = this.config;
    const genesisHash = await this.checkedGenesis();
    const initial = await this.multiple([c.escrowProgram, c.tenancyAddress]);
    const program = initial.accounts[0];
    if (!program || !initial.accounts[1]) throw new Error('Escrow is not deployed and initialized');
    let programData: AccountObservation | undefined;
    if (program.owner === loader && program.data.length === 36) {
      const key = getAddressDecoder().decode(program.data.subarray(4));
      programData = (await this.multiple([key])).accounts[0] ?? undefined;
    }
    verifyDeployedProgram(c, program, programData);
    const first = decodeTenancy(initial.accounts[1], c);
    const derived = await deriveEscrowAddresses(c.escrowProgram, first.tenant, first.leaseId);
    if (derived.tenancy !== c.tenancyAddress) throw new Error('Wrong tenancy PDA');
    const keys = [
      c.tenancyAddress,
      c.reserve,
      c.market,
      c.liquiditySupply,
      SOLANA_IDS.klend,
      c.depositMint,
      c.receiptMint,
      derived.cash,
      derived.receipts,
      first.tenantDestination,
      first.landlordDestination,
    ];
    const observed = await this.multiple(keys);
    if (observed.accounts.slice(0, 9).some((value) => value === null) ||
      ((c.escrowVersion ?? 'direct-v1') === 'direct-v1' && observed.accounts.slice(9).some((value) => value === null)))
      throw new Error('Required finance account is missing');
    const rows = observed.accounts;
    const tenancy = decodeTenancy(rows[0]!, c);
    for (const [index, mint] of [
      [5, c.depositMint],
      [6, c.receiptMint],
    ] as const) {
      const row = rows[index]!;
      if (row.data.length !== 82) throw new Error('Unreviewed mint layout');
      validateMintObservation(
        {
          address: row.address,
          owner: row.owner,
          decimals: row.data[44],
          initialized: row.data[45] === 1,
          supplyAtomic: new DataView(row.data.buffer, row.data.byteOffset)
            .getBigUint64(36, true)
            .toString(),
        },
        { mint, tokenProgram: SOLANA_IDS.token, decimals: 6 },
      );
    }
    const receiptMint = rows[6]!;
    if (
      new DataView(receiptMint.data.buffer, receiptMint.data.byteOffset).getUint32(0, true) !== 1 ||
      getAddressDecoder().decode(receiptMint.data.subarray(4, 36)) !== c.marketAuthority
    )
      throw new Error('Wrong receipt mint authority');
    const cash = decodeClassicTokenAccount(rows[7]!);
    const receipts = decodeClassicTokenAccount(rows[8]!);
    for (const [token, owner, mint] of [
      [cash, tenancy.address, c.depositMint],
      [receipts, tenancy.address, c.receiptMint],
    ] as const) {
      if (token.authority !== owner || token.mint !== mint || !token.initialized || token.frozen)
        throw new Error('Wrong finance token account');
    }
    const payoutBalance = (row: AccountObservation | null, owner: string) => {
      if (!row) return '0';
      try {
        const token = decodeClassicTokenAccount(row);
        if (token.authority !== owner || token.mint !== c.depositMint || !token.initialized || token.frozen)
          throw new Error('Unavailable payout');
        return token.amountAtomic;
      } catch {
        if ((c.escrowVersion ?? 'direct-v1') === 'direct-v1')
          throw new Error('Wrong finance token account');
        return '0';
      }
    };
    const tenantCashAtomic = payoutBalance(rows[9], tenancy.tenant);
    const landlordCashAtomic = payoutBalance(rows[10], tenancy.landlord);
    if (
      atomic(cash.amountAtomic) < atomic(tenancy.accountedIdleAtomic) ||
      atomic(receipts.amountAtomic) < atomic(tenancy.accountedReceiptsAtomic)
    )
      throw new Error('Escrow balances below ledger');
    if (c.escrowVersion === 'pull-v2' &&
      (tenancy.phase === 'closed'
        ? atomic(tenancy.tenantOwedAtomic) + atomic(tenancy.landlordOwedAtomic) !== atomic(tenancy.accountedIdleAtomic)
        : tenancy.tenantOwedAtomic !== '0' || tenancy.landlordOwedAtomic !== '0'))
      throw new Error('Escrow payout ledger mismatch');
    const lending = await validateKaminoAccounts({
      manifest: c,
      context: { genesisHash, slot: observed.slot, observedAtMs: Date.now() },
      nowMs: Date.now(),
      reserve: rows[1]!,
      market: rows[2]!,
      liquiditySupply: rows[3]!,
      program: rows[4]!,
      trackedReceiptAtomic: tenancy.accountedReceiptsAtomic,
    });
    return {
      tenancy,
      slot: observed.slot,
      genesisHash,
      cashAtomic: cash.amountAtomic,
      receiptsAtomic: receipts.amountAtomic,
      tenantCashAtomic,
      landlordCashAtomic,
      receiptValueAtomic: lending.receiptValueAtomic,
      availableLiquidityAtomic: lending.availableLiquidityAtomic,
      requiresRefresh: lending.requiresRefresh,
    };
  }
  async lifetime() {
    await this.checkedGenesis();
    const [latest, height] = await Promise.all([
      this.rpc('getLatestBlockhash', [{ commitment: 'finalized' }]),
      this.rpc('getBlockHeight', [{ commitment: 'finalized' }]),
    ]);
    const value = object(object(latest).value);
    if (typeof value.blockhash !== 'string') throw new Error('Blockhash unavailable');
    return {
      blockhash: value.blockhash,
      lastValidBlockHeight: numeric(value.lastValidBlockHeight),
      blockHeight: numeric(height),
    };
  }
  async simulate(
    transactionBytes: Uint8Array,
    sponsor: string,
    actor: string,
  ): Promise<SolanaSimulation> {
    const decoded = getTransactionDecoder().decode(transactionBytes);
    const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
    if (
      message.version !== 0 ||
      (message.addressTableLookups?.length ?? 0) > 0 ||
      message.staticAccounts[0] !== sponsor
    )
      throw new Error('Unexpected transaction structure');
    const keys = message.staticAccounts.filter((_, index) =>
      index < message.header.numSignerAccounts
        ? index < message.header.numSignerAccounts - message.header.numReadonlySignerAccounts
        : index < message.staticAccounts.length - message.header.numReadonlyNonSignerAccounts,
    );
    // Two finalized RPC reads can straddle a slot boundary. Never compare
    // balances from different banks; retry the same exact transaction instead.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.multiple(keys);
      const result = object(
        await this.rpc('simulateTransaction', [
          Buffer.from(transactionBytes).toString('base64'),
          {
            encoding: 'base64',
            sigVerify: false,
            replaceRecentBlockhash: false,
            commitment: 'finalized',
            accounts: { encoding: 'base64', addresses: keys },
          },
        ]),
      );
      const value = object(result.value);
      if (
        value.err !== null ||
        !Array.isArray(value.accounts) ||
        value.accounts.length !== keys.length
      )
        throw new Error('Exact transaction simulation failed');
      const slot = numeric(object(result.context).slot);
      if (slot !== before.slot) {
        if (attempt < 2) continue;
        throw new Error('Simulation bank changed; request a fresh review');
      }
      const payerIndex = keys.indexOf(address(sponsor));
      const pre = before.accounts[payerIndex],
        post =
          value.accounts[payerIndex] === null ? null : account(sponsor, value.accounts[payerIndex]);
      if (!pre || !post) throw new Error('Sponsor simulation unavailable');
      const debit =
        atomic(pre.lamports) > atomic(post.lamports)
          ? atomic(pre.lamports) - atomic(post.lamports)
          : 0n;
      // Sponsor-run permissionless actions (pull-v2 payouts) have no separate user to protect.
      const actorIndex = actor === sponsor ? -1 : keys.indexOf(address(actor));
      if (actorIndex >= 0) {
        const original = before.accounts[actorIndex];
        const final =
          value.accounts[actorIndex] === null ? null : account(actor, value.accounts[actorIndex]);
        if (original && (!final || atomic(final.lamports) < atomic(original.lamports)))
          throw new Error('The user would pay native fees');
      }
      const feeResult = object(
        await this.rpc('getFeeForMessage', [
          Buffer.from(decoded.messageBytes).toString('base64'),
          { commitment: 'finalized' },
        ]),
      );
      if (feeResult.value === null) throw new Error('Transaction fee unavailable');
      const fee = atomic(numeric(feeResult.value));
      // Deliberately conservative: includes fee even when the simulation already deducted it.
      const ceiling = debit + fee;
      if (ceiling > atomic(this.config.maximumSponsorLamports))
        throw new Error('Sponsor fee and rent ceiling exceeded');
      return {
        slot,
        sponsorDebitCeilingLamports: ceiling.toString(),
        networkFeeLamports: fee.toString(),
      };
    }
    throw new Error('Simulation bank changed; request a fresh review');
  }
  async broadcast(transactionBytes: Uint8Array) {
    await this.checkedGenesis();
    const result = await this.rpc('sendTransaction', [
      Buffer.from(transactionBytes).toString('base64'),
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 },
    ]);
    if (typeof result !== 'string') throw new Error('Broadcast response ambiguous');
    return result;
  }
  reconcile(
    signature: string,
    messageSha256: string,
    expectedDeltas: readonly ExpectedTokenDelta[],
  ) {
    return observeSolanaSignature(
      {
        rpcUrl: this.config.rpcUrl,
        signature,
        genesisHash: this.config.genesisHash,
        expectedMessageSha256: messageSha256,
        expectedDeltas,
      },
      this.fetcher,
    );
  }
}
