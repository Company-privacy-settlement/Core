import { readFile, writeFile } from 'node:fs/promises';
import { createNote, validateNote, domain, quoteFees, encodeVerificationKey, NoteTree, proveSpend, shutdownProver, STORAGE_FEE, type Note, type Pool, type Action } from '../sdk/core.js';
import { createReceipt, disclose, decryptPrivate, encryptPrivate, type Receipt, type ReceiptField } from '../sdk/disclosure.js';
import { NearRpcEvidenceSource, verifyBundle, type SettlementBundle } from '../sdk/evidence.js';
import { createFreshRecipient } from '../sdk/wallet.js';
import { randomBytes } from 'node:crypto';
import { discoverVaults, predictVaultAccount, NearRpcFactorySource, type FactoryPolicy } from '../sdk/factory.js';
import { discoverSharedVaults, loadSharedTree, chooseSharedVault, NearRpcSharedSource, type SharedPolicy } from '../sdk/shared.js';

import { buildFtDeposit, buildFtWithdrawal, parseUsdc, quoteFtFees } from '../sdk/ft.js';

import { NearRpcOperationsSource, preflightFt, observeSettlement, waitForSettlement, PreflightInput, SettlementReference } from '../sdk/operations.js';

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
    case 'ft-preflight': {
      if (args.length !== 3) throw new Error('ft-preflight trusted-policy.json trusted-rpc-url public-request.json');
      const policy = await json(args[0]);
      output(await preflightFt(new NearRpcOperationsSource(policy.network, policy.registry, args[1]), policy, PreflightInput.parse(await json(args[2]))));
      break;
    }
    case 'settlement-status':
    case 'settlement-wait': {
      if (args.length !== 3) throw new Error(`${command} trusted-policy.json trusted-rpc-url public-reference.json`);
      const policy = await json(args[0]), ref = SettlementReference.parse(await json(args[2]));
      const source = new NearRpcOperationsSource(policy.network, policy.registry, args[1]);
      const result = command === 'settlement-wait' ? await waitForSettlement(source, policy, ref) : await observeSettlement(source, policy, ref);
      output(result);
      break;
    }
    case 'discover-shared': {
      if (args.length !== 2 && args.length !== 4) throw new Error('discover-shared trusted-policy.json trusted-rpc-url [from-index max-records]');
      const policy: SharedPolicy = await json(args[0]);
      output(await discoverSharedVaults(new NearRpcSharedSource(policy.network, policy.registry, args[1]), policy,
        args.length === 4 ? { fromIndex: Number(args[2]), maxRecords: Number(args[3]) } : {}));
      break;
    }
    case 'shared-note': {
      if (args.length !== 3) throw new Error('shared-note trusted-policy.json trusted-rpc-url encrypted-note.json');
      const policy: SharedPolicy = await json(args[0]);
      const catalog = await discoverSharedVaults(new NearRpcSharedSource(policy.network, policy.registry, args[1]), policy);
      const note = await createNote(catalog.pool);
      await save(args[2], encryptPrivate(note, password()));
      output({ paymentRequest: { protocol: catalog.pool.version === 3 ? 'core-shared-ft-v3' : 'core-shared-v2', pool: catalog.pool, commitment: note.commitment }, encryptedBackup: args[2] });
      break;
    }
    case 'shared-deposit-args': {
      if (args.length !== 4) throw new Error('shared-deposit-args trusted-policy.json trusted-rpc-url encrypted-note.json disclosure-root');
      const policy: SharedPolicy = await json(args[0]);
      const catalog = await discoverSharedVaults(new NearRpcSharedSource(policy.network, policy.registry, args[1]), policy);
      const note = await loadNote(args[2]); await validateNote(catalog.pool, note);
      if (!/^[a-f0-9]{64}$/.test(args[3])) throw new Error('Invalid disclosure root');
      if (catalog.pool.version === 3) {
        output({ ...await buildFtDeposit(catalog, chooseSharedVault(catalog, 'deposit'), note, args[3]), checkedAtBlock: catalog.blockHash, prerequisite: 'Prepay NEAR storage for the token sender and register the vault on the pinned FT contract first.' }); break;
      }
      output({ contract: chooseSharedVault(catalog, 'deposit'), method: 'deposit', args: { commitment: note.commitment, disclosure_root: args[3] }, depositYocto: quoteFees(policy.denomination).depositAttached, gasTgas: 300, registry: policy.registry, checkedAtBlock: catalog.blockHash });
      break;
    }
    case 'shared-spend-args': {
      if (args.length !== 5) throw new Error('shared-spend-args trusted-policy.json trusted-rpc-url encrypted-note.json action.json output.json');
      const policy: SharedPolicy = await json(args[0]);
      const source = new NearRpcSharedSource(policy.network, policy.registry, args[1]);
      const catalog = await discoverSharedVaults(source, policy), note = await loadNote(args[2]);
      const action: Action = await json(args[3]);
      if (action.kind === 'withdraw') {
        action.vault ??= chooseSharedVault(catalog, 'withdraw');
        if (!catalog.vaults.some(v => v.accountId === action.vault && v.canWithdraw)) throw new Error('Destination vault is not verified or lacks liquidity');
      }
      const proof = await proveSpend(catalog.pool, note, await loadSharedTree(source, catalog), action);
      if (catalog.pool.version === 3 && action.kind === 'withdraw') {
        const plan = buildFtWithdrawal(catalog, action.vault!, action.target, action.disclosureRoot, proof.args);
        await save(args[4], JSON.stringify({ ...plan, checkedAtBlock: catalog.blockHash, prerequisite: 'Prepay registry NEAR storage for the token fee payer; register vault, registry, recipient and treasury on the pinned FT contract.' }, null, 2));
        output({ prepared: args[4], registry: policy.registry, selectedVault: action.vault }); break;
      }
      const actionArgs = action.kind === 'withdraw' ? { vault: action.vault, recipient: action.target } : { output_commitment: action.target };
      const feeQuote = quoteFees(policy.denomination);
      await save(args[4], JSON.stringify({ contract: policy.registry, method: action.kind, args: { ...actionArgs, disclosure_root: action.disclosureRoot, ...proof.args }, depositYocto: action.kind === 'withdraw' ? feeQuote.withdrawalAttached : STORAGE_FEE.toString(), gasTgas: 300, feeQuote: catalog.pool.version === 3 ? quoteFtFees(policy.denomination) : feeQuote, checkedAtBlock: catalog.blockHash }, null, 2));
      output({ prepared: args[4], registry: policy.registry, selectedVault: action.vault });
      break;
    }
    case 'quote-usdc': {
      if (args.length !== 1) throw new Error('quote-usdc decimal-USDC-amount');
      output(quoteFtFees(parseUsdc(args[0]))); break;
    }
    case 'quote-fees': {
      if (args.length !== 1) throw new Error('quote-fees amount-in-yoctonear');
      output(quoteFees(args[0]));
      break;
    }
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
      const pool: Pool & { feeRecipient?: string } = await json(args[0]), vk = await json('artifacts/verification_key.json');
      domain(pool);
      if (!pool.feeRecipient) throw new Error('Set feeRecipient before preparing immutable deployment');
      domain({ network: pool.network, contract: pool.feeRecipient, denomination: '1' });
      if (pool.feeRecipient === pool.contract) throw new Error('Fee recipient cannot be the vault itself');
      output({ method: pool.version === 3 ? 'new_ft' : 'new', args: { ...(pool.version === 3 ? { token_id: pool.tokenId } : {}), network: pool.network, denomination: pool.denomination, verification_key: encodeVerificationKey(vk), fee_recipient: pool.feeRecipient }, depositYocto: (10n ** 24n).toString(), gasTgas: 300 });
      break;
    }
    case 'deposit-args': {
      if (args.length !== 3) throw new Error('deposit-args pool.json encrypted-note.json disclosure-root');
      const pool: Pool = await json(args[0]), note = await loadNote(args[1]);
      if (pool.version === 2 || pool.version === 3) throw new Error('Use shared-deposit-args to choose a verified physical vault');
      await validateNote(pool, note);
      const feeQuote = quoteFees(pool.denomination);
      output({ method: 'deposit', args: { commitment: note.commitment, disclosure_root: args[2] }, depositYocto: feeQuote.depositAttached, feeQuote, gasTgas: 300 });
      break;
    }
    case 'spend-args': {
      if (args.length !== 5) throw new Error('spend-args pool.json encrypted-note.json commitments.json action.json output.json');
      const pool: Pool = await json(args[0]), note = await loadNote(args[1]), action: Action = await json(args[3]);
      if (pool.version === 3) throw new Error('Use shared-spend-args for verified FT vault routing and token fee payment');
      const tree = await NoteTree.from(await json(args[2]));
      const proof = await proveSpend(pool, note, tree, action);
      const actionArgs = action.kind === 'transfer' ? { output_commitment: action.target } : { ...(pool.version === 2 ? { vault: action.vault } : {}), recipient: action.target };
      const feeQuote = quoteFees(pool.denomination);
      await save(args[4], JSON.stringify({ method: action.kind, args: { ...actionArgs, disclosure_root: action.disclosureRoot, ...proof.args }, depositYocto: action.kind === 'withdraw' ? feeQuote.withdrawalAttached : STORAGE_FEE.toString(), feeQuote, gasTgas: 300 }, null, 2));
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
      console.log('Commands: ft-preflight, settlement-status, settlement-wait, wallet, note, init-args, deposit-args, spend-args, receipt, disclose, verify-bundle, discover-vaults, create-vault-args, quote-fees, quote-usdc, discover-shared, shared-note, shared-deposit-args, shared-spend-args. See README.md.');
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exitCode = 1;
} finally {
  await shutdownProver();
}
