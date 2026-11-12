# Third-party components

This repository depends on circomlib / circomlibjs / snarkjs (iden3), light-poseidon (Light Protocol), Arkworks, near-sdk and near-workspaces. Their respective licenses and notices apply; this repository does not relicense those dependencies.

The mathematical Poseidon t=3 constants in `contracts/pool/src/poseidon-t3.bin` are exported from circomlibjs's BN254 parameters and are compatible with light-poseidon. The export script and cross-language test vectors are included for reproducibility. Circuit includes resolve from the installed circomlib package.

No project-wide distribution license has been chosen by the repository owner.
