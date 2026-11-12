pragma circom 2.1.6;
include "circomlib/circuits/poseidon.circom";

// One fixed-denomination note in, one note OR one public withdrawal out.
// The receiver generates the output note; the payer never learns its secrets.
template Spend(depth) {
    signal input root;
    signal input contextHash;
    signal input domain;
    signal input secret;
    signal input nullifier;
    signal input siblings[depth];
    signal input pathIndices[depth];
    signal output nullifierHash;
    signal output authorization;

    component note = Poseidon(3);
    note.inputs[0] <== secret;
    note.inputs[1] <== nullifier;
    note.inputs[2] <== domain;

    signal hashes[depth + 1];
    signal left[depth];
    signal right[depth];
    component nodes[depth];
    hashes[0] <== note.out;
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
        left[i] <== hashes[i] + pathIndices[i] * (siblings[i] - hashes[i]);
        right[i] <== siblings[i] + pathIndices[i] * (hashes[i] - siblings[i]);
        nodes[i] = Poseidon(2);
        nodes[i].inputs[0] <== left[i];
        nodes[i].inputs[1] <== right[i];
        hashes[i + 1] <== nodes[i].out;
    }
    hashes[depth] === root;

    component spent = Poseidon(2);
    spent.inputs[0] <== nullifier;
    spent.inputs[1] <== domain;
    nullifierHash <== spent.out;

    // Cryptographically bind context even though the circuit does not parse it.
    // Contract recomputes context from action, recipient/output, receipt and pool.
    component auth = Poseidon(2);
    auth.inputs[0] <== nullifier;
    auth.inputs[1] <== contextHash;
    authorization <== auth.out;
}

// Order: nullifierHash, authorization, root, contextHash, domain.
component main {public [root, contextHash, domain]} = Spend(8);
