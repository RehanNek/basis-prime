//! Python's rules, wherever they can change a result. The reference engine is Python, and the port must give
//! the same bits:
//! - `max` and `min` keep the first of equal values (so `max(0.0, -0.0)` is `0.0`), and never prefer a NaN
//!   that comes second;
//! - `sum` adds left to right from 0 (Python 3.11; 3.12 switched to a compensated sum, see the report);
//! - `sgn` is an integer, and `int * float` converts the integer first;
//! - money prints like `f"{x:,.0f}"`: rounded half to even on the exact binary value, with thousands commas.
//!   Rust's `{:.0}` rounds the same way, so only the commas are added here.

/// `max(a, b)`: `a`, unless `b` is larger.
pub fn max(a: f64, b: f64) -> f64 {
    if b > a {
        b
    } else {
        a
    }
}

/// `min(a, b)`: `a`, unless `b` is smaller.
pub fn min(a: f64, b: f64) -> f64 {
    if b < a {
        b
    } else {
        a
    }
}

/// `max(a, b, c)`.
pub fn max3(a: f64, b: f64, c: f64) -> f64 {
    max(max(a, b), c)
}

/// `min(a, b, c)`.
pub fn min3(a: f64, b: f64, c: f64) -> f64 {
    min(min(a, b), c)
}

/// `max(values)` of a list that is never empty (every caller appends a 0.0, as the reference does).
pub fn max_all(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut it = values.into_iter();
    let first = it.next().expect("max() of an empty list");
    it.fold(first, max)
}

/// `sum(values)`: left to right, starting from 0.
pub fn sum(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(0.0, |acc, x| acc + x)
}

/// `(x > 0) - (x < 0)`.
pub fn sgn(x: f64) -> i32 {
    i32::from(x > 0.0) - i32::from(x < 0.0)
}

/// `f"{x:,.0f}"`.
pub fn commas0(x: f64) -> String {
    if x.is_nan() {
        return "nan".to_string();
    }
    let s = format!("{x:.0}");
    let (sign, digits) = match s.strip_prefix('-') {
        Some(d) => ("-", d),
        None => ("", s.as_str()),
    };
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return s; // "inf", "-inf"
    }
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    out.push_str(sign);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// `f"${x:,.0f}"`.
pub fn usd(x: f64) -> String {
    format!("${}", commas0(x))
}

/// `f"{x:.2f}"`.
pub fn fixed2(x: f64) -> String {
    format!("{x:.2}")
}

/// `f"{x:.0%}"`: Python multiplies by 100 first, then rounds like `.0f`.
pub fn pct0(x: f64) -> String {
    format!("{:.0}%", x * 100.0)
}

/// Python's repr of a tuple of integers: `()`, `(1,)`, `(1, -1)`.
pub fn tuple_repr(v: &[i32]) -> String {
    match v {
        [] => "()".to_string(),
        [one] => format!("({one},)"),
        _ => format!(
            "({})",
            v.iter().map(i32::to_string).collect::<Vec<_>>().join(", ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_and_min_keep_the_first_of_equals() {
        assert!(max(0.0, -0.0).is_sign_positive());
        assert!(max(-0.0, 0.0).is_sign_negative());
        assert!(min(-0.0, 0.0).is_sign_negative());
        assert_eq!(max(1.0, f64::NAN), 1.0);
        assert_eq!(max_all([3.0, 5.0, 5.0, 0.0]), 5.0);
    }

    #[test]
    fn money_prints_like_python() {
        // Values checked against Python 3.11's f"{x:,.0f}".
        let cases = [
            (0.5, "0"),
            (1.5, "2"),
            (2.5, "2"),
            (-0.4, "-0"),
            (-2.5, "-2"),
            (19_372.5, "19,372"),
            (999.0, "999"),
            (1_000.0, "1,000"),
            (-1_234_567.0, "-1,234,567"),
            (1e20, "100,000,000,000,000,000,000"),
            (f64::INFINITY, "inf"),
        ];
        for (x, want) in cases {
            assert_eq!(commas0(x), want, "{x}");
        }
        assert_eq!(usd(94_500.0), "$94,500");
        assert_eq!(usd(-12.0), "$-12");
    }

    #[test]
    fn names_print_like_python() {
        assert_eq!(fixed2(1.0 / 3.0), "0.33");
        assert_eq!(fixed2(2.0 / 3.0), "0.67");
        assert_eq!(pct0(0.2), "20%");
        assert_eq!(pct0(0.13), "13%");
        assert_eq!(tuple_repr(&[]), "()");
        assert_eq!(tuple_repr(&[1]), "(1,)");
        assert_eq!(tuple_repr(&[1, -1, -1]), "(1, -1, -1)");
        assert_eq!(sgn(-0.0), 0);
        assert_eq!(sgn(-3.0), -1);
    }
}
