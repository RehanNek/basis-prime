//! Backtest CLI (PLAN.md 10). Two subcommands:
//!
//!     cargo run -p backtest --release -- examples
//!
//! prints RISK_ENGINE.md 13's worked examples as risk-core computes them, line for line as the Python
//! reference prints them (`risk_engine_ref.py ... examples`), and checks every line against the reference's
//! printout saved in `research/data/reference_cases.json`. A line that differs is followed by the
//! reference's. The exit code is 1 if any line differs.
//!
//!     cargo run -p backtest --release -- verdict <inputs.json>
//!
//! recomputes a pb-risk verdict natively from the inputs that run read (INTERFACES.md 6) and prints it. The
//! file is either a preview's snapshot, `{"verdict": ..., "inputs": ...}`, or the inputs alone. For a snapshot
//! it also checks the recomputed verdict against the one the enclave printed: the exit code is 0 if they agree,
//! 1 if not, 2 if the file can't be read. OutLayer's worker re-serialises a run's JSON output with its keys sorted:
//! that is what its HTTPS API returns, and what its attestation hashes. So a copy saved from the API agrees in
//! values, not bytes, and the tool prints the SHA-256 of the sorted form of the run's whole output, which equals the
//! `output_hash` of the run's attestation (`/attestations/by-call/<call id>`). For a file of inputs alone, that is
//! the output of a run without a snapshot: the verdict alone.
//!
//!     cargo run -p backtest --release -- drill [--px <BTC>] [--entry <BTC>] [--hl <USD>] [--debt <USD>] [--usdc <USD>]
//!         [--at <ratio>]
//!
//! runs the depeg drill on the testnet demo book (PLAN.md 2) with risk-core: the state at each nBTC/BTC ratio, the
//! bands, a slide that lands in each state, and the plan at `--at` (0.75), in words and as the verdict's steps.
//!
//! Phase 5 adds the five crash days with 2-, 15- and 60-minute rebalancing delays.
mod crash;
mod credit;
mod drill;
mod lender;
mod live;
mod examples;

use risk_core::Engine;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::process::ExitCode;

const REFERENCE: &str = include_str!("../../../research/data/reference_cases.json");

/// The reference's printout of the examples, line by line.
fn reference_printout() -> Vec<String> {
    let file: serde_json::Value =
        serde_json::from_str(REFERENCE).expect("reference_cases.json parses");
    let lines = file["printout"]
        .as_array()
        .expect("the file has the reference's printout");
    lines
        .iter()
        .map(|l| l.as_str().expect("a line").to_string())
        .collect()
}

fn examples() -> ExitCode {
    let ours = examples::printout(&Engine::v0());
    let theirs = reference_printout();
    let mut same = 0;
    for i in 0..ours.len().max(theirs.len()) {
        let (a, b) = (
            ours.get(i).map(String::as_str),
            theirs.get(i).map(String::as_str),
        );
        if a == b {
            same += 1;
            println!("  {}", a.unwrap_or_default());
        } else {
            println!("≠ {}", a.unwrap_or("(no line)"));
            println!("  reference: {}", b.unwrap_or("(no line)"));
        }
    }
    let total = ours.len().max(theirs.len());
    println!("\nrisk-core vs the Python reference: {same} of {total} lines identical");
    if same == total {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// A preview's snapshot: the verdict as printed, and the inputs.
#[derive(Deserialize)]
struct Snapshot<'a> {
    #[serde(borrow)]
    verdict: Option<&'a RawValue>,
    #[serde(borrow)]
    inputs: &'a RawValue,
}

/// How a replay compares with the verdict a snapshot carries.
#[derive(Debug, PartialEq, Eq)]
enum Match {
    /// The file had only inputs.
    NothingToCompare,
    Identical,
    /// Same values, but the file's copy is formatted differently (say, pretty-printed).
    SameValues,
    Different(String),
}

/// A replay: the verdict, the run's whole output as the enclave printed it, and how it compares.
struct Replay {
    verdict: String,
    printed: String,
    matched: Match,
}

impl Replay {
    /// The hash OutLayer attests for this output: SHA-256 of its JSON with keys sorted, written compactly.
    fn attested_hash(&self) -> String {
        let sorted: serde_json::Value =
            serde_json::from_str(&self.printed).expect("pb-risk prints JSON");
        pb_risk::util::sha256_hex(sorted.to_string().as_bytes())
    }
}

/// Recomputes the verdict from a snapshot or an inputs file's text.
fn replay(text: &str) -> Result<Replay, String> {
    let (snapshot, claimed, inputs_text) = match serde_json::from_str::<Snapshot>(text) {
        Ok(s) => (true, s.verdict.map(RawValue::get), s.inputs.get()),
        Err(_) => (false, None, text.trim()),
    };
    let inputs: pb_risk::Inputs =
        serde_json::from_str(inputs_text).map_err(|e| format!("not pb-risk inputs: {e}"))?;
    let ours = pb_risk::output(&inputs);
    // As `pb_risk::run` prints a snapshot (the fixtures test this).
    let printed = if snapshot {
        format!(r#"{{"verdict":{ours},"inputs":{}}}"#, inputs.canonical())
    } else {
        ours.clone()
    };
    let verdict = match claimed {
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
        verdict: ours,
        printed,
        matched: verdict,
    })
}

fn verdict(path: &str) -> ExitCode {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            return ExitCode::from(2);
        }
    };
    match replay(&text) {
        Err(e) => {
            eprintln!("{path}: {e}");
            ExitCode::from(2)
        }
        Ok(r) => {
            println!("{}", r.verdict);
            eprintln!(
                "the output_hash its OutLayer attestation should show: {}",
                r.attested_hash()
            );
            match r.matched {
                Match::NothingToCompare => ExitCode::SUCCESS,
                Match::Identical => {
                    eprintln!(
                        "identical to the verdict in {path}, byte for byte ({} bytes)",
                        r.verdict.len()
                    );
                    ExitCode::SUCCESS
                }
                Match::SameValues => {
                    eprintln!(
                        "the same values as the verdict in {path}, whose keys are in another order \
                         (OutLayer's HTTPS API sorts them)"
                    );
                    ExitCode::SUCCESS
                }
                Match::Different(theirs) => {
                    eprintln!("DIFFERENT from the verdict in {path}, which is:\n{theirs}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}

/// `drill [--px <BTC>] [--entry <BTC>] [--hl <USD>] [--debt <USD>] [--usdc <USD>] [--at <ratio>]`.
fn drill(args: &[String]) -> ExitCode {
    let mut book = drill::Book::default();
    let mut plan_at = 0.75;
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let value = it.next().and_then(|v| v.parse::<f64>().ok());
        let Some(v) = value.filter(|v| v.is_finite() && *v >= 0.0) else {
            eprintln!("{flag} needs a number");
            return ExitCode::FAILURE;
        };
        match flag.as_str() {
            "--px" => book.px = v,
            "--entry" => book.entry = v,
            "--hl" => book.hl = v,
            "--debt" => book.debt = v,
            "--usdc" => book.usdc = v,
            "--at" => plan_at = v,
            other => {
                eprintln!("unknown flag {other}");
                return ExitCode::FAILURE;
            }
        }
    }
    for line in drill::printout(&book, plan_at) {
        println!("{line}");
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match (args.get(1).map(String::as_str), args.get(2)) {
        (Some("examples"), _) => examples(),
        (Some("verdict"), Some(path)) => verdict(path),
        (Some("drill"), _) => drill(&args[2..]),
        (Some("crash"), _) => crash::main(&args[2..]),
        (Some("credit"), Some(path)) => credit::run(path),
        (Some("lender"), _) => lender::main(&args[2..]),
        (Some("live"), _) => live::main(&args[2..]),
        _ => {
            eprintln!("usage: backtest examples           RISK_ENGINE.md 13 from risk-core, checked against the reference");
            eprintln!("       backtest verdict <file.json>  a pb-risk verdict recomputed from its inputs (or a snapshot)");
            eprintln!("       backtest drill [--px --entry --hl --debt --usdc --at]  the depeg drill on the testnet demo book");
            eprintln!("       backtest lender [--json <file>]  each lender's cushion over the crash windows (FUNDING.md 6.8)");
            eprintln!("       backtest live <request.json>  pb-risk run natively on live reads, read only");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_examples_print_exactly_as_the_reference_prints_them() {
        let ours = super::examples::printout(&risk_core::Engine::v0());
        assert_eq!(ours, super::reference_printout());
    }

    fn fixture(name: &str) -> String {
        let path = format!(
            "{}/../pb-risk/tests/fixtures/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn the_drill_prints_the_reference_s_bands_and_plan() {
        let lines = super::drill::printout(&super::drill::Book::default(), 0.75);
        let text = lines.join("\n");
        // The Python reference on the same book: 0.8406, 0.7970 and 0.7594, and a repay then a quarter of the short.
        assert!(text.contains("WATCH below 0.8406 (equity = IM), MARGIN_CALL below 0.7970 (= MR), DELEVERAGE below 0.7594"), "{text}");
        assert!(text.contains("slide: 0.82,0.78,0.75"), "{text}");
        assert!(text.contains("  - repay $10 from USDC in the NEAR account\n  - perp BTC: trade $284, cost $0, MR $259 -> $91"), "{text}");
        assert!(text.contains(r#"[{"k":"repay","amt":10000000},{"k":"perp","coin":"BTC","buy":true,"sz":"0.00375","px":"76179"}]"#), "{text}");
        assert!(
            text.contains("HEALTHY") && text.contains("topup: $98"),
            "{text}"
        );
    }

    #[test]
    fn pb_risk_fixtures_replay_to_the_byte() {
        for name in ["fresh", "deposits", "loan", "hedged", "drill"] {
            let text = fixture(name);
            let r = replay(&text).unwrap();
            assert_eq!(r.matched, Match::Identical, "{name}");
            assert!(
                r.verdict.starts_with(r#"{"ok":true,"v":1,"model":"B-0.2""#),
                "{name}"
            );
            // The rebuilt output is exactly what pb-risk printed.
            assert_eq!(r.printed, text.trim_end(), "{name}");
        }
    }

    #[test]
    fn the_attested_hash_is_of_the_sorted_output() {
        // Measured on testnet: the refusal for a missing account (its keys are already in order), attested as
        // b34d5043..., and a snapshot whose keys are not.
        let refusal =
            r#"{"ok":false,"reason":"account nobody-xyz.pbf.testnet does not exist on testnet"}"#;
        let r = Replay {
            verdict: refusal.into(),
            printed: refusal.into(),
            matched: Match::NothingToCompare,
        };
        assert_eq!(
            r.attested_hash(),
            "b34d5043654a8cfde158bb36cc0f7ac74b0eb6b2f6f4420dd694464c9690230d"
        );
        let snap = replay(&fixture("fresh")).unwrap();
        let sorted = serde_json::from_str::<serde_json::Value>(&snap.printed)
            .unwrap()
            .to_string();
        assert_ne!(sorted, snap.printed);
        assert_eq!(
            snap.attested_hash(),
            pb_risk::util::sha256_hex(sorted.as_bytes())
        );
    }

    #[test]
    fn a_copy_with_sorted_keys_agrees_in_values() {
        // As OutLayer's HTTPS API returns a snapshot: parsed, keys sorted.
        let sorted = serde_json::from_str::<serde_json::Value>(&fixture("loan"))
            .unwrap()
            .to_string();
        let r = replay(&sorted).unwrap();
        assert_eq!(r.matched, Match::SameValues);
        assert_eq!(r.printed, fixture("loan").trim_end());
    }

    #[test]
    fn replays_take_bare_inputs_and_catch_changes() {
        let text = fixture("deposits");
        let snap: serde_json::Value = serde_json::from_str(&text).unwrap();
        // The inputs alone, pretty-printed: the same verdict, nothing to compare.
        let bare = serde_json::to_string_pretty(&snap["inputs"]).unwrap();
        let r = replay(&bare).unwrap();
        assert_eq!(r.matched, Match::NothingToCompare);
        assert_eq!(r.printed, r.verdict);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&r.verdict).unwrap(),
            snap["verdict"]
        );
        // A snapshot whose verdict was edited is caught.
        let edited = text.replacen(r#""nonce":1"#, r#""nonce":2"#, 1);
        assert!(matches!(
            replay(&edited).unwrap().matched,
            Match::Different(_)
        ));
        // Inputs that were edited give another `in`, so another verdict.
        let tampered = text.replacen(r#""counter":1"#, r#""counter":7"#, 1);
        assert!(matches!(
            replay(&tampered).unwrap().matched,
            Match::Different(_)
        ));
        assert!(replay("{}").is_ok());
        assert!(replay("not json").is_err());
    }
}
