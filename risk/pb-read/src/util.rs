//! Small helpers: hashing, base64 for NEAR view arguments, reading numbers out of contract JSON, and turning
//! dollars into the verdict's integers.
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Lowercase hex of the SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Standard base64 with padding (NEAR's `args_base64`).
pub fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// A `u64` written as a JSON number or as a decimal string (contracts write U64 as strings).
pub fn u64_of(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// A `u128` written as a decimal string (U128) or a JSON number.
pub fn u128_of(v: &Value) -> Option<u128> {
    match v {
        Value::Number(n) => n.as_u64().map(u128::from),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// A finite `f64` written as a JSON number or a decimal string (exchanges write prices as strings).
pub fn f64_of(v: &Value) -> Option<f64> {
    let x = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse().ok()?,
        _ => return None,
    };
    x.is_finite().then_some(x)
}

/// 10^d as an `f64`, for every count of decimals a token may have (the factory and the config take up to 24;
/// wNEAR has 24).
///
/// It is built from integers, so every platform gets the same bits: the integer power is exact, and its
/// conversion to `f64` is Rust's own `as` cast, which rounds to the nearest `f64` (ties to even) and for a
/// 128-bit integer is done in software, in the enclave as natively.
/// - d ≤ 22: exact. 10^22 is the largest power of ten an `f64` holds exactly.
/// - 23 ≤ d ≤ 38: the nearest `f64` to 10^d, a relative error under 2^-53. 10^38 is the largest a `u128` holds.
/// - d > 38: no token has that many. The product of two such values, so still the same everywhere.
///
/// Until 14 Nov this stopped at 10^22, so a token with 24 decimals was read 100 times too large (INTERFACES.md
/// 50.6).
pub fn pow10(d: u32) -> f64 {
    let whole = 10u128.pow(d.min(38)) as f64;
    if d <= 38 {
        whole
    } else {
        whole * pow10(d - 38)
    }
}

/// Integers in the verdict saturate here: about $9 trillion in micro-USD, far beyond any real amount.
pub const MICRO_CAP: f64 = 9.0e18;

/// Dollars to micro-USD, rounded down (equity, allowances: against the client).
pub fn micro_down(x: f64) -> i64 {
    clamp_i64((x * 1e6).floor())
}

/// Dollars to micro-USD, rounded up (requirements, the top-up: against the client).
pub fn micro_up(x: f64) -> i64 {
    clamp_i64((x * 1e6).ceil())
}

/// Dollars the engine has already rounded to micro-USD, back to the integer it stands for.
pub fn micro_exact(x: f64) -> i64 {
    clamp_i64((x * 1e6).round())
}

fn clamp_i64(x: f64) -> i64 {
    if x.is_nan() {
        0
    } else {
        x.clamp(-MICRO_CAP, MICRO_CAP) as i64
    }
}

/// Ratios in the verdict are basis points, rounded to the nearest, at most this (100×).
pub const BP_CAP: u64 = 1_000_000;

/// A ratio in basis points, rounded to the nearest; infinite or huge ratios show as [`BP_CAP`].
pub fn bp(x: f64) -> u64 {
    if x.is_nan() || x <= 0.0 {
        return 0;
    }
    let v = (x * 1e4).round();
    if v >= BP_CAP as f64 {
        BP_CAP
    } else {
        v as u64
    }
}

/// The text of a contract error or RPC error, at most `max` characters.
pub fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_and_base64_match_known_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"{}"), "e30=");
        assert_eq!(
            base64(br#"{"account_id":"a.pbf.testnet"}"#),
            "eyJhY2NvdW50X2lkIjoiYS5wYmYudGVzdG5ldCJ9"
        );
    }

    #[test]
    fn numbers_come_as_strings_or_numbers() {
        assert_eq!(u64_of(&Value::from("123")), Some(123));
        assert_eq!(u64_of(&Value::from(7u64)), Some(7));
        assert_eq!(u64_of(&Value::from("x")), None);
        assert_eq!(
            u128_of(&Value::from("340282366920938463463374607431768211455")),
            Some(u128::MAX)
        );
        assert_eq!(f64_of(&Value::from("75988.93000000")), Some(75988.93));
        assert_eq!(f64_of(&Value::from("NaN")), None);
        assert_eq!(pow10(8), 100_000_000.0);
    }

    #[test]
    fn the_power_of_ten_is_the_true_one_for_every_count_of_decimals_a_token_may_have() {
        // Exact up to 10^22, as it always was.
        assert_eq!(pow10(0), 1.0);
        assert_eq!(pow10(6), 1_000_000.0);
        assert_eq!(pow10(18), 1e18);
        assert_eq!(pow10(22), 1e22);
        assert_eq!(pow10(22), 10_000_000_000_000_000_000_000u128 as f64);
        // Past it, the nearest f64 to the true power: what the literal is, too. It stopped at 10^22 before.
        assert_eq!(pow10(23), 1e23);
        assert_eq!(pow10(24), 1e24);
        assert_eq!(pow10(24) / pow10(22), 100.0);
        assert_eq!(pow10(38), 1e38);
        for d in 0..=38u32 {
            assert_eq!(pow10(d), format!("1e{d}").parse::<f64>().unwrap(), "{d}");
        }
        // Past what a u128 holds: still the power, within a rounding step, and never a wrapped integer.
        for d in [39u32, 40, 48, 76, 100] {
            let want: f64 = format!("1e{d}").parse().unwrap();
            assert!((pow10(d) / want - 1.0).abs() < 1e-15, "{d}");
        }
        // 346.1 units of a token with 24 decimals, as wNEAR has: 346.1, not 34,610.
        let raw = 346_100_000_000_000_000_000_000_000u128;
        assert!((raw as f64 / pow10(24) - 346.1).abs() < 1e-12);
        assert!((346.1 * pow10(24) / raw as f64 - 1.0).abs() < 1e-15);
    }

    #[test]
    fn rounding_goes_against_the_client() {
        assert_eq!(micro_down(1.0000004), 1_000_000);
        assert_eq!(micro_up(1.0000004), 1_000_001);
        assert_eq!(micro_down(-1.0000004), -1_000_001);
        assert_eq!(micro_exact(94_500.0), 94_500_000_000);
        assert_eq!(bp(0.74074), 7407);
        assert_eq!(bp(4.938271604938271), 49383);
        assert_eq!(bp(f64::INFINITY), BP_CAP);
        assert_eq!(bp(-0.1), 0);
    }
}
