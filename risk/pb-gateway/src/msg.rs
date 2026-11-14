//! The messages the owner signs (INTERFACES.md 9) and Hyperliquid's rounding rules
//! (hyperliquid-docs/for-developers/api/tick-and-lot-size). An order exists only inside the signed message.
//!
//! The message must be exactly the compact JSON these types write, keys in this order, so what the wallet showed is
//! what runs: no duplicate keys, no extra fields, no other spelling of a number.
use serde::{Deserialize, Serialize};

/// The order fields, as the trade page builds them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderFields {
    pub coin: String,
    pub is_buy: bool,
    pub sz: String,
    pub limit_px: String,
    pub reduce_only: bool,
    pub tif: String,
}

/// `{"pb":"order","account":A,"order":{...},"expires_ms":<ms>}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderMessage {
    pub pb: String,
    pub account: String,
    pub order: OrderFields,
    pub expires_ms: u64,
}

/// The order to cancel: the coin and Hyperliquid's order id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelFields {
    pub coin: String,
    pub oid: u64,
}

/// `{"pb":"cancel","account":A,"cancel":{"coin":..,"oid":..},"expires_ms":<ms>}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelMessage {
    pub pb: String,
    pub account: String,
    pub cancel: CancelFields,
    pub expires_ms: u64,
}

/// Parses `text` as `T` and checks it is exactly `T`'s compact form.
pub fn parse_exact<T: Serialize + for<'de> Deserialize<'de>>(text: &str) -> Result<T, String> {
    let v: T = serde_json::from_str(text)
        .map_err(|e| format!("the signed message is not the gateway's message: {e}"))?;
    let canonical = serde_json::to_string(&v).expect("a message serialises");
    if canonical != text {
        return Err(format!(
            "the signed message must be exactly {canonical} (compact JSON, keys in that order)"
        ));
    }
    Ok(v)
}

/// A decimal string in Hyperliquid's wire form: digits with at most one point, no sign or exponent, no leading
/// zeros but the one before a point, and no trailing zeros after it (the SDK's `float_to_wire` writes this form,
/// and the docs ask signers to drop trailing zeros).
#[derive(Clone, Debug, PartialEq)]
pub struct Decimal {
    pub value: f64,
    /// Digits after the point.
    pub decimals: u32,
    /// Significant figures: the digits from the first nonzero one.
    pub sig_figs: u32,
}

pub fn decimal(s: &str, what: &str) -> Result<Decimal, String> {
    let bad = || {
        format!("{what} {s:?} must be a plain decimal like \"0.33\" or \"74500\": no sign, exponent, leading zeros or trailing zeros")
    };
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    if !digits(int) || (int.len() > 1 && int.starts_with('0')) {
        return Err(bad());
    }
    if let Some(f) = frac {
        if !digits(f) || f.ends_with('0') {
            return Err(bad());
        }
    }
    if s.len() > 30 {
        return Err(bad());
    }
    let all: String = format!("{int}{}", frac.unwrap_or(""));
    let sig_figs = all.trim_start_matches('0').len() as u32;
    let value: f64 = s.parse().map_err(|_| bad())?;
    Ok(Decimal {
        value,
        decimals: frac.map_or(0, |f| f.len() as u32),
        sig_figs,
    })
}

/// Hyperliquid's perp rules for one order, refusing (never rounding) anything else: a size with at most
/// `sz_decimals` decimals, above 0; a price above 0 with at most 5 significant figures and at most 6 − `sz_decimals`
/// decimals, though a whole number is always allowed; and at least $10 of notional.
pub fn check_rounding(
    sz: &str,
    limit_px: &str,
    sz_decimals: u32,
) -> Result<(Decimal, Decimal), String> {
    let size = decimal(sz, "sz")?;
    let price = decimal(limit_px, "limit_px")?;
    if size.value <= 0.0 {
        return Err("sz must be above 0".into());
    }
    if size.decimals > sz_decimals {
        return Err(format!(
            "sz {sz} has {} decimals; this coin takes at most {sz_decimals}",
            size.decimals
        ));
    }
    if price.value <= 0.0 {
        return Err("limit_px must be above 0".into());
    }
    let max_px_decimals = 6u32.saturating_sub(sz_decimals);
    if price.decimals > 0 && price.sig_figs > 5 {
        return Err(format!(
            "limit_px {limit_px} has {} significant figures; at most 5, unless it is a whole number",
            price.sig_figs
        ));
    }
    if price.decimals > max_px_decimals {
        return Err(format!(
            "limit_px {limit_px} has {} decimals; this coin takes at most {max_px_decimals}",
            price.decimals
        ));
    }
    if size.value * price.value < 10.0 {
        return Err(format!(
            "the order is ${:.2} of notional; the minimum is $10",
            size.value * price.value
        ));
    }
    Ok((size, price))
}

/// The times in force Hyperliquid takes for a limit order.
pub fn check_tif(tif: &str) -> Result<(), String> {
    match tif {
        "Gtc" | "Ioc" | "Alo" => Ok(()),
        other => Err(format!("tif {other:?} must be Gtc, Ioc or Alo")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_message_parses() {
        let text = r#"{"pb":"order","account":"alice.pbf.testnet","order":{"coin":"BTC","is_buy":false,"sz":"0.33","limit_px":"74500","reduce_only":false,"tif":"Ioc"},"expires_ms":1794000000000}"#;
        let m: OrderMessage = parse_exact(text).unwrap();
        assert_eq!(
            (m.order.coin.as_str(), m.expires_ms),
            ("BTC", 1794000000000)
        );
        // Spaces, another key order, an extra or a repeated key: refused.
        assert!(parse_exact::<OrderMessage>(&text.replace(",\"order\"", ", \"order\"")).is_err());
        let reordered = text.replace(
            r#""pb":"order","account":"alice.pbf.testnet""#,
            r#""account":"alice.pbf.testnet","pb":"order""#,
        );
        assert!(parse_exact::<OrderMessage>(&reordered)
            .unwrap_err()
            .contains("must be exactly"));
        assert!(parse_exact::<OrderMessage>(
            &text.replace("\"tif\":\"Ioc\"", "\"tif\":\"Ioc\",\"x\":1")
        )
        .is_err());
        let twice = text.replace(r#""coin":"BTC","#, r#""coin":"DOGE","coin":"BTC","#);
        assert!(parse_exact::<OrderMessage>(&twice).is_err());
        let c: CancelMessage = parse_exact(
            r#"{"pb":"cancel","account":"alice.pbf.testnet","cancel":{"coin":"BTC","oid":123},"expires_ms":5}"#,
        )
        .unwrap();
        assert_eq!(c.cancel.oid, 123);
    }

    #[test]
    fn decimals_must_be_in_wire_form() {
        assert_eq!(
            decimal("0.33", "sz").unwrap(),
            Decimal {
                value: 0.33,
                decimals: 2,
                sig_figs: 2
            }
        );
        assert_eq!(decimal("74500", "p").unwrap().sig_figs, 5);
        assert_eq!(decimal("0.001234", "p").unwrap().sig_figs, 4);
        for bad in [
            "", ".5", "5.", "0.330", "074500", "+1", "-1", "1e3", "1,5", " 1", "1.2.3", "0x10",
        ] {
            assert!(decimal(bad, "sz").is_err(), "{bad}");
        }
        assert!(decimal("0", "sz").is_ok());
    }

    #[test]
    fn rounding_follows_hyperliquid() {
        // BTC: szDecimals 5, so prices take 6 − 5 = 1 decimal and 5 significant figures.
        assert!(check_rounding("0.33", "74500", 5).is_ok());
        assert!(check_rounding("0.123456", "74500", 5)
            .unwrap_err()
            .contains("at most 5"));
        assert!(check_rounding("0.33", "74500.5", 5)
            .unwrap_err()
            .contains("significant"));
        assert!(check_rounding("0.33", "123456", 5).is_ok()); // whole numbers always pass
        assert!(check_rounding("1", "1234.5", 2).is_ok());
        assert!(check_rounding("1", "1234.56", 2)
            .unwrap_err()
            .contains("significant"));
        // The docs' examples: 0.001234 is fine at szDecimals 0; 0.0012345 has 7 decimals.
        assert!(check_rounding("10000", "0.001234", 0).is_ok());
        assert!(check_rounding("10000", "0.0012345", 0).is_err());
        assert!(check_rounding("1000", "0.01234", 1).is_ok());
        assert!(check_rounding("1000", "0.012345", 1)
            .unwrap_err()
            .contains("at most 5"));
        // $10 minimum, and positive.
        assert!(check_rounding("0.0001", "74500", 5)
            .unwrap_err()
            .contains("minimum is $10"));
        assert!(check_rounding("0", "74500", 5).is_err());
        assert!(check_tif("Ioc").is_ok() && check_tif("FOK").is_err());
    }
}
