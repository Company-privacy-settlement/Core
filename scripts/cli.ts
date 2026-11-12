import { readFile, writeFile } from 'node:fs/promises';
import { createNote, validateNote, encodeVerificationKey, NoteTree, proveSpend, shutdownProver, STORAGE_FEE, type Note, type Pool, type Action } from '../sdk/core.js';
import { createReceipt, disclose, decryptPrivate, encryptPrivate, type Receipt, type ReceiptField } from '../sdk/disclosure.js';
import { NearRpcEvidenceSource, verifyBundle, type SettlementBundle } from '../sdk/evidence.js';
import { createFreshRecipient } from '../sdk/wallet.js';
import { randomBytes } from 'node:crypto';
import { discoverVaults, predictVaultAccount, NearRpcFactorySource, type FactoryPolicy } from '../sdk/factory.js';

const [command, ...args] = process.argv.slice(2);
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function save(path: string, value: string) { await writeFile(path, value, { mode: 0o600, flag: 'wx' }); }
function password(): string {
  const value = process.env.CORE_NOTE_PASSWORD;
  if (!value) throw new Error('Set CORE_NOTE_PASSWORD; never pass note passwords as CLI arguments');
  return value;
}
async function loadNote(path: string): Promise<Note> {
  return decryptPrivate(await readFile(path, 'utf8'), password()) as Note;
}
try {
  switch (command) {
    case 'discover-vaults': {
      if (args.length !== 2 && args.length !== 4) throw new Error('discover-vaults trusted-policy.json trusted-rpc-url [from-index max-records]');
      const policy: FactoryPolicy = await json(args[0]);
      const options = args.length === 4 ? { fromIndex: Number(args[2]), maxRecords: Number(args[3]) } : {};
      output(await discoverVaults(new NearRpcFactorySource(policy.network, policy.factory, args[1]), policy, options));
      break;
    }
    case 'create-vault-args': {
      if (args.length !== 3) throw new Error('create-vault-args trusted-policy.json creator-account trusted-rpc-url');
      const policy: FactoryPolicy = await json(args[0]);
      const catalog = await discoverVaults(new NearRpcFactorySource(policy.network, policy.factory, args[2]), policy, { maxRecords: 1 });
      const salt = randomBytes(32).toString('hex');
      output({ contract: policy.factory, method: 'create_vault', args: { salt }, depositYocto: catalog.creationDeposit, gasTgas: 300,
        predictedVault: predictVaultAccount(policy.factory, args[1], salt), creator: args[1], checkedAtBlock: catalog.blockHash });
      break;
    }
    case 'wallet': {
      if (args.length !== 1) throw new Error('wallet encrypted-wallet.json');
      const wallet = createFreshRecipient(password());
      await save(args[0], wallet.encryptedBackup);
      output({ accountId: wallet.accountId, publicKey: wallet.publicKey, encryptedBackup: args[0] });
      break;
    }
    case 'note': {
      if (args.length !== 2) throw new Error('note pool.json encrypted-note.json');
      const pool: Pool = await json(args[0]), note = await createNote(pool);
      await save(args[1], encryptPrivate(note, password()));
      output({ paymentRequest: { protocol: 'core-v1', pool, commitment: note.commitment }, encryptedBackup: args[1] });
      break;
    }
    case 'init-args': {
      if (args.length !== 1) throw new Error('init-args pool.json');
      const pool: Pool = await json(args[0]), vk = await json('artifacts/verification_key.json');
      output({ method: 'new', args: { network: pool.network, denomination: pool.denomination, verification_key: encodeVerificationKey(vk) }, depositYocto: (10n ** 24n).toString(), gasTgas: 300 });
      break;
    }
    case 'deposit-args': {
      if (args.length !== 3) throw new Error('deposit-args pool.json encrypted-note.json disclosure-root');
      const pool: Pool = await json(args[0]), note = await loadNote(args[1]);
      await validateNote(pool, note);
      output({ method: 'deposit', args: { commitment: note.commitment, disclosure_root: args[2] }, depositYocto: (BigInt(pool.denomination) + STORAGE_FEE).toString(), gasTgas: 300 });
      break;
    }
    case 'spend-args': {
      if (args.length !== 5) throw new Error('spend-args pool.json encrypted-note.json commitments.json action.json output.json');
      const pool: Pool = await json(args[0]), note = await loadNote(args[1]), action: Action = await json(args[3]);
      const tree = await NoteTree.from(await json(args[2]));
      const proof = await proveSpend(pool, note, tree, action);
      const actionArgs = action.kind === 'transfer' ? { output_commitment: action.target } : { recipient: action.target };
      await save(args[4], JSON.stringify({ method: action.kind, args: { ...actionArgs, disclosure_root: action.disclosureRoot, ...proof.args }, depositYocto: STORAGE_FEE.toString(), gasTgas: 300 }, null, 2));
      output({ prepared: args[4], warning: 'Anyone with this bound proof can submit it; destination cannot be changed.' });
      break;
    }
    case 'receipt': {
      if (args.length !== 2) throw new Error('receipt values.json private-receipt.json');
      const receipt = createReceipt(await json(args[0]));
      await save(args[1], JSON.stringify(receipt, null, 2));
      output({ disclosureRoot: receipt.root, privateReceipt: args[1] });
      break;
    }
    case 'disclose': {
      if (args.length !== 2) throw new Error('disclose private-receipt.json asset,amount,reference');
      output(disclose(await json(args[0]) as Receipt, args[1].split(',') as ReceiptField[]));
      break;
    }
    case 'verify-bundle': {
      if (args.length !== 2) throw new Error('verify-bundle bundle.json trusted-rpc-url');
      const bundle: SettlementBundle = await json(args[0]);
      output(await verifyBundle(bundle, new NearRpcEvidenceSource(bundle.network, bundle.contract, args[1])));
      break;
    }
    default:
      console.log('Commands: wallet, note, init-args, deposit-args, spend-args, receipt, disclose, verify-bundle, discover-vaults, create-vault-args. See README.md.');
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exitCode = 1;
} finally {
  await shutdownProver();
}
