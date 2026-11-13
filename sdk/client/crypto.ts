export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  throw new Error("Unsupported public JSON value");
}
const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256(value: string): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
export async function shaField(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  bytes[0] &= 0x1f;
  return BigInt(`0x${hex(bytes)}`).toString();
}
function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function bytes(value: unknown, max: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    value.length > max * 2 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Invalid encrypted journal encoding");
  const b = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (b.length > max) throw new Error("Journal is too large");
  return b;
}
const ITERATIONS = 250_000;
type StorageFormat = 'core-operation-journal' | 'core-invoice-library' | 'core-private-note';
function storageContext(format: StorageFormat) {
  if (format !== 'core-operation-journal' && format !== 'core-invoice-library' && format !== 'core-private-note') throw new Error('Unsupported encrypted storage format');
  return new TextEncoder().encode(format === 'core-operation-journal' ? 'core:operation-journal:v1' : format === 'core-invoice-library' ? 'core:invoice-library:v1' : 'core:private-note:v1');
}
async function key(password: string, salt: Uint8Array<ArrayBuffer>) {
  if (password.length < 12 || password.length > 1024)
    throw new Error("Use a passphrase of 12–1024 characters");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(value: unknown, password: string, format: StorageFormat = 'core-operation-journal'): Promise<string> {
  const plaintext = new TextEncoder().encode(canonical(value));
  if (plaintext.length > 2_000_000) throw new Error("Encrypted storage exceeds 2 MB");
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: storageContext(format) },
    await key(password, salt),
    plaintext,
  );
  return JSON.stringify({
    format,
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: base64(salt),
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(encrypted)),
  });
}
export async function unseal(
  envelope: string,
  password: string,
  format: StorageFormat = 'core-operation-journal',
): Promise<unknown> {
  if (envelope.length > 3_000_000) throw new Error("Encrypted backup exceeds 3 MB");
  const e = JSON.parse(envelope);
  if (
    !e || typeof e !== 'object' || Array.isArray(e) ||
    Object.keys(e).sort().join('|') !== 'ciphertext|format|iterations|iv|kdf|salt|version' ||
    e.format !== format ||
    e.version !== 1 ||
    e.kdf !== "PBKDF2-SHA256" ||
    e.iterations !== ITERATIONS
  )
    throw new Error("Unsupported encrypted storage envelope");
  const salt = bytes(e.salt, 16),
    iv = bytes(e.iv, 12);
  if (salt.length !== 16 || iv.length !== 12)
    throw new Error("Invalid journal salt or IV");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: storageContext(format) },
    await key(password, salt),
    bytes(e.ciphertext, 2_000_016),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
