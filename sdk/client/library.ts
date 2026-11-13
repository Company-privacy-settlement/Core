import { canonical, seal, unseal } from './crypto.js';
import { object, account } from './payment.js';
import { browserJournalStorage } from './journal.js';
import { verifySignedInvoice, invoiceHash, type SignedInvoice } from './invoices.js';
import type { Identity, JournalStorage } from './types.js';

const FORMAT = 'core-invoice-library';
export type StoredInvoice = { hash: string; signed: SignedInvoice; savedAt: string };
type Contents = { version: 1; owner: Identity; invoices: StoredInvoice[] };
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) throw new Error('Unexpected invoice library fields');
}
function identity(raw: unknown): Identity {
  const value = object(raw); exact(value, ['network', 'accountId']);
  if (value.network !== 'testnet' && value.network !== 'sandbox') throw new Error('Invalid library network');
  return { network: value.network, accountId: account(value.accountId) };
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid library invoice hash');
  return value;
}
async function validate(raw: unknown, owner: Readonly<Identity>): Promise<Contents> {
  const value = object(raw); exact(value, ['version', 'owner', 'invoices']);
  if (value.version !== 1 || canonical(identity(value.owner)) !== canonical(owner) || !Array.isArray(value.invoices))
    throw new Error('Invalid invoice library or different merchant/network');
  if (value.invoices.length > 100) throw new Error('Invoice library supports at most 100 saved requests; keep a backup before removing local copies');
  const invoices: StoredInvoice[] = [], ids = new Set<string>(), hashes = new Set<string>();
  for (const rawEntry of value.invoices) {
    const entry = object(rawEntry); exact(entry, ['hash', 'signed', 'savedAt']);
    const signed = await verifySignedInvoice(entry.signed), hash = digest(entry.hash);
    if (signed.invoice.merchantAccount !== owner.accountId || signed.invoice.policy.network !== owner.network || await invoiceHash(signed.invoice) !== hash || ids.has(signed.invoice.id) || hashes.has(hash))
      throw new Error('Invoice library identity, integrity or uniqueness mismatch');
    if (typeof entry.savedAt !== 'string' || !Number.isFinite(Date.parse(entry.savedAt)) || new Date(entry.savedAt).toISOString() !== entry.savedAt) throw new Error('Invalid invoice save time');
    ids.add(signed.invoice.id); hashes.add(hash);
    invoices.push({ hash, signed, savedAt: entry.savedAt });
  }
  return { version: 1, owner: identity(owner), invoices };
}

/** Local encrypted terms only. No chain calls, payment-status cache or signing authority. */
export class InvoiceLibrary {
  readonly owner: Readonly<Identity>;
  private generation = 0;
  constructor(readonly storage: JournalStorage, private password: string, owner: Identity) { this.owner = Object.freeze(identity(owner)); }
  lock() { this.generation++; this.password = ''; }
  private async access<T>(action: (password: string, check: () => void) => Promise<T>): Promise<T> {
    const current = this.generation, password = this.password;
    const check = () => { if (!password || !this.password || current !== this.generation) throw new Error('Invoice library is locked'); };
    check();
    return this.storage.exclusive(async () => { check(); return action(password, check); });
  }
  private async read(password: string, check: () => void) {
    const envelope = await this.storage.read(); check();
    if (envelope === null) throw new Error('Create or restore an encrypted invoice library first');
    const data = await this.decode(envelope, password); check(); return { envelope, data };
  }
  private async decode(envelope: string, password: string) {
    try { return await validate(await unseal(envelope, password, FORMAT), this.owner); }
    catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'OperationError') throw new Error('Could not decrypt invoice library. Check the passphrase and backup integrity.');
      throw error;
    }
  }
  private async write(data: Contents, password: string, check: () => void) {
    const validated = await validate(data, this.owner); check();
    const envelope = await seal(validated, password, FORMAT); check();
    await this.storage.write(envelope); check();
  }
  create() {
    return this.access(async (password, check) => {
      if (await this.storage.read() !== null) throw new Error('A library already exists; unlock or merge a backup instead');
      check(); await this.write({ version: 1, owner: identity(this.owner), invoices: [] }, password, check);
    });
  }
  list() {
    return this.access(async (password, check) => {
      const { data } = await this.read(password, check);
      return data.invoices.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.hash.localeCompare(b.hash));
    });
  }
  add(raw: unknown) {
    return this.access(async (password, check) => {
      const { data } = await this.read(password, check), signed = await verifySignedInvoice(raw), hash = await invoiceHash(signed.invoice);
      check();
      if (signed.invoice.merchantAccount !== this.owner.accountId || signed.invoice.policy.network !== this.owner.network) throw new Error('Invoice belongs to a different merchant or network');
      const existing = data.invoices.find(e => e.signed.invoice.id === signed.invoice.id || e.hash === hash);
      if (existing) {
        if (existing.hash !== hash || canonical(existing.signed) !== canonical(signed)) throw new Error('Invoice ID already has different signed terms or signature');
        return existing;
      }
      const entry = { hash, signed, savedAt: new Date().toISOString() };
      data.invoices.push(entry); await this.write(data, password, check); return entry;
    });
  }
  remove(hash: string) {
    return this.access(async (password, check) => {
      digest(hash); const { data } = await this.read(password, check), remaining = data.invoices.filter(e => e.hash !== hash);
      if (remaining.length === data.invoices.length) throw new Error('Invoice is not in this library');
      data.invoices = remaining; await this.write(data, password, check);
    });
  }
  export() { return this.access(async (password, check) => (await this.read(password, check)).envelope); }
  restore(envelope: string) {
    return this.access(async (password, check) => {
      if (await this.storage.read() !== null) throw new Error('Restore requires empty storage; unlock the existing library and merge instead');
      const data = await this.decode(envelope, password); check(); await this.write(data, password, check);
    });
  }
  merge(envelope: string, backupPassword?: string) {
    return this.access(async (password, check) => {
      const { data } = await this.read(password, check), incoming = await this.decode(envelope, backupPassword ?? password);
      for (const entry of incoming.invoices) {
        const existing = data.invoices.find(e => e.signed.invoice.id === entry.signed.invoice.id || e.hash === entry.hash);
        if (existing) {
          if (existing.hash !== entry.hash || canonical(existing.signed) !== canonical(entry.signed)) throw new Error('Backup conflicts with an immutable saved invoice');
        } else data.invoices.push(entry);
      }
      await this.write(data, password, check);
    });
  }
}
export function browserInvoiceLibraryStorage(owner: Identity): JournalStorage {
  const parsed = identity(owner);
  return browserJournalStorage(`core-invoice-library-v1:${parsed.network}:${parsed.accountId}`, 'Invoice library');
}
