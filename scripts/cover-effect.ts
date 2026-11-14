import { lstatSync, readFileSync, openSync, closeSync, writeFileSync, fsyncSync } from 'node:fs';
import { sha256 } from '../sdk/core.js';
import { CoverConfig } from './cover/model.js';
import { PrivacyObservations } from './lib/privacy-baseline.js';
import { measureCoverEffect } from './cover/measurement.js';
const [configFile, beforeFile, beforeHash, afterFile, afterHash, output, ...extra] = process.argv.slice(2);
let fd: number | undefined;
try {
    if (!output || extra.length)
        throw Error('COVER_USAGE');
    const read = (file: string, limit: number) => { const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.size > limit)
        throw Error('COVER_PUBLIC_INPUT_REJECTED'); return readFileSync(file); };
    const c = CoverConfig.parse(JSON.parse(read(configFile, 16384).toString())), load = (f: string, h: string) => { const bytes = read(f, 8388608); if (!/^[a-f0-9]{64}$/.test(h) || sha256(bytes) !== h)
        throw Error('COVER_OBSERVATION_DIGEST'); return PrivacyObservations.parse(JSON.parse(bytes.toString())); };
    const report = measureCoverEffect(load(beforeFile, beforeHash), load(afterFile, afterHash), c);
    fd = openSync(output, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ ...report, inputFiles: { beforeSha256: beforeHash, afterSha256: afterHash } }, null, 2) + '\n');
    fsyncSync(fd);
    console.log(JSON.stringify({ report: output, effectiveAnonymityEstablished: false, independentParticipantsAdded: 0 }));
}
catch {
    console.error('Cover-effect measurement rejected. Use public same-policy snapshots, their independent hashes, and a new report path.');
    process.exitCode = 1;
}
finally {
    if (fd !== undefined)
        closeSync(fd);
}
