declare module "circomlibjs" {
  export function buildPoseidon(): Promise<any>;
}
declare module "snarkjs" {
  export const groth16: {
    fullProve(input: unknown, wasm: string, zkey: string, logger?: unknown, witnessOptions?: unknown, proverOptions?: unknown): Promise<{ proof: any; publicSignals: string[] }>;
    verify(vkey: unknown, signals: string[], proof: unknown): Promise<boolean>;
  };
}
