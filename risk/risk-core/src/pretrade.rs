//! RISK_ENGINE.md 9: the checks every Hyperliquid order passes before it is sent. One order, checked as if it
//! fills completely at its limit price but never better than the mark. An order that lowers risk always
//! passes; otherwise, while there is a loan, the account must be HEALTHY and stay within every credit
//! condition after the trade. With no loan, only the list, band, size and caps apply. Port of `pretrade`.
//! The gateway runs these one at a time per account (P0), with its own recent orders counted as filled.
use crate::py::{self, pct0, sgn};
use crate::snapshot::{Account, Market, Order};
use crate::states::State;
use crate::stress::Requirement;
use crate::Engine;

/// P4: the price an order is booked at: its limit, but never better than the mark (a buy at no less than
/// the mark, a sell at no more).
pub fn worst_fill(size: f64, limit_px: f64, mark: f64) -> f64 {
    if size > 0.0 {
        py::max(limit_px, mark)
    } else {
        py::min(limit_px, mark)
    }
}

/// P2's price band for a coin: the parameter file's `band`, or `floor` when one is given and is larger.
///
/// The floor is a network's own allowance, not a parameter: Hyperliquid testnet's mark was seen 0.77%, 1.69% and
/// 1.96% from its oracle on 11 and 12 Nov, so on testnet the programs pass 3% (INTERFACES.md 42). With `None`
/// (this crate's default, the reference's cases, the backtest) the band is the file's.
pub fn p2_band(band: f64, floor: Option<f64>) -> f64 {
    match floor {
        Some(f) if f.is_finite() && f > band => f,
        _ => band,
    }
}

impl Engine {
    /// P4: the book after `size` of `coin` fills at `fill`. Hyperliquid equity changes by −size·(fill − mark)
    /// − fee, never a gain, and the coin's open PnL is folded into cash at the mark. Returns it and the fee.
    pub fn post_trade(
        &self,
        a: &Account,
        m: &Market,
        coin: &str,
        size: f64,
        fill: f64,
    ) -> (Account, f64) {
        let mark = m.mark_price(coin);
        let q0 = a.perps.get_or(coin, 0.0);
        let fee = self.params.hl_taker_fee * size.abs() * fill;
        let slip = size * (fill - mark); // >= 0: the worst fill costs, it never pays
        let upnl = q0 * (mark - a.entry.get_or(coin, mark));
        let mut b = a.clone();
        b.perps.insert(coin, q0 + size);
        b.hl_cash = a.hl_cash + upnl - fee - slip;
        b.entry.insert(coin, mark);
        (b, fee)
    }

    /// P1–P10 for one order. Returns whether it may be sent, and why. `req` is the account's own
    /// requirement, if already computed.
    pub fn pretrade(
        &self,
        a: &Account,
        m: &Market,
        order: &Order,
        req: Option<&Requirement>,
    ) -> (bool, String) {
        let r = self.pretrade_check(a, m, order, req);
        (r.ok, r.reason)
    }

    /// [`Engine::pretrade`], also naming the check that decided (RISK_ENGINE.md 9's numbers), so the gateway
    /// can answer with a code.
    pub fn pretrade_check(
        &self,
        a: &Account,
        m: &Market,
        order: &Order,
        req: Option<&Requirement>,
    ) -> PreTrade {
        self.pretrade_check_with(a, m, order, req, None, None)
    }

    /// [`Engine::pretrade_check`], with `day_volume` (USD) as the coin's daily Hyperliquid volume for P10's size
    /// limit in place of the parameter file's 30-day average. pb-gateway passes mainnet's live volume on testnet,
    /// where testnet's own volume is an artifact. Only that limit changes: the requirement keeps the file's figure.
    ///
    /// `band_floor` is a floor under P2's price band ([`p2_band`]). `None`, the default, is the parameter file's
    /// band, as the reference has it.
    pub fn pretrade_check_with(
        &self,
        a: &Account,
        m: &Market,
        order: &Order,
        req: Option<&Requirement>,
        day_volume: Option<f64>,
        band_floor: Option<f64>,
    ) -> PreTrade {
        let p = &self.params;
        let coin = order.coin.as_str();
        let size = order.size;
        // A coin outside the universe is not on the allow-list either.
        let Some(c) = self.find_coin(coin).filter(|c| c.allowed) else {
            return PreTrade::refuse(Check::P1, "coin not on the allow-list".to_string());
        };
        let band = p2_band(c.params.price_band, band_floor);
        if (order.limit_px / m.price(coin) - 1.0).abs() > band {
            return PreTrade::refuse(
                Check::P2,
                format!(
                    "limit price more than {} from the reference price",
                    pct0(band)
                ),
            );
        }
        let q0 = a.perps.get_or(coin, 0.0);
        let q1 = q0 + size;
        let shrinking = q1.abs() < q0.abs() && (sgn(q1) == 0 || sgn(q1) == sgn(q0));
        if order.reduce_only && !shrinking {
            return PreTrade::refuse(
                Check::P3,
                "reduce-only order would increase or flip the position".to_string(),
            );
        }
        let mark = m.mark_price(coin);
        let fill = worst_fill(size, order.limit_px, mark);
        let volume = day_volume
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(c.adv30_usd);
        if size.abs() * fill > p.max_order_adv * volume {
            return PreTrade::refuse(
                Check::P10,
                "order above 1% of the coin's daily Hyperliquid volume: slice it".to_string(),
            );
        }
        if !shrinking && q1.abs() * mark > c.params.client_cap_usd {
            return PreTrade::refuse(
                Check::P7,
                "position above the per-client cap for this coin".to_string(),
            );
        }
        let (a2, fee) = self.post_trade(a, m, coin, size, fill);
        if a.debt <= 0.0 {
            // No loan: margin is Hyperliquid's business.
            return PreTrade::accept(Check::NoLoan, "ok (no loan)".to_string());
        }
        let own;
        let req = match req {
            Some(r) => r,
            None => {
                own = self.requirement(a, m);
                &own
            }
        };
        let req2 = self.requirement(&a2, m);
        let excess_before = self.equity_allow(a, m) - req.im;
        let excess_after = self.equity_allow(&a2, m) - req2.im;
        if req2.mr <= req.mr + 1e-9
            && excess_after >= excess_before - fee - 1e-6
            && self.hl_ratio(&a2, m, None)
                <= py::max(self.hl_ratio(a, m, None), p.hl_ratio_pretrade)
        {
            return PreTrade::accept(
                Check::P5,
                "risk-reducing (requirement does not rise, excess over IM does not fall)"
                    .to_string(),
            );
        }
        let st = self.state(a, m, req, 0.0, None).state;
        if st != State::Healthy {
            return PreTrade::refuse(
                Check::P6,
                format!("account is {}: only risk-reducing orders", st.as_str()),
            );
        }
        let fails = self.credit_failures(&a2, m, Some(&req2));
        if !fails.is_empty() {
            return PreTrade::refuse(Check::P8, fails.join("; "));
        }
        if self.hl_ratio(&a2, m, None) > p.hl_ratio_pretrade {
            return PreTrade::refuse(
                Check::P9,
                "Hyperliquid margin ratio after the trade above 50%".to_string(),
            );
        }
        PreTrade::accept(Check::Pass, "ok".to_string())
    }
}

/// The check of RISK_ENGINE.md 9 that decided an order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Check {
    /// Refusals.
    P1,
    P2,
    P3,
    P6,
    P7,
    P8,
    P9,
    P10,
    /// Accepted with no loan, after P1–P3, P7 and P10.
    NoLoan,
    /// Accepted as risk-reducing.
    P5,
    /// Accepted after every credit condition held.
    Pass,
}

impl Check {
    /// The code the gateway answers with: `P1` ... `P10`, or `ok`, `no_loan` and `P5` for an accepted order.
    pub fn code(self) -> &'static str {
        match self {
            Check::P1 => "P1",
            Check::P2 => "P2",
            Check::P3 => "P3",
            Check::P6 => "P6",
            Check::P7 => "P7",
            Check::P8 => "P8",
            Check::P9 => "P9",
            Check::P10 => "P10",
            Check::NoLoan => "no_loan",
            Check::P5 => "P5",
            Check::Pass => "ok",
        }
    }
}

/// What the pre-trade checks decided about one order.
#[derive(Clone, Debug, PartialEq)]
pub struct PreTrade {
    pub ok: bool,
    pub check: Check,
    pub reason: String,
}

impl PreTrade {
    fn accept(check: Check, reason: String) -> PreTrade {
        PreTrade {
            ok: true,
            check,
            reason,
        }
    }

    fn refuse(check: Check, reason: String) -> PreTrade {
        PreTrade {
            ok: false,
            check,
            reason,
        }
    }
}
