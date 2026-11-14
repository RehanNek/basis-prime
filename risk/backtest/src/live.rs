//! `backtest live <request.json>`: runs pb-risk natively on live reads, read only (INTERFACES.md 27), so a new
//! engine build can be tried before it is published.
//!
//! The request is what pb-risk takes on stdin (`check`, `preview`, `credit_check` or `book`), and the program's
//! output goes to stdout, a snapshot included if the request asks for one. The reads go through the system's
//! `curl`, one process per request: HTTPS only, GET or a POST with a JSON body, with the headers the WASI transport
//! sends (`pb_read::wasi_net`). It holds no key and signs nothing; every request is a public read.
use pb_risk::read::{Net, Reply};
use std::io::Write;
use std::process::{Child, Command, ExitCode, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long curl may take to connect, and over one whole request, in seconds. The WASI transport allows 5 s to
/// connect, 6 s to the first byte and 5 s between bytes.
const CONNECT_S: u32 = 5;
const MAX_TIME_S: u32 = 15;
/// The largest answer read, as the WASI transport's.
const MAX_BODY: usize = 8 << 20;
/// At most this many requests are under way at once, as in the WASI transport.
const OVERLAP: usize = 8;

/// The transport: `curl`, with the program's name for the User-Agent header (`pb-risk/0.0.1`).
pub struct CurlNet {
    ua: String,
    /// How many requests were sent.
    pub calls: usize,
}

impl CurlNet {
    pub fn new(program: &str) -> CurlNet {
        CurlNet {
            ua: format!("{program}/{}", env!("CARGO_PKG_VERSION")),
            calls: 0,
        }
    }

    /// Starts one request. `body` makes it a POST.
    fn start(&mut self, url: &str, body: Option<&str>) -> Result<Child, String> {
        let args = curl_args(&self.ua, url, body.is_some())?;
        let mut child = Command::new("curl")
            .args(&args)
            .stdin(if body.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot run curl: {e}"))?;
        self.calls += 1;
        if let (Some(body), Some(mut stdin)) = (body, child.stdin.take()) {
            // Dropping stdin afterwards ends the body.
            stdin
                .write_all(body.as_bytes())
                .map_err(|e| format!("cannot send the request body to curl: {e}"))?;
        }
        Ok(child)
    }

    /// Several requests, at most [`OVERLAP`] under way at once, answered in the order asked.
    fn all(&mut self, reqs: &[(&str, Option<&str>)]) -> Vec<Result<Reply, String>> {
        let mut out = Vec::with_capacity(reqs.len());
        for batch in reqs.chunks(OVERLAP) {
            let started: Vec<Result<Child, String>> = batch
                .iter()
                .map(|(url, body)| self.start(url, *body))
                .collect();
            out.extend(started.into_iter().map(|c| c.and_then(finish)));
        }
        out
    }
}

/// Waits for one request and reads its answer.
fn finish(child: Child) -> Result<Reply, String> {
    let done = child
        .wait_with_output()
        .map_err(|e| format!("curl did not finish: {e}"))?;
    if !done.status.success() {
        // curl's own words: "curl: (28) Operation timed out after 15002 milliseconds".
        let why = String::from_utf8_lossy(&done.stderr);
        let why = why.trim();
        return Err(if why.is_empty() {
            format!("curl failed ({})", done.status)
        } else {
            why.chars().take(200).collect()
        });
    }
    parse_reply(done.stdout)
}

/// curl's arguments for one request. The answer comes on stdout as the body, a newline, and the HTTP status; a
/// POST's body goes in on stdin.
fn curl_args(ua: &str, url: &str, post: bool) -> Result<Vec<String>, String> {
    if !url.starts_with("https://") {
        return Err("only https URLs are used".into());
    }
    if url.len() > 4_096 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("the URL has a space or a control character, or is too long".into());
    }
    let mut args: Vec<String> = [
        // First, so no curl config file on this machine changes the request.
        "--disable",
        "--silent",
        "--show-error",
        // HTTPS only, the URL as written, and no redirect is followed.
        "--proto",
        "=https",
        "--globoff",
        "--max-redirs",
        "0",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let mut add = |flag: &str, value: String| {
        args.push(flag.to_string());
        args.push(value);
    };
    add("--connect-timeout", CONNECT_S.to_string());
    add("--max-time", MAX_TIME_S.to_string());
    add("--max-filesize", MAX_BODY.to_string());
    add("--user-agent", ua.to_string());
    add("--header", "Accept: application/json".to_string());
    if post {
        add("--header", "Content-Type: application/json".to_string());
        add("--data-binary", "@-".to_string());
    }
    add("--write-out", "\n%{http_code}".to_string());
    add("--url", url.to_string());
    Ok(args)
}

/// Splits what curl wrote into the body and the HTTP status after its last newline.
fn parse_reply(mut out: Vec<u8>) -> Result<Reply, String> {
    let at = out
        .iter()
        .rposition(|&b| b == b'\n')
        .ok_or("curl gave no HTTP status")?;
    let status = std::str::from_utf8(&out[at + 1..])
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|s| (100..600).contains(s))
        .ok_or("curl gave no HTTP status")?;
    out.truncate(at);
    if out.len() > MAX_BODY {
        return Err("the answer is larger than 8 MB".into());
    }
    Ok(Reply { status, body: out })
}

impl Net for CurlNet {
    fn get(&mut self, url: &str) -> Result<Reply, String> {
        self.start(url, None).and_then(finish)
    }

    fn post(&mut self, url: &str, body: &str) -> Result<Reply, String> {
        self.start(url, Some(body)).and_then(finish)
    }

    fn now_ms(&mut self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }

    fn pause(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn get_all(&mut self, urls: &[String]) -> Vec<Result<Reply, String>> {
        let reqs: Vec<(&str, Option<&str>)> = urls.iter().map(|u| (u.as_str(), None)).collect();
        self.all(&reqs)
    }

    fn post_all(&mut self, reqs: &[(String, String)]) -> Vec<Result<Reply, String>> {
        let reqs: Vec<(&str, Option<&str>)> = reqs
            .iter()
            .map(|(u, b)| (u.as_str(), Some(b.as_str())))
            .collect();
        self.all(&reqs)
    }
}

pub fn main(args: &[String]) -> ExitCode {
    let [path] = args else {
        eprintln!("usage: backtest live <request.json>  (the request pb-risk takes on stdin)");
        return ExitCode::from(2);
    };
    let raw = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            return ExitCode::from(2);
        }
    };
    let mut net = CurlNet::new("pb-risk");
    let started = Instant::now();
    let out = pb_risk::run(&raw, &mut net);
    println!("{out}");
    eprintln!(
        "{} requests in {:.1} s, all of them public reads over HTTPS; nothing was signed or sent",
        net.calls,
        started.elapsed().as_secs_f64()
    );
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value_of<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
        args.windows(2)
            .filter(|w| w[0] == flag)
            .map(|w| w[1].as_str())
            .collect()
    }

    #[test]
    fn a_request_goes_out_as_the_wasi_transport_sends_it() {
        let net = CurlNet::new("pb-risk");
        assert_eq!(net.ua, "pb-risk/0.0.1");
        let get = curl_args(&net.ua, "https://api.hyperliquid.xyz/info?x=[1]", false).unwrap();
        assert_eq!(get[0], "--disable", "no curl config file is read");
        assert_eq!(value_of(&get, "--proto"), ["=https"]);
        assert_eq!(value_of(&get, "--max-redirs"), ["0"]);
        assert_eq!(value_of(&get, "--user-agent"), ["pb-risk/0.0.1"]);
        assert_eq!(value_of(&get, "--header"), ["Accept: application/json"]);
        assert_eq!(value_of(&get, "--max-time"), ["15"]);
        // The URL is the last thing, behind its own flag, and its brackets are sent as written.
        assert_eq!(
            get[get.len() - 2..],
            ["--url", "https://api.hyperliquid.xyz/info?x=[1]"]
        );
        assert!(get.contains(&"--globoff".to_string()));
        assert!(!get.iter().any(|a| a.starts_with("--data")));
        // A POST sends JSON, from stdin.
        let post = curl_args(&net.ua, "https://api.hyperliquid.xyz/info", true).unwrap();
        assert_eq!(
            value_of(&post, "--header"),
            ["Accept: application/json", "Content-Type: application/json"]
        );
        assert_eq!(value_of(&post, "--data-binary"), ["@-"]);
    }

    #[test]
    fn only_https_urls_are_asked() {
        let mut net = CurlNet::new("pb-risk");
        for url in [
            "http://api.hyperliquid.xyz/info",
            "file:///etc/hosts",
            "-o/tmp/x",
            "api.hyperliquid.xyz/info",
            "",
        ] {
            assert_eq!(
                net.get(url).err().as_deref(),
                Some("only https URLs are used"),
                "{url}"
            );
            assert!(net.post(url, "{}").is_err());
        }
        assert!(net.get("https://example.com/a b").is_err());
        assert!(net.get("https://example.com/a\n--output x").is_err());
        let all = net.get_all(&[
            "http://example.com".to_string(),
            "ftp://example.com".to_string(),
        ]);
        assert!(all.len() == 2 && all.iter().all(Result::is_err));
        let all = net.post_all(&[("http://example.com".to_string(), "{}".to_string())]);
        assert!(all.len() == 1 && all[0].is_err());
        // Nothing was started for any of them.
        assert_eq!(net.calls, 0);
    }

    #[test]
    fn an_answer_is_its_body_and_then_its_status() {
        let r = parse_reply(b"{\"a\":1}\n200".to_vec()).unwrap();
        assert_eq!((r.status, r.body.as_slice()), (200, &b"{\"a\":1}"[..]));
        // A body may hold newlines itself, or be empty.
        let r = parse_reply(b"line 1\nline 2\n\n429".to_vec()).unwrap();
        assert_eq!(
            (r.status, r.body.as_slice()),
            (429, &b"line 1\nline 2\n"[..])
        );
        let r = parse_reply(b"\n201".to_vec()).unwrap();
        assert_eq!((r.status, r.body.len()), (201, 0));
        // curl writes 000 when no answer came; that isn't a status.
        assert!(parse_reply(b"\n000".to_vec()).is_err());
        assert!(parse_reply(b"no status".to_vec()).is_err());
        assert!(parse_reply(b"body\nabc".to_vec()).is_err());
    }

    #[test]
    fn the_clock_is_the_systems_and_a_missing_file_is_refused() {
        let mut net = CurlNet::new("pb-risk");
        let (a, b) = (net.now_ms(), net.now_ms());
        // Unix milliseconds, later than 6 Nov 2026, and not running backwards.
        assert!(a > 1_794_000_000_000 && b >= a);
        assert_eq!(main(&[]), ExitCode::from(2));
        assert_eq!(
            main(&["/nonexistent/request.json".to_string()]),
            ExitCode::from(2)
        );
    }
}
