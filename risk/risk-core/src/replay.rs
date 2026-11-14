//! RISK_ENGINE.md 4.5, last row: the crash replays. Ten real 4-hour windows (the worst fall and the worst rise
//! of BTC on five crash days), each 240 one-minute closes in time order, so a liquidation affects only what
//! comes after it. A coin with minute data follows its own recorded path, as recorded. A coin without follows
//! BTC's path times the window's scale for it, never past its own extreme size (±2·S) or a 90% fall.
use crate::py;
use crate::scenarios::{Carry, Kind, Scenario};
use crate::Engine;

impl Engine {
    /// One replay scenario per window, for the account's groups `gs`.
    pub fn replay_scenarios(&self, gs: &[String]) -> Vec<Scenario> {
        let p = &self.params;
        let cap = -p.extreme_down_cap;
        let two_s: Vec<f64> = gs.iter().map(|g| 2.0 * self.coin(g).params.s).collect();
        let mut out = Vec::with_capacity(self.replays.len());
        for w in &self.replays {
            let btc = &w.paths["BTC"];
            let fallback = w.p75_ratio.unwrap_or(1.0);
            let scale: Vec<f64> = gs
                .iter()
                .map(|g| w.scale.get(g).copied().unwrap_or(fallback))
                .collect();
            let recorded: Vec<Option<&Vec<f64>>> = gs.iter().map(|g| w.paths.get(g)).collect();
            let path = (0..btc.len())
                .map(|i| {
                    let alt = (0..gs.len())
                        .map(|j| {
                            let mut x = match recorded[j] {
                                Some(path) => path[i],
                                None => {
                                    py::min(py::max3(btc[i] * scale[j], -two_s[j], cap), two_s[j])
                                }
                            };
                            if p.replay_cap_2s {
                                x = py::min(py::max3(x, -two_s[j], cap), two_s[j]);
                            }
                            x
                        })
                        .collect();
                    vec![alt]
                })
                .collect();
            let sc = Scenario::new(format!("replay {}", w.name), Kind::Replay, path);
            out.push(Scenario {
                carry: Carry::Normal,
                ..sc
            });
        }
        out
    }
}
