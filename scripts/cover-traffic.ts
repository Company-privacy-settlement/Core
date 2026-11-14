import { readFileSync, lstatSync, openSync, closeSync, writeFileSync, fsyncSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { KeyPair } from 'near-api-js';
import { CoverConfig, coverPool, validateCoverCycle } from './cover/model.js';
import { CoverStore } from './cover/store.js';
import { CoverSigner } from './cover/signer.js';
import { coverStep, reconcileCover } from './cover/service.js';
import { coverSnapshot, coverBaseline, measureCoverEffect } from './cover/measurement.js';
import { createNote, validateNote, encodeVerificationKey, sha256, shutdownProver } from '../sdk/core.js';
import { RelayRpcSource } from '../server/relay/signer.js';
import { PrivacyObservations } from './lib/privacy-baseline.js';
const Runtime = z.object({ format: z.literal('core-cover-runtime-v1'), experiment: CoverConfig, rpcUrl: z.string(), keyFile: z.string(), notesFile: z.string(), journalFile: z.string(), artifactsDir: z.string() }).strict();
function read(file: string, limit: number, secret = false) { const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.size > limit || (secret && ((s.mode & 0o077) || s.uid !== (process.getuid?.() ?? s.uid))))
    throw Error('COVER_FILE_REJECTED'); return readFileSync(file); }
function save(file: string, value: unknown) { const fd = openSync(file, 'wx', 0o600); try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} }
const [command, file, ...args] = process.argv.slice(2);
let store: CoverStore | undefined;
try {
    if (!file || !['init', 'step', 'status', 'reconcile', 'snapshot', 'baseline', 'measure'].includes(command) || args.length !== ({ init: 0, step: 0, status: 0, reconcile: 0, snapshot: 1, baseline: 1, measure: 4 } as any)[command])
        throw Error('COVER_USAGE');
    const runtime = Runtime.parse(JSON.parse(read(file, 16384).toString())), base = dirname(resolve(file)), path = (s: string) => resolve(base, s), c = runtime.experiment;
    const url = new URL(runtime.rpcUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw Error('COVER_HTTPS_RPC_REQUIRED');
    const key = z.object({ account_id: z.literal(c.signer), public_key: z.string(), private_key: z.string() }).strict().parse(JSON.parse(read(path(runtime.keyFile), 4096, true).toString())), pair = KeyPair.fromString(key.private_key);
    if (pair.getPublicKey().toString() !== key.public_key)
        throw Error('COVER_KEY_MISMATCH');
    if (command === 'init') {
        validateCoverCycle(c);
        const notes = await Promise.all(Array.from({ length: c.transferCount + 1 }, () => createNote(coverPool(c))));
        save(path(runtime.notesFile), notes);
    }
    const notes = z.array(z.object({ version: z.literal(1), domain: z.string(), secret: z.string(), nullifier: z.string(), commitment: z.string() }).strict()).length(c.transferCount + 1).parse(JSON.parse(read(path(runtime.notesFile), 65536, true).toString()));
    for (const n of notes)
        await validateNote(coverPool(c), n);
    const vk = JSON.parse(read(resolve(path(runtime.artifactsDir), 'verification_key.json'), 16384).toString());
    if (sha256(Buffer.from(encodeVerificationKey(vk), 'base64')) !== c.policy.verifierSha256)
        throw Error('COVER_VERIFIER_MISMATCH');
    store = new CoverStore(path(runtime.journalFile), c, key.public_key, Date.now(), notes.map(n => n.commitment));
    const source = new RelayRpcSource('testnet', c.policy.registry, runtime.rpcUrl), signer = new CoverSigner(c, notes, pair, source);
    if (command === 'init') {
        await signer.fresh();
        console.log(JSON.stringify({ state: 'initialized', experimentId: c.id, network: 'testnet', artificialActivity: true }));
    }
    if (command === 'step')
        console.log(JSON.stringify(await coverStep(store, signer, notes, path(runtime.artifactsDir))));
    if (command === 'reconcile')
        console.log(JSON.stringify(await reconcileCover(store, signer)));
    if (command === 'status') {
        const all = store.all(), last = all.at(-1);
        console.log(JSON.stringify({ experimentId: c.id, count: all.length, reservedYoctoNear: all.reduce((n, e) => n + BigInt(e.reserved), 0n).toString(), maxBudgetYoctoNear: c.maxBudgetYoctoNear, nextEligibleAt: last ? Math.max(last.startedAt, last.finalizedAt ?? last.startedAt) + c.minIntervalSeconds * 1000 : null, expiresAt: c.expiresAt, operations: all.map(e => ({ sequence: e.sequence, state: e.state, hash: e.prepared?.hash ?? null })) }));
    }
    if (command === 'snapshot' || command === 'baseline') {
        await signer.fresh();
        for (const e of store.all().filter(e => e.state === 'final'))
            await signer.reconcile(e.sequence, e.prepared!, e.call);
        save(args[0], await (command === 'baseline' ? coverBaseline(c, source, store) : coverSnapshot(c, source, store)));
        console.log(JSON.stringify({ snapshot: args[0], archivalPreTransactionReconstruction: command === 'baseline' && store.all().length > 0 }));
    }
    if (command === 'measure') {
        const [beforeFile, beforeDigest, afterFile, afterDigest] = args, load = (f: string, h: string) => { const bytes = read(f, 8388608); if (!/^[a-f0-9]{64}$/.test(h) || sha256(bytes) !== h)
            throw Error('COVER_OBSERVATION_DIGEST'); return PrivacyObservations.parse(JSON.parse(bytes.toString())); };
        console.log(JSON.stringify(measureCoverEffect(load(beforeFile, beforeDigest), load(afterFile, afterDigest), c), null, 2));
    }
}
catch (e) {
    console.error(e instanceof Error && /^COVER_[A-Z_]+$/.test(e.message) ? e.message : 'COVER_OPERATION_REJECTED');
    process.exitCode = 1;
}
finally {
    store?.close();
    await shutdownProver();
}
