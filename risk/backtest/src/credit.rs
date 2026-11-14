//! `backtest credit <file>`: recomputes a pb-risk credit check (INTERFACES.md 18) natively from the inputs that
//! run read, and prints it. The file is either a snapshot, `{"result": ..., "inputs": ...}`, or the inputs alone.
//! For a snapshot it also checks the recomputed result against the one the enclave printed: the exit code is 0 if
//! they agree, 1 if not, 2 if the file can't be read.
//!
//! As `backtest verdict` does (INTERFACES.md 6), it prints the SHA-256 of the sorted-key form of the run's whole
//! output, which is the `output_hash` OutLayer's attestation shows: OutLayer's HTTPS API returns the output with its
//! keys sorted, and its attestation hashes that form. For a file of inputs alone, the output is the result alone.
use pb_risk::credit::{self, CreditInputs};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::process::ExitCode;

#[derive(Deserialize)]
struct Snapshot<'a> {
    #[serde(borrow)]
    result: Option<&'a RawValue>,
    #[serde(borrow)]
    inputs: &'a RawValue,
}

/// How a replay compares with the result a snapshot carries.
#[derive(Debug, PartialEq, Eq)]
pub enum Match {
    NothingToCompare,
    Identical,
    /// Same values, formatted differently (OutLayer's API sorts the keys).
    SameValues,
    Different(String),
}

/// A replay: the result, the run's whole output as the enclave printed it, and how it compares.
pub struct Replay {
    pub result: String,
    pub printed: String,
    pub matched: Match,
}

impl Replay {
    /// SHA-256 of the printed output with its keys sorted, written compactly.
    pub fn attested_hash(&self) -> String {
        let sorted: serde_json::Value =
            serde_json::from_str(&self.printed).expect("pb-risk prints JSON");
        pb_risk::util::sha256_hex(sorted.to_string().as_bytes())
    }
}

/// Recomputes the result from a snapshot's or an inputs file's text.
pub fn replay(text: &str) -> Result<Replay, String> {
    let (snapshot, claimed, inputs_text) = match serde_json::from_str::<Snapshot>(text) {
        Ok(s) => (true, s.result.map(RawValue::get), s.inputs.get()),
        Err(_) => (false, None, text.trim()),
    };
    let inputs: CreditInputs =
        serde_json::from_str(inputs_text).map_err(|e| format!("not credit-check inputs: {e}"))?;
    let ours = credit::output(&inputs);
    let printed = if snapshot {
        credit::snapshot(&inputs)
    } else {
        ours.clone()
    };
    let matched = match claimed {
        None => Match::NothingToCompare,
        Some(theirs) if theirs == ours => Match::Identical,
        Some(theirs) => {
            let parse = |s: &str| serde_json::from_str::<serde_json::Value>(s).ok();
            if parse(theirs).is_some() && parse(theirs) == parse(&ours) {
                Match::SameValues
            } else {
                Match::Different(theirs.to_string())
            }
        }
    };
    Ok(Replay {
        result: ours,
        printed,
        matched,
    })
}

pub fn run(path: &str) -> ExitCode {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            return ExitCode::from(2);
        }
    };
    let r = match replay(&text) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{path}: {e}");
            return ExitCode::from(2);
        }
    };
    println!("{}", r.result);
    eprintln!(
        "the output_hash its OutLayer attestation should show: {}",
        r.attested_hash()
    );
    match r.matched {
        Match::NothingToCompare => ExitCode::SUCCESS,
        Match::Identical => {
            eprintln!(
                "identical to the result in {path}, byte for byte ({} bytes)",
                r.result.len()
            );
            ExitCode::SUCCESS
        }
        Match::SameValues => {
            eprintln!(
                "the same values as the result in {path}, whose keys are in another order \
                 (OutLayer's HTTPS API sorts them)"
            );
            ExitCode::SUCCESS
        }
        Match::Different(theirs) => {
            eprintln!("DIFFERENT from the result in {path}, which is:\n{theirs}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../pb-risk/tests/fixtures/credit_worked.json"
        );
        std::fs::read_to_string(path).unwrap()
    }

    /// The worked example with the lender reads of INTERFACES.md 27, as pb-risk's credit tests wrote it.
    fn funding_fixture() -> String {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../pb-risk/tests/fixtures/credit_funding.json"
        );
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn a_snapshot_with_lender_reads_replays_its_funding_to_the_byte() {
        let text = funding_fixture();
        let r = replay(&text).unwrap();
        assert_eq!(r.matched, Match::Identical);
        assert_eq!(r.printed, text.trim_end());
        assert!(r.result.contains(r#""funding":{"line":94500000000,"#));
        // Aave's terms are part of what the result is computed from: with its liquidation threshold edited, the
        // lender's part changes and the copy is caught.
        let edited = text.replacen(
            r#""liquidationThreshold":{"value":"0.85"}"#,
            r#""liquidationThreshold":{"value":"0.80"}"#,
            1,
        );
        assert_ne!(edited, text);
        assert!(matches!(
            replay(&edited).unwrap().matched,
            Match::Different(_)
        ));
        // The same inputs with the lender reads taken out give the result of a run from before them.
        let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
        v["inputs"].as_object_mut().unwrap().remove("lenders");
        let bare = replay(&v["inputs"].to_string()).unwrap();
        assert!(!bare.result.contains("funding"));
    }

    #[test]
    fn the_worked_example_replays_to_the_byte() {
        let text = fixture();
        let r = replay(&text).unwrap();
        assert_eq!(r.matched, Match::Identical);
        assert_eq!(r.printed, text.trim_end());
        assert!(r
            .result
            .starts_with(r#"{"ok":true,"v":1,"mode":"credit_check""#));
        // The hash is of the sorted form, which differs from the printed bytes.
        let sorted = serde_json::from_str::<serde_json::Value>(&r.printed)
            .unwrap()
            .to_string();
        assert_ne!(sorted, r.printed);
        assert_eq!(
            r.attested_hash(),
            pb_risk::util::sha256_hex(sorted.as_bytes())
        );
    }

    #[test]
    fn copies_and_edits_are_told_apart() {
        let text = fixture();
        // As OutLayer's API returns it: keys sorted. Same values.
        let sorted = serde_json::from_str::<serde_json::Value>(&text)
            .unwrap()
            .to_string();
        assert_eq!(replay(&sorted).unwrap().matched, Match::SameValues);
        // The inputs alone: the result alone, nothing to compare.
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let bare = serde_json::to_string_pretty(&v["inputs"]).unwrap();
        let r = replay(&bare).unwrap();
        assert_eq!(r.matched, Match::NothingToCompare);
        assert_eq!(r.printed, r.result);
        // An edited result is caught, and so are edited inputs.
        let edited = text.replacen(r#""score":700"#, r#""score":800"#, 1);
        assert!(matches!(
            replay(&edited).unwrap().matched,
            Match::Different(_)
        ));
        let tampered = text.replacen(r#""usdc":"35000000000""#, r#""usdc":"45000000000""#, 2);
        assert!(matches!(
            replay(&tampered).unwrap().matched,
            Match::Different(_)
        ));
        assert!(replay("not json").is_err());
    }
}
