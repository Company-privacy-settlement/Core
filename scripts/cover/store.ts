import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { canonical } from '../../sdk/client/crypto.js';
import { CoverConfig, type CoverSettings } from './model.js';
import type { ContractCall } from '../../sdk/ft.js';
import type { Prepared } from '../../server/relay/store.js';
export type CoverIntent = {
    sequence: number;
    state: 'preparing' | 'intent' | 'submitted' | 'uncertain' | 'final';
    startedAt: number;
    finalizedAt?: number;
    reserved: string;
    call: ContractCall;
    prepared: Prepared | null;
    result: any;
};
export class CoverStore {
    private db: DatabaseSync;
    readonly config: CoverSettings;
    constructor(file: string, config: CoverSettings, publicKey: string, now = Date.now(), noteCommitments: string[] = []) {
        this.config = CoverConfig.parse(JSON.parse(canonical(config)));
        Object.freeze(this.config.policy);
        Object.freeze(this.config);
        if (file !== ':memory:') {
            try {
                closeSync(openSync(file, 'wx', 0o600));
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw e;
            }
            const s = lstatSync(file);
            if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== (process.getuid?.() ?? s.uid))
                throw Error('COVER_PRIVATE_JOURNAL_REQUIRED');
        }
        this.db = new DatabaseSync(file);
        try {
            this.db.exec('PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=3000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;');
            const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
            if (tables.length && !tables.some(t => t.name === 'cover_identity'))
                throw Error('COVER_UNRELATED_DATABASE');
            this.db.exec('CREATE TABLE IF NOT EXISTS cover_identity(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS cover_intents(sequence INTEGER PRIMARY KEY,body TEXT NOT NULL);');
            this.tx(() => { const body = canonical({ config: this.config, publicKey, noteCommitments }), old = this.db.prepare('SELECT body FROM cover_identity WHERE id=1').get(); if (old && old.body !== body)
                throw Error('COVER_IDENTITY_CHANGED'); if (!old && (config.expiresAt <= now || config.expiresAt > now + 86400000))
                throw Error('COVER_WINDOW_INVALID'); this.db.prepare('INSERT OR IGNORE INTO cover_identity VALUES(1,?)').run(body); });
        }
        catch (e) {
            this.db.close();
            throw e;
        }
    }
    close() { this.db.close(); }
    all(): CoverIntent[] { return this.db.prepare('SELECT body FROM cover_intents ORDER BY sequence').all().map(r => JSON.parse(String(r.body))); }
    private tx<T>(f: () => T) { this.db.exec('BEGIN IMMEDIATE'); try {
        const v = f();
        this.db.exec('COMMIT');
        return v;
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    } }
    reserve(sequence: number, call: ContractCall, now: number) {
        return this.tx(() => {
            const all = this.all(), old = all.find(e => e.sequence === sequence);
            if (old)
                return { created: false, intent: old };
            if (!Number.isSafeInteger(sequence) || sequence !== all.length)
                throw Error('COVER_SEQUENCE');
            if (now >= this.config.expiresAt)
                throw Error('COVER_EXPIRED');
            if (all.some(e => e.state !== 'final'))
                throw Error('COVER_RECONCILIATION_REQUIRED');
            if (all.length >= this.config.maxTransactions)
                throw Error('COVER_COUNT_LIMIT');
            const last = all.at(-1);
            if (last && now < Math.max(last.startedAt, last.finalizedAt ?? last.startedAt) + this.config.minIntervalSeconds * 1000)
                throw Error('COVER_RATE_LIMIT');
            const reserved = BigInt(call.attachedYoctoNear) + BigInt(call.gas) * BigInt(this.config.maxGasPriceYoctoNear);
            if (all.reduce((sum, e) => sum + BigInt(e.reserved), reserved) > BigInt(this.config.maxBudgetYoctoNear))
                throw Error('COVER_BUDGET_LIMIT');
            const intent: CoverIntent = { sequence, state: 'preparing', startedAt: now, reserved: reserved.toString(), call, prepared: null, result: null };
            this.db.prepare('INSERT INTO cover_intents VALUES(?,?)').run(sequence, canonical(intent));
            return { created: true, intent };
        });
    }
    update(sequence: number, from: CoverIntent['state'][], change: Partial<CoverIntent>) { return this.tx(() => { const e = this.all().find(e => e.sequence === sequence); if (!e || !from.includes(e.state))
        throw Error('COVER_STATE_CHANGED'); const next = { ...e, ...change }; this.db.prepare('UPDATE cover_intents SET body=? WHERE sequence=?').run(canonical(next), sequence); return next; }); }
}
