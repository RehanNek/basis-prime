//! HTTPS over WASI HTTP 0.2, as `wasi-http-client` 0.2.1 does it (the probe's working client), plus first-byte
//! and between-bytes timeouts, so one slow exchange can't use up the run's 20 seconds.
use crate::read::{Net, Reply};
use std::time::{SystemTime, UNIX_EPOCH};
use wasi::http::outgoing_handler;
use wasi::http::types::{
    Fields, FutureIncomingResponse, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
};
use wasi::io::streams::StreamError;

const CONNECT_NS: u64 = 5_000_000_000;
const FIRST_BYTE_NS: u64 = 6_000_000_000;
const BETWEEN_BYTES_NS: u64 = 5_000_000_000;
/// The largest answer read (Hyperliquid's market is about 60 KB, a month of hourly candles about 130 KB).
const MAX_BODY: usize = 8 << 20;

/// The transport, with the program's name for the User-Agent header (`pb-risk/0.0.1`).
pub struct WasiNet {
    ua: String,
}

impl WasiNet {
    pub fn new(program: &str) -> WasiNet {
        WasiNet {
            ua: format!("{program}/{}", env!("CARGO_PKG_VERSION")),
        }
    }
}

impl Net for WasiNet {
    fn get(&mut self, url: &str) -> Result<Reply, String> {
        send(&self.ua, Method::Get, url, None)
    }

    fn post(&mut self, url: &str, body: &str) -> Result<Reply, String> {
        send(&self.ua, Method::Post, url, Some(body.as_bytes()))
    }

    fn now_ms(&mut self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }

    fn pause(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }

    fn get_all(&mut self, urls: &[String]) -> Vec<Result<Reply, String>> {
        let reqs: Vec<(Method, &str, Option<&[u8]>)> = urls
            .iter()
            .map(|u| (Method::Get, u.as_str(), None))
            .collect();
        send_all(&self.ua, &reqs)
    }

    fn post_all(&mut self, reqs: &[(String, String)]) -> Vec<Result<Reply, String>> {
        let reqs: Vec<(Method, &str, Option<&[u8]>)> = reqs
            .iter()
            .map(|(u, b)| (Method::Post, u.as_str(), Some(b.as_bytes())))
            .collect();
        send_all(&self.ua, &reqs)
    }
}

/// At most this many requests in flight at once, so no exchange sees a burst past its rate limit.
const IN_FLIGHT: usize = 8;

/// Several requests, overlapped: each group of [`IN_FLIGHT`] is sent before any answer is awaited (WASI HTTP's
/// `handle` returns a future, and the host runs the requests while the guest waits on the first). A request that
/// fails other than by timing out is sent once more on its own with [`send`], the transport `check` uses, so a
/// host that can't overlap requests only costs time; a timeout isn't repeated, as `check` doesn't repeat one.
/// Answers come back in the order asked.
fn send_all(ua: &str, reqs: &[(Method, &str, Option<&[u8]>)]) -> Vec<Result<Reply, String>> {
    let mut out = Vec::with_capacity(reqs.len());
    for group in reqs.chunks(IN_FLIGHT) {
        let started: Vec<Result<FutureIncomingResponse, String>> = group
            .iter()
            .map(|(m, url, body)| start(ua, m.clone(), url, *body))
            .collect();
        for ((m, url, body), f) in group.iter().zip(started) {
            match f.and_then(finish) {
                Ok(reply) => out.push(Ok(reply)),
                Err(e) if e.contains("Timeout") => out.push(Err(e)),
                Err(_) => out.push(send(ua, m.clone(), url, *body)),
            }
        }
    }
    out
}

/// The first half of [`send`]: the request built and handed to the host, its answer not yet awaited.
fn start(
    ua: &str,
    method: Method,
    url: &str,
    body: Option<&[u8]>,
) -> Result<FutureIncomingResponse, String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or("only https URLs are used")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let mut headers: Vec<(String, Vec<u8>)> = vec![
        ("User-Agent".into(), ua.as_bytes().to_vec()),
        ("Accept".into(), b"application/json".to_vec()),
    ];
    if body.is_some() {
        headers.push(("Content-Type".into(), b"application/json".to_vec()));
    }
    let fields = Fields::from_list(&headers).map_err(|e| format!("headers: {e:?}"))?;
    let req = OutgoingRequest::new(fields);
    req.set_method(&method)
        .map_err(|()| "cannot set the method")?;
    req.set_scheme(Some(&Scheme::Https))
        .map_err(|()| "cannot set the scheme")?;
    req.set_authority(Some(authority))
        .map_err(|()| "cannot set the host")?;
    req.set_path_with_query(Some(path))
        .map_err(|()| "cannot set the path")?;
    let out_body = req.body().map_err(|()| "cannot open the request body")?;
    if let Some(bytes) = body {
        let stream = out_body
            .write()
            .map_err(|()| "cannot write the request body")?;
        for chunk in bytes.chunks(4096) {
            stream
                .blocking_write_and_flush(chunk)
                .map_err(|e| format!("request body: {e:?}"))?;
        }
        drop(stream);
    }
    OutgoingBody::finish(out_body, None).map_err(|e| format!("request body: {e:?}"))?;
    let options = RequestOptions::new();
    let _ = options.set_connect_timeout(Some(CONNECT_NS));
    let _ = options.set_first_byte_timeout(Some(FIRST_BYTE_NS));
    let _ = options.set_between_bytes_timeout(Some(BETWEEN_BYTES_NS));
    outgoing_handler::handle(req, Some(options)).map_err(|e| format!("{e:?}"))
}

/// The second half of [`send`]: waits for the answer and reads its body.
fn finish(future: FutureIncomingResponse) -> Result<Reply, String> {
    let ready = match future.get() {
        Some(r) => r,
        None => {
            future.subscribe().block();
            future.get().ok_or("no response")?
        }
    };
    let response = ready
        .map_err(|()| "the response was already taken")?
        .map_err(|e| format!("{e:?}"))?;
    drop(future);
    let status = response.status();
    let incoming = response
        .consume()
        .map_err(|()| "cannot read the response body")?;
    drop(response);
    let stream = incoming
        .stream()
        .map_err(|()| "cannot read the response body")?;
    let mut buf = Vec::new();
    loop {
        match stream.blocking_read(1 << 16) {
            Ok(chunk) => {
                buf.extend_from_slice(&chunk);
                if buf.len() > MAX_BODY {
                    return Err("the response is too large".into());
                }
            }
            Err(StreamError::Closed) => break,
            Err(e) => return Err(format!("response body: {e:?}")),
        }
    }
    drop(stream);
    drop(incoming);
    Ok(Reply { status, body: buf })
}

fn send(ua: &str, method: Method, url: &str, body: Option<&[u8]>) -> Result<Reply, String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or("only https URLs are used")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let mut headers: Vec<(String, Vec<u8>)> = vec![
        ("User-Agent".into(), ua.as_bytes().to_vec()),
        ("Accept".into(), b"application/json".to_vec()),
    ];
    if body.is_some() {
        headers.push(("Content-Type".into(), b"application/json".to_vec()));
    }
    let fields = Fields::from_list(&headers).map_err(|e| format!("headers: {e:?}"))?;
    let req = OutgoingRequest::new(fields);
    req.set_method(&method)
        .map_err(|()| "cannot set the method")?;
    req.set_scheme(Some(&Scheme::Https))
        .map_err(|()| "cannot set the scheme")?;
    req.set_authority(Some(authority))
        .map_err(|()| "cannot set the host")?;
    req.set_path_with_query(Some(path))
        .map_err(|()| "cannot set the path")?;
    let out_body = req.body().map_err(|()| "cannot open the request body")?;
    if let Some(bytes) = body {
        let stream = out_body
            .write()
            .map_err(|()| "cannot write the request body")?;
        // A blocking write takes at most 4,096 bytes at a time.
        for chunk in bytes.chunks(4096) {
            stream
                .blocking_write_and_flush(chunk)
                .map_err(|e| format!("request body: {e:?}"))?;
        }
        drop(stream);
    }
    OutgoingBody::finish(out_body, None).map_err(|e| format!("request body: {e:?}"))?;
    let options = RequestOptions::new();
    // A host that doesn't support a timeout ignores it.
    let _ = options.set_connect_timeout(Some(CONNECT_NS));
    let _ = options.set_first_byte_timeout(Some(FIRST_BYTE_NS));
    let _ = options.set_between_bytes_timeout(Some(BETWEEN_BYTES_NS));
    let future = outgoing_handler::handle(req, Some(options)).map_err(|e| format!("{e:?}"))?;
    let ready = match future.get() {
        Some(r) => r,
        None => {
            future.subscribe().block();
            future.get().ok_or("no response")?
        }
    };
    let response = ready
        .map_err(|()| "the response was already taken")?
        .map_err(|e| format!("{e:?}"))?;
    drop(future);
    let status = response.status();
    let incoming = response
        .consume()
        .map_err(|()| "cannot read the response body")?;
    drop(response);
    let stream = incoming
        .stream()
        .map_err(|()| "cannot read the response body")?;
    let mut buf = Vec::new();
    loop {
        match stream.blocking_read(1 << 16) {
            Ok(chunk) => {
                buf.extend_from_slice(&chunk);
                if buf.len() > MAX_BODY {
                    return Err("the response is too large".into());
                }
            }
            Err(StreamError::Closed) => break,
            Err(e) => return Err(format!("response body: {e:?}")),
        }
    }
    // The stream is the body's child, so it goes first.
    drop(stream);
    drop(incoming);
    Ok(Reply { status, body: buf })
}
