/** Real Chromium + current WASM/zkey; private fixture material never enters the report. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { groth16 } from 'snarkjs';
import { createNote, contextHash, encodeVerificationKey, hash, NoteTree, sha256, shutdownProver, type Pool } from '../../sdk/core.js';
import { encryptNoteBackup } from '../../sdk/client/notes.js';
import { decodeBrowserProof, parseProofBundle } from '../../sdk/client/prover.js';
import type { Policy } from '../../sdk/client/types.js';

const root = resolve(import.meta.dirname, '../../..'), front = resolve(root, 'Front');
const { chromium } = createRequire(resolve(front, 'package.json'))('@playwright/test');
const artifacts = resolve(root, 'Core/artifacts'), out = resolve(front, 'out'), work = await mkdtemp(resolve(tmpdir(), 'core-browser-prover-'));
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname), file = resolve(out, '.' + pathname, pathname.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(out + sep)) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'} as Record<string,string>)[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); if (!address || typeof address === 'string') throw new Error('No browser test server');
const origin = `http://127.0.0.1:${address.port}`;
let browserServer: any, browser: any, sampler: ReturnType<typeof setInterval> | undefined;
function rss(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const children = new Set([pid]); let size = 0;
    while (size !== children.size) { size = children.size; for (const [child, parent] of rows) if (children.has(parent)) children.add(child); }
    return rows.reduce((sum, [child, , memory]) => sum + (children.has(child) ? memory * 1024 : 0), 0);
  } catch { return null; }
}
try {
  const manifest = await readFile(resolve(artifacts, 'manifest.json')), vkey = JSON.parse(await readFile(resolve(artifacts, 'verification_key.json'), 'utf8'));
  const policy: Policy = { network: 'testnet', registry: 'forest.testnet', tokenId: 'usdc.testnet', denomination: '1000000', feeRecipient: 'treasury.testnet', registryWasmSha256: 'aa'.repeat(32), vaultWasmSha256: 'bb'.repeat(32), verifierSha256: sha256(Buffer.from(encodeVerificationKey(vkey), 'base64')) };
  const pool: Pool = { version: 3, network: 'testnet', contract: policy.registry, tokenId: policy.tokenId!, denomination: policy.denomination }, note = await createNote(pool);
  const tree = await NoteTree.from(['42', note.commitment, '43']), vault = `v${'a'.repeat(32)}.${policy.registry}`, recipient = 'receiver.testnet', disclosureRoot = 'cd'.repeat(32), password = 'public browser proving fixture only';
  const snapshot = { version: 1, policy, vault, root: tree.root, commitments: tree.leaves, checkedAtBlock: { hash: 'B'.repeat(44), height: 20 } };
  const backup = await encryptNoteBackup(policy, note, password), manifestSha256 = sha256(manifest);
  browserServer = await chromium.launchServer({ headless: true }); browser = await chromium.connect(browserServer.wsEndpoint());
  const records = [];
  for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
    await page.addInitScript(() => {
      const w = window as unknown as { coreProvingMetrics: unknown[] }; w.coreProvingMetrics = [];
      const Original = window.Worker;
      window.Worker = class extends Original {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener('message', event => { if (event.data?.type === 'result') w.coreProvingMetrics.push(event.data.metrics); });
        }
      };
    });
    page.setDefaultTimeout(60000);
    const network: {url:string;body:string}[] = [], failures: string[] = []; let workers = 0;
    page.on('request', (request: any) => network.push({url:request.url(),body:request.postData()??''}));
    page.on('pageerror', (error: Error) => failures.push(error.message)); page.on('worker', () => { workers++; });
    const baseline = rss(browserServer.process().pid); let peak = baseline;
    sampler = setInterval(() => { const value=rss(browserServer.process().pid); if(value!==null)peak=Math.max(peak??0,value); }, 100);
    await page.goto(origin + '/prove/');
    const upload = async (label:string,name:string,buffer:Buffer) => page.getByLabel(label,{exact:true}).setInputFiles({name,mimeType:'application/octet-stream',buffer});
    await upload('Trusted FT policy JSON','policy.json',Buffer.from(JSON.stringify(policy)));
    await page.getByLabel('Note passphrase',{exact:true}).fill(password);
    await upload('Encrypted note backup','note.json',Buffer.from(backup));
    await page.locator('.note-commitment').waitFor();
    await page.getByLabel('Trusted proving manifest SHA-256',{exact:true}).fill(manifestSha256);
    for(const [label,file] of [['Proving manifest JSON','manifest.json'],['Circuit WASM file','spend_js/spend.wasm'],['Proving key file','spend.zkey'],['Verification key JSON','verification_key.json']]) await upload(label,file.split('/').at(-1)!,await readFile(resolve(artifacts,file)));
    await upload('Or import public group snapshot JSON','snapshot.json',Buffer.from(JSON.stringify(snapshot)));
    await page.getByLabel('Recipient account',{exact:true}).fill(recipient);await page.getByLabel('Disclosure root',{exact:true}).fill(disclosureRoot);
    await page.getByRole('button',{name:'Generate local proof',exact:true}).click();
    await page.getByRole('heading',{name:'Proof verified locally',exact:true}).waitFor({timeout:90000});
    const download = page.waitForEvent('download'); await page.getByRole('button',{name:'Download proof file',exact:true}).click();
    const file=resolve(work,`proof-${viewport.width}.json`);await(await download).saveAs(file);
    const bundle=await parseProofBundle(JSON.parse(await readFile(file,'utf8')),policy);
    const context=contextHash(pool,{kind:'withdraw',vault,target:recipient,disclosureRoot});
    const expected=[await hash([note.nullifier,note.domain]),await hash([note.nullifier,context]),tree.root,context,note.domain];
    if(JSON.stringify(bundle.spend.public_inputs)!==JSON.stringify(expected)||!await groth16.verify(vkey,bundle.spend.public_inputs,decodeBrowserProof(bundle.spend))) throw new Error('Browser proof differs from CLI public inputs or fails independent Node verification');
    await upload('Verify an existing proof file','proof.json',Buffer.from(JSON.stringify(bundle)));
    await page.getByRole('status').filter({hasText:'Proof file integrity and Groth16 proof verified'}).waitFor();
    if(workers!==2)throw new Error('Expected one disposable worker per operation without nested worker pools');
    const html=await page.locator('body').innerText(),storage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));
    for(const secret of [note.secret,note.nullifier,password]) if(html.includes(secret)||storage.includes(secret)||network.some(r=>(r.url+r.body).includes(secret))||JSON.stringify(bundle).includes(`"${secret}"`)) throw new Error('Private fixture material escaped its local inputs');
    if(network.some(r=>!r.url.startsWith(origin+'/'))||failures.length)throw new Error('Unexpected external request or browser error');
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight+1)) throw new Error('Proving workspace escaped viewport containment');
    clearInterval(sampler);sampler=undefined;
    const timings=await page.evaluate(()=>(window as unknown as {coreProvingMetrics:unknown[]}).coreProvingMetrics);
    const report={viewport,widthMode:viewport.width<500?'mobile-emulated':'desktop',proofVerifiedByNode:true,cliPublicInputsMatch:true,proverWorkers:workers,provingMetrics:timings[0],fileVerificationMetrics:timings[1],sampledBrowserTreeBaselineRssBytes:baseline,sampledBrowserTreePeakRssBytes:peak};
    records.push(report);console.log(JSON.stringify(report));await page.close();
  }
  await mkdir('demo-output',{recursive:true});
  await writeFile('demo-output/browser-prover-validation.json',JSON.stringify({format:'core-browser-prover-validation-v1',setup:JSON.parse(manifest.toString()).setup,publicNetworkDeployed:false,manifestSha256,records,memoryScope:'Sampled aggregate Linux RSS for the Chromium process tree; includes browser/renderers. This is not a precise WASM peak or a physical mobile-device measurement.'},null,2)+'\n');
  console.log('Actual browser WASM/Groth16 proofs match CLI inputs and pass independent Node verification on desktop and mobile emulation. No public transaction.');
} finally {
  if(sampler)clearInterval(sampler);await browser?.close();await browserServer?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await shutdownProver();await rm(work,{recursive:true,force:true});
}
