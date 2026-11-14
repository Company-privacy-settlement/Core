import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadHostingVerification, verifyHosting } from './lib/hosting-verification.js';
const [configuration,output,...extra]=process.argv.slice(2);
if(!configuration||!output||extra.length){console.error('Usage: hosting:verify CONFIG_JSON NEW_REPORT_JSON');process.exitCode=1;}
else {
  try {
    const config=loadHostingVerification(configuration),destination=resolve(output);
    // Reserve before requests: never overwrite existing operational evidence.
    const fd=openSync(destination,'wx',0o600);
    try {
      const report=await verifyHosting(config);
      writeFileSync(fd,JSON.stringify(report,null,2)+'\n');fsyncSync(fd);
      console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failed:report.checks.filter(c=>!c.passed).map(c=>c.name),report:destination}));
      if(!report.passed)process.exitCode=1;
    } finally {closeSync(fd);}
  } catch {console.error('Hosting verification could not complete. Check HTTPS targets, the independently pinned deployed policy and a new writable report path.');process.exitCode=1;}
}
