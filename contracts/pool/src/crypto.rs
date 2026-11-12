use ark_bn254::{Fq, Fr};
use ark_ff::{BigInteger, PrimeField};
use light_poseidon::{Poseidon, PoseidonHasher, PoseidonParameters};
use near_sdk::{env, require};
use std::str::FromStr;

pub type Field = [u8; 32];
pub fn parse(value: &str) -> Field {
    require!(
        !value.is_empty()
            && value.bytes().all(|c| c.is_ascii_digit())
            && (value == "0" || !value.starts_with('0')),
        "Non-canonical field"
    );
    let n = Fr::from_str(value).unwrap_or_else(|_| env::panic_str("Field out of range"));
    require!(n.to_string() == value, "Field out of range");
    to_bytes(n)
}
pub fn to_bytes(n: Fr) -> Field {
    let mut out = [0u8; 32];
    let b = n.into_bigint().to_bytes_le();
    out[..b.len()].copy_from_slice(&b);
    out
}
pub fn decimal(n: &Field) -> String {
    Fr::from_le_bytes_mod_order(n).to_string()
}
pub fn sha_field(value: &str) -> Field {
    let mut h = env::sha256_array(value.as_bytes());
    h[0] &= 0x1f;
    h.reverse();
    h
}
pub fn poseidon(left: &Field, right: &Field) -> Field {
    let constants = include_bytes!("poseidon-t3.bin");
    let values: Vec<Fr> = constants
        .chunks_exact(32)
        .map(Fr::from_le_bytes_mod_order)
        .collect();
    let ark = values[..195].to_vec();
    let mds = values[195..]
        .chunks_exact(3)
        .map(|row| row.to_vec())
        .collect();
    let mut h = Poseidon::<Fr>::new(PoseidonParameters::new(ark, mds, 8, 57, 3, 5));
    to_bytes(
        h.hash(&[
            Fr::from_le_bytes_mod_order(left),
            Fr::from_le_bytes_mod_order(right),
        ])
        .expect("Poseidon hash"),
    )
}
fn canonical_fq(bytes: &[u8]) -> bool {
    let n = Fq::from_le_bytes_mod_order(bytes);
    n.into_bigint().to_bytes_le() == bytes
}
pub fn validate_vk(vk: &[u8]) {
    require!(vk.len() == 832, "Expected five-input Groth16 key");
    require!(
        vk.chunks_exact(32).all(canonical_fq),
        "Non-canonical key coordinate"
    );
    require!(
        vk.chunks(64).any(|x| x.iter().any(|b| *b != 0)),
        "Empty key"
    );
}
pub fn verify(vk: &[u8], proof: &[u8], inputs: &[Field]) -> bool {
    if proof.len() != 256 || inputs.len() != 5 || !proof.chunks_exact(32).all(canonical_fq) {
        return false;
    }
    if proof[..64].iter().all(|b| *b == 0)
        || proof[64..192].iter().all(|b| *b == 0)
        || proof[192..].iter().all(|b| *b == 0)
    {
        return false;
    }
    let mut multiexp = Vec::with_capacity(6 * 96);
    for i in 0..6 {
        multiexp.extend_from_slice(&vk[448 + i * 64..448 + (i + 1) * 64]);
        if i == 0 {
            let mut one = [0u8; 32];
            one[0] = 1;
            multiexp.extend_from_slice(&one);
        } else {
            multiexp.extend_from_slice(&inputs[i - 1]);
        }
    }
    let acc = env::alt_bn128_g1_multiexp(multiexp);
    let mut neg_a = proof[..64].to_vec();
    use ark_ff::Zero;
    let y = Fq::from_le_bytes_mod_order(&proof[32..64]);
    if !y.is_zero() {
        neg_a[32..].copy_from_slice(&(-y).into_bigint().to_bytes_le());
    }
    let mut pairs = Vec::with_capacity(4 * 192);
    pairs.extend_from_slice(&neg_a);
    pairs.extend_from_slice(&proof[64..192]);
    pairs.extend_from_slice(&vk[..64]);
    pairs.extend_from_slice(&vk[64..192]);
    pairs.extend_from_slice(&acc);
    pairs.extend_from_slice(&vk[192..320]);
    pairs.extend_from_slice(&proof[192..256]);
    pairs.extend_from_slice(&vk[320..448]);
    env::alt_bn128_pairing_check(pairs)
}
