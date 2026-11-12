import { z } from 'zod';
import { sha256 } from './core.js';
import { verifyDisclosure, type Receipt } from './disclosure.js';

export type ChainRecord = {
  index: number; kind: string; commitment: string | null; nullifier: string | null;
  recipient: string | null; disclosure_root: string; block_height: number; timestamp_ns: string;
};
const RecordSchema = z.object({
  index: z.number().int().nonnegative(), kind: z.string(), commitment: z.string().nullable(),
  nullifier: z.string().nullable(), recipient: z.string().nullable(), disclosure_root: z.string().regex(/^[a-f0-9]{64}$/),
  block_height: z.number().int().nonnegative(), timestamp_ns: z.string().regex(/^[0-9]+$/),
});
export type TxRef = { hash: string; signer: string; recordIndex: number };
export type SettlementBundle = {
  version: 1; network: 'testnet' | 'sandbox'; contract: string;
  scope: 'selected_transactions'; transactions: { tx: TxRef; disclosure?: Receipt }[];
};
export interface EvidenceSource {
  readonly network: 'testnet' | 'sandbox';
  readonly contract: string;
  getRecord(index: number): Promise<ChainRecord>;
  getTransaction(ref: TxRef): Promise<unknown>;
}
function recordFingerprint(record: ChainRecord): string {
  return sha256(JSON.stringify([record.index, record.kind, record.commitment, record.nullifier, record.recipient, record.disclosure_root, record.block_height, record.timestamp_ns]));
}
function isAnchored(tx: any, ref: TxRef, record: ChainRecord, contract: string): boolean {
  if (tx?.final_execution_status !== 'FINAL' || !tx?.status || !Object.hasOwn(tx.status, 'SuccessValue')) return false;
  if (tx.transaction?.hash !== ref.hash || tx.transaction?.signer_id !== ref.signer) return false;
  // Cross-contract logs are trusted only when this pool was the receipt executor.
  return (tx.receipts_outcome ?? []).some((receipt: any) => {
    const outcome = receipt.outcome;
    if (outcome?.executor_id !== contract || !outcome.status || (!Object.hasOwn(outcome.status, 'SuccessValue') && !Object.hasOwn(outcome.status, 'SuccessReceiptId'))) return false;
    return (outcome.logs ?? []).some((log: string) => {
      try {
        if (!log.startsWith('EVENT_JSON:')) return false;
        const event = JSON.parse(log.slice(11));
        return event.standard === 'core_privacy' && event.version === '1.0.0' && event.event === record.kind && event.data.some((r: unknown) => {
          const parsed = RecordSchema.safeParse(r);
          return parsed.success && recordFingerprint(parsed.data) === recordFingerprint(record);
        });
      } catch { return false; }
    });
  });
}
export async function verifyBundle(bundle: SettlementBundle, source: EvidenceSource) {
  if (bundle.version !== 1 || bundle.scope !== 'selected_transactions' || bundle.network !== source.network || bundle.contract !== source.contract || bundle.transactions.length === 0) throw new Error('Bundle domain or scope mismatch');
  const seen = new Set<number>();
  const verified: ChainRecord[] = [];
  for (const item of bundle.transactions) {
    if (seen.has(item.tx.recordIndex)) throw new Error('Duplicate record');
    seen.add(item.tx.recordIndex);
    const record = RecordSchema.parse(await source.getRecord(item.tx.recordIndex));
    if (record.index !== item.tx.recordIndex) throw new Error('Wrong chain record');
    const transaction = await source.getTransaction(item.tx);
    if (!isAnchored(transaction, item.tx, record, bundle.contract)) throw new Error('Transaction does not anchor the record');
    if (item.disclosure && !verifyDisclosure(item.disclosure, record.disclosure_root)) throw new Error('Disclosure mismatch');
    verified.push(record);
  }
  return {
    valid: true, scope: 'selected_transactions' as const, records: verified,
    claims: { submittedTransactionsIncluded: true, receiptIntegrity: true, completeHistory: false, legalIdentityVerified: false, taxFilingAccepted: false },
  };
}

export class NearRpcEvidenceSource implements EvidenceSource {
  private id = 0;
  constructor(readonly network: 'testnet' | 'sandbox', readonly contract: string, private readonly rpcUrl: string) {
    const url = new URL(rpcUrl);
    if (url.protocol !== 'https:' && !(network === 'sandbox' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS RPC outside sandbox');
  }
  private async rpc(method: string, params: unknown): Promise<any> {
    const response = await fetch(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body: any = await response.json();
    if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
    return body.result;
  }
  async getRecord(index: number): Promise<ChainRecord> {
    const result = await this.rpc('query', { request_type: 'call_function', finality: 'final', account_id: this.contract, method_name: 'get_records', args_base64: Buffer.from(JSON.stringify({ from_index: index, limit: 1 })).toString('base64') });
    const records = JSON.parse(Buffer.from(result.result).toString());
    return RecordSchema.parse(records[0]);
  }
  async getTransaction(ref: TxRef): Promise<unknown> {
    return this.rpc('tx', { tx_hash: ref.hash, sender_account_id: ref.signer, wait_until: 'FINAL' });
  }
}
