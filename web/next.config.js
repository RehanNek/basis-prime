// The repo keeps one .env, at its root (see .env.example); Next itself only reads web/.env*. From the root
// .env this takes exactly two kinds of value, so no key in it can reach the app:
//   - NEXT_PUBLIC_*: public ids, inlined into the browser bundle;
//   - API_URL: where the backend listens. Only Next's server uses it, to proxy /api/* there, so the
//     browser calls its own origin and never needs the backend's address or a cross-origin call.
// A value already in the environment wins over the file.
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const DEFAULT_API_URL = 'http://localhost:8788';

function allowed(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([name, value]) => value && (name.startsWith('NEXT_PUBLIC_') || name === 'API_URL')),
  );
}

const file = path.join(__dirname, '..', '.env');
const values = { ...allowed(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...allowed(process.env) };
const { API_URL, ...publicEnv } = values;
const apiUrl = (API_URL || DEFAULT_API_URL).replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  env: publicEnv,
  // A pb-risk preview takes a few seconds, but it can wait a minute or two in OutLayer's queue first (seen on
  // 11 Nov). INTERFACES.md 50.4: an order is signed for up to 230 s on testnet and the backend waits up to 280 s for
  // its run, so the proxy's 370 s is past the backend's longest wait with room to spare.
  experimental: { proxyTimeout: 370_000 },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
};
