declare module "circomlibjs" {
  export function buildPoseidon(): Promise<any>;
}
declare module "snarkjs" {
  export const groth16: {
    fullProve(input: unknown, wasm: string, zkey: string, logger?: unknown, witnessOptions?: unknown, proverOptions?: unknown): Promise<{ proof: any; publicSignals: string[] }>;
    verify(vkey: unknown, signals: string[], proof: unknown): Promise<boolean>;
    prove(zkey: Uint8Array, witness: unknown): Promise<{ proof: unknown; publicSignals: string[] }>;
  };
  export const curves: { getCurveFromName(name: string, options: { singleThread: boolean }): Promise<unknown> };
  export const wtns: { calculate(input: unknown, wasm: Uint8Array, output: unknown, options: { memorySize: number }): Promise<void> };
}
