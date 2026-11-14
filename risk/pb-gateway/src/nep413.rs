//! NEP-413, NEAR's standard for signing a message off-chain (`signMessage`; research/outlayer.md, "NEP-413"). The wallet
//! signs sha256(borsh(u32 2^31 + 413) ‖ borsh(Payload{message, nonce: [u8; 32], recipient, callbackUrl: None}))
//! with a full-access ed25519 key. Borsh writes a u32 little-endian, a string as its u32 length then its bytes, and
//! `None` as one 0 byte.
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// 2^31 + 413.
pub const TAG: u32 = 2_147_484_061;

/// The recipient the gateway's messages must name.
pub const RECIPIENT: &str = "pb-gateway";

/// What the browser sends with an order or a cancel (INTERFACES.md 9).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    pub owner: String,
    /// `ed25519:<base58 of 32 bytes>`.
    pub public_key: String,
    /// Base64 of the 64-byte signature.
    pub signature: String,
    /// The exact string signed.
    pub message: String,
    /// Base64 of the 32-byte nonce.
    pub nonce: String,
    pub recipient: String,
}

/// borsh(string): its length as a little-endian u32, then its bytes.
fn borsh_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// The 32 bytes the wallet signs.
pub fn payload_hash(
    message: &str,
    nonce: &[u8; 32],
    recipient: &str,
    callback_url: Option<&str>,
) -> [u8; 32] {
    let mut data = Vec::with_capacity(4 + 4 + message.len() + 32 + 4 + recipient.len() + 1);
    data.extend_from_slice(&TAG.to_le_bytes());
    borsh_string(&mut data, message);
    data.extend_from_slice(nonce);
    borsh_string(&mut data, recipient);
    match callback_url {
        None => data.push(0),
        Some(url) => {
            data.push(1);
            borsh_string(&mut data, url);
        }
    }
    Sha256::digest(&data).into()
}

/// The 32 bytes of an `ed25519:<base58>` public key.
pub fn ed25519_key(public_key: &str) -> Result<[u8; 32], String> {
    let b58 = public_key
        .strip_prefix("ed25519:")
        .ok_or("the public key must be ed25519:<base58>")?;
    let bytes = bs58::decode(b58)
        .into_vec()
        .map_err(|_| "the public key is not base58")?;
    bytes
        .try_into()
        .map_err(|_| "an ed25519 public key is 32 bytes".to_string())
}

/// The nonce's 32 bytes, from base64.
pub fn nonce_bytes(nonce_b64: &str) -> Result<[u8; 32], String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(nonce_b64)
        .map_err(|_| "the nonce is not base64")?;
    bytes
        .try_into()
        .map_err(|_| "the nonce must be 32 bytes".to_string())
}

/// Checks the signature: the right recipient, a 32-byte nonce, and an ed25519 signature by `public_key` over the
/// payload hash. Strict verification refuses small-order keys and non-canonical signatures. Returns the nonce.
pub fn verify(auth: &Auth) -> Result<[u8; 32], String> {
    if auth.recipient != RECIPIENT {
        return Err(format!(
            "the message is for {:?}, not {RECIPIENT:?}",
            auth.recipient
        ));
    }
    let nonce = nonce_bytes(&auth.nonce)?;
    let key = VerifyingKey::from_bytes(&ed25519_key(&auth.public_key)?)
        .map_err(|_| "the public key is not a valid ed25519 key")?;
    let sig_bytes: [u8; 64] = base64::engine::general_purpose::STANDARD
        .decode(&auth.signature)
        .map_err(|_| "the signature is not base64")?
        .try_into()
        .map_err(|_| "the signature must be 64 bytes")?;
    let sig = Signature::from_bytes(&sig_bytes);
    let hash = payload_hash(&auth.message, &nonce, &auth.recipient, None);
    key.verify_strict(&hash, &sig)
        .map_err(|_| "the signature does not match the message and key".to_string())?;
    Ok(nonce)
}

#[cfg(test)]
pub(crate) mod tests {
    //! Vectors from near-api-js's own tests (`test/unit/signers/key_pair_signer.test.ts`, commit 08d29f44): its
    //! signer, for this key, gives these signatures and this hash.
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const SECRET: &str =
        "3FyRtUUMxiNT1g2ST6mbj7W1CN7KfQBbomawC7YG4A1zwHmw2TRsn1Wc8NaFcBCoJDu3zt3znJDSwKQ31oRaKXH7";
    const NONCE: &str = "KNV0cOpvJ50D5vfF9pqWom8wo2sliQ4W+Wa7uZ3Uk6Y=";

    fn signing_key() -> SigningKey {
        // A NEAR secret key is the 32-byte seed followed by the 32-byte public key.
        let bytes = bs58::decode(SECRET).into_vec().unwrap();
        SigningKey::from_bytes(&bytes[..32].try_into().unwrap())
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn public_key() -> String {
        format!(
            "ed25519:{}",
            bs58::encode(signing_key().verifying_key().as_bytes()).into_string()
        )
    }

    #[test]
    fn the_payload_hash_matches_near_api_js() {
        let nonce = nonce_bytes(NONCE).unwrap();
        // 'generate correct hash for NEP-413-compliant message'.
        let h = payload_hash("Hello NEAR!", &nonce, "round-toad.testnet", None);
        assert_eq!(
            h.to_vec(),
            vec![
                1, 152, 236, 223, 103, 218, 230, 0, 34, 54, 210, 18, 244, 68, 108, 252, 140, 166,
                102, 57, 242, 4, 202, 234, 205, 94, 246, 245, 198, 141, 23, 250
            ]
        );
    }

    #[test]
    fn signatures_match_near_api_js() {
        let k = signing_key();
        let nonce = nonce_bytes(NONCE).unwrap();
        // 'test sign NEP-413 message without callback url'.
        let h = payload_hash("Hello NEAR!", &nonce, "example.near", None);
        assert_eq!(
            b64(&k.sign(&h).to_bytes()),
            "NnJgPU1Ql7ccRTITIoOVsIfElmvH1RV7QAT4a9Vh6ShCOnjIzRwxqX54JzoQ/nK02p7VBMI2vJn48rpImIJwAw=="
        );
        // 'test sign NEP-413 message with callback url'.
        let h = payload_hash(
            "Hello NEAR!",
            &nonce,
            "example.near",
            Some("http://localhost:3000"),
        );
        assert_eq!(
            b64(&k.sign(&h).to_bytes()),
            "zzZQ/GwAjrZVrTIFlvmmQbDQHllfzrr8urVWHaRt5cPfcXaCSZo35c5LDpPpTKivR6BxLyb3lcPM0FfCW5lcBQ=="
        );
    }

    /// An Auth for `message`, signed by the test key, for `recipient`.
    pub(crate) fn signed(message: &str, recipient: &str, nonce: [u8; 32]) -> Auth {
        let k = signing_key();
        let sig = k.sign(&payload_hash(message, &nonce, recipient, None));
        Auth {
            owner: "round-toad.testnet".into(),
            public_key: public_key(),
            signature: b64(&sig.to_bytes()),
            message: message.into(),
            nonce: b64(&nonce),
            recipient: recipient.into(),
        }
    }

    #[test]
    fn verify_accepts_the_signed_message_only() {
        let good = signed(r#"{"pb":"order"}"#, RECIPIENT, [7; 32]);
        assert_eq!(verify(&good), Ok([7; 32]));
        let mut changed = good.clone();
        changed.message.push(' ');
        assert!(verify(&changed).unwrap_err().contains("does not match"));
        let other_recipient = signed(r#"{"pb":"order"}"#, "evil.near", [7; 32]);
        assert!(verify(&other_recipient)
            .unwrap_err()
            .contains("not \"pb-gateway\""));
        let mut short_nonce = good.clone();
        short_nonce.nonce = b64(&[1; 28]);
        assert!(verify(&short_nonce).unwrap_err().contains("32 bytes"));
        let mut bad_key = good;
        bad_key.public_key = "secp256k1:abc".into();
        assert!(verify(&bad_key).is_err());
    }
}
