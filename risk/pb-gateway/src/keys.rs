//! The agent key of each client account (INTERFACES.md 9): `HKDF-SHA256(ikm = seed, salt = empty,
//! info = "hl-agent-v1:" + account)`, 32 bytes, taken as a secp256k1 scalar. A value of 0 or at least the curve order
//! is refused, never reduced. The seed is `PROTECTED_PB_AGENT_SEED`, 32 bytes as 64 hex digits, generated inside
//! OutLayer (research/outlayer.md, "The gateway's seed").
use hkdf::Hkdf;
use k256::ecdsa::SigningKey;
use sha2::Sha256;

/// The environment variable OutLayer puts the seed in. Generated secrets must start with `PROTECTED_`.
pub const SEED_VAR: &str = "PROTECTED_PB_AGENT_SEED";

/// The HKDF info prefix; the account id follows it.
pub const INFO_PREFIX: &str = "hl-agent-v1:";

/// The seed from its hex form: exactly 64 hex digits.
pub fn parse_seed(hex: &str) -> Result<[u8; 32], String> {
    let hex = hex.trim();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the agent seed is not 32 bytes of hex".into());
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).map_err(|_| "bad hex")?;
    }
    Ok(out)
}

/// HKDF-SHA256 with an empty salt: `len` bytes for `info`.
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], len: usize) -> Result<Vec<u8>, String> {
    // RFC 5869 2.2: an empty salt is the same as HashLen zero bytes; hkdf's `None` is that.
    let salt = if salt.is_empty() { None } else { Some(salt) };
    let hk = Hkdf::<Sha256>::new(salt, ikm);
    let mut okm = vec![0u8; len];
    hk.expand(info, &mut okm)
        .map_err(|_| "HKDF output too long".to_string())?;
    Ok(okm)
}

/// The agent key for `account`.
pub fn agent_key(seed: &[u8; 32], account: &str) -> Result<SigningKey, String> {
    let okm = hkdf_sha256(seed, &[], format!("{INFO_PREFIX}{account}").as_bytes(), 32)?;
    // from_slice refuses 0 and any value at or above the order n.
    SigningKey::from_slice(&okm).map_err(|_| {
        format!("the agent key for {account} is 0 or not below the curve order; it can't be used")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hlsign::{address, hex};

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn hkdf_matches_rfc_5869() {
        // Appendix A.1, test case 1.
        let okm = hkdf_sha256(
            &[0x0b; 22],
            &unhex("000102030405060708090a0b0c"),
            &unhex("f0f1f2f3f4f5f6f7f8f9"),
            42,
        )
        .unwrap();
        assert_eq!(
            hex(&okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
        // Test case 2: longer inputs.
        let ikm: Vec<u8> = (0x00..=0x4f).collect();
        let salt: Vec<u8> = (0x60..=0xaf).collect();
        let info: Vec<u8> = (0xb0..=0xff).collect();
        assert_eq!(
            hex(&hkdf_sha256(&ikm, &salt, &info, 82).unwrap()),
            "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09\
             da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87"
        );
        // Test case 3: no salt and no info, as the agent key has no salt.
        assert_eq!(
            hex(&hkdf_sha256(&[0x0b; 22], &[], &[], 42).unwrap()),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
        );
    }

    #[test]
    fn agent_keys_are_per_account_and_stable() {
        let seed = parse_seed(&"11".repeat(32)).unwrap();
        let a = address(&agent_key(&seed, "alice.pbf.testnet").unwrap());
        let b = address(&agent_key(&seed, "bob.pbf.testnet").unwrap());
        assert_ne!(a, b);
        assert_eq!(a, address(&agent_key(&seed, "alice.pbf.testnet").unwrap()));
        assert!(a.starts_with("0x") && a.len() == 42 && a == a.to_lowercase());
        // The key is the HKDF output itself, used as the scalar.
        let okm = hkdf_sha256(&seed, &[], b"hl-agent-v1:alice.pbf.testnet", 32).unwrap();
        assert_eq!(
            agent_key(&seed, "alice.pbf.testnet")
                .unwrap()
                .to_bytes()
                .as_slice(),
            okm.as_slice()
        );
        assert!(parse_seed("abcd").is_err());
        assert!(parse_seed(&"zz".repeat(32)).is_err());
    }
}
