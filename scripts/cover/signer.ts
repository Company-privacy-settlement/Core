import { KeyPair, transactions, utils, InMemorySigner } from 'near-api-js';
import bs58 from 'bs58';
import { NearRelaySigner, RelayRpcSource } from '../../server/relay/signer.js';
import { sha256, type Note } from '../../sdk/core.js';
import { canonical } from '../../sdk/client/crypto.js';
import { verifyRecordedWalletTransaction } from '../lib/testnet-wallet-verification.js';
import { validateCoverCall, type CoverSettings } from './model.js';
import type { Prepared } from '../../server/relay/store.js';
import type { ContractCall } from '../../sdk/ft.js';
export class CoverSigner {
    readonly publicKey: string;
    private freshness: NearRelaySigner;
    constructor(readonly config: CoverSettings, private notes: Note[], private pair: KeyPair, readonly source: RelayRpcSource) { this.publicKey = pair.getPublicKey().toString(); if (!this.publicKey.startsWith('ed25519:'))
        throw Error('COVER_ED25519_REQUIRED'); this.freshness = new NearRelaySigner(config.signer, pair, config.policy, source, config.maxGasPriceYoctoNear); }
    async fresh() { await this.freshness.fresh(); }
    async chainTime() { const b = await this.source.finalBlock(), raw = await this.source.read('block', { block_id: b.hash }); return Number(BigInt(raw.header.timestamp_nanosec) / 1000000n); }
    private decode(p: Prepared, sequence: number, call: ContractCall) {
        validateCoverCall(this.config, this.notes, sequence, call);
        const bytes = Buffer.from(p.unsignedTransaction, 'base64');
        if (bytes.length > 8192 || bytes.toString('base64') !== p.unsignedTransaction || bs58.encode(Buffer.from(sha256(bytes), 'hex')) !== p.hash)
            throw Error('COVER_INTENT_INVALID');
        const raw = transactions.Transaction.decode(bytes), action = raw.actions?.[0]?.functionCall;
        // Persisted JSON keys are canonically ordered, while the original signed
        // argument bytes retain their original order. Bind their meaning and
        // preserve those exact bytes when reconstructing the signed transaction.
        if (raw.actions.length !== 1 || !action || action.methodName !== call.method || action.gas.toString() !== call.gas || action.deposit.toString() !== call.attachedYoctoNear || canonical(JSON.parse(Buffer.from(action.args).toString('utf8'))) !== canonical(call.args))
            throw Error('COVER_INTENT_CHANGED');
        const tx = transactions.createTransaction(this.config.signer, utils.PublicKey.fromString(this.publicKey), call.contract, BigInt(raw.nonce), [transactions.functionCall(call.method, Buffer.from(action.args), BigInt(call.gas), BigInt(call.attachedYoctoNear))], Uint8Array.from(raw.blockHash));
        // Reconstruct every field rather than accepting a caller's transaction body.
        if (!Buffer.from(tx.encode()).equals(bytes))
            throw Error('COVER_INTENT_CHANGED');
        return tx;
    }
    async prepare(sequence: number, call: ContractCall): Promise<Prepared> {
        validateCoverCall(this.config, this.notes, sequence, call);
        await this.fresh();
        const block = await this.source.finalBlock(), access = await this.source.read('query', { request_type: 'view_access_key', account_id: this.config.signer, public_key: this.publicKey, block_id: block.hash });
        if (access.permission !== 'FullAccess' || !Number.isSafeInteger(access.nonce))
            throw Error('COVER_OWN_FULL_ACCESS_KEY_REQUIRED');
        const account = await this.source.account(this.config.signer, block.hash) as any, protocol = await this.source.read('EXPERIMENTAL_protocol_config', { block_id: block.hash });
        const needed = BigInt(account.storage_usage) * BigInt(protocol.runtime_config.storage_amount_per_byte) + BigInt(call.attachedYoctoNear) + BigInt(call.gas) * BigInt(this.config.maxGasPriceYoctoNear);
        if (BigInt(account.amount) < needed)
            throw Error('COVER_BUDGET_UNFUNDED');
        const tx = transactions.createTransaction(this.config.signer, utils.PublicKey.fromString(this.publicKey), call.contract, BigInt(access.nonce) + 1n, [transactions.functionCall(call.method, Buffer.from(JSON.stringify(call.args)), BigInt(call.gas), BigInt(call.attachedYoctoNear))], bs58.decode(block.hash));
        const bytes = Buffer.from(tx.encode());
        return { hash: bs58.encode(Buffer.from(sha256(bytes), 'hex')), unsignedTransaction: bytes.toString('base64') };
    }
    verify(sequence: number, p: Prepared, call: ContractCall, raw: any) { const tx = this.decode(p, sequence, call); const action = raw?.transaction?.actions?.[0]?.FunctionCall; if (raw?.transaction?.actions?.length !== 1 || action?.method_name !== call.method || String(action.gas) !== call.gas || action.deposit !== call.attachedYoctoNear || canonical(JSON.parse(Buffer.from(action.args, 'base64').toString())) !== canonical(call.args))
        throw Error('COVER_FINAL_ACTION_CHANGED'); verifyRecordedWalletTransaction(raw, { label: 'declared-synthetic-' + sequence, hash: p.hash, signer: this.config.signer, receiver: call.contract, publicKey: this.publicKey, nonce: tx.nonce.toString(), unsignedTransaction: p.unsignedTransaction, expectedReceiptFailure: false }); return raw; }
    async submit(sequence: number, p: Prepared, call: ContractCall) { const tx = this.decode(p, sequence, call); await this.fresh(); const chainTime = await this.chainTime(); if (Date.now() >= this.config.expiresAt || chainTime >= this.config.expiresAt)
        throw Error('COVER_EXPIRED'); const signer = await InMemorySigner.fromKeyPair('testnet', this.config.signer, this.pair), [hash, signed] = await transactions.signTransaction(tx, signer, this.config.signer, 'testnet'); if (bs58.encode(hash) !== p.hash)
        throw Error('COVER_SIGNATURE_MISMATCH'); if (Date.now() >= this.config.expiresAt)
        throw Error('COVER_EXPIRED'); const raw = await this.source.read('send_tx', { signed_tx_base64: Buffer.from(signed.encode()).toString('base64'), wait_until: 'FINAL' }); return this.verify(sequence, p, call, raw); }
    async reconcile(sequence: number, p: Prepared, call: ContractCall) { const raw: any = await this.source.transaction(p.hash, this.config.signer); if (!raw || raw.final_execution_status !== 'FINAL')
        throw Error('COVER_NOT_FINAL'); return this.verify(sequence, p, call, raw); }
}
