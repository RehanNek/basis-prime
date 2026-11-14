// Checks on what the browser sends, so only well-formed requests reach the chain, OutLayer or 1Click.

/** A request the backend refuses, with the HTTP status and a short code the web app can match on. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message: string) => new HttpError(400, "bad_request", message);

/** NEAR account id rules: 2-64 characters, lowercase letters and digits, joined by - or _ within a part, parts joined by dots. */
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** One part of an account id: the name a client picks for <name>.<factory>. */
const NAME = /^([a-z\d]+[-_])*[a-z\d]+$/;
const U128_MAX = (1n << 128n) - 1n;

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && NEAR_ACCOUNT.test(value);
}

/** A client account: <name>.<factory>, where <name> is a single part. */
export function isPrimeAccount(value: unknown, factory: string): value is string {
  if (!isAccountId(value) || !value.endsWith(`.${factory}`)) return false;
  return NAME.test(value.slice(0, -factory.length - 1));
}

/** A U128 in contract JSON: a whole number as a string, with no sign, no leading zeros and no more than 2^128 - 1. */
export function isU128(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,38})$/.test(value) && BigInt(value) <= U128_MAX;
}

function positiveU128(value: unknown, field: string): string {
  if (!isU128(value) || value === "0") throw badRequest(`${field} must be a positive whole number of units, as a string`);
  return value;
}

/** The intents of INTERFACES.md 6 that Phase 2 uses. */
export type Intent =
  | { check: Record<string, never> }
  | { borrow: { amount: string } }
  | { withdraw: { token: string; amount: string } }
  /** Phase 6 (INTERFACES.md 25): one loan of this much in all (micro-USD); the engine picks the sources. */
  | { fund: { amount: string } }
  /** Phase 6: taking collateral back from a lender. `token` is a NEAR token id, or for Aave a 0x address. */
  | { lender_withdraw: { lender: string; token: string; amount: string } }
  /** Stage 3 (INTERFACES.md 33): sending a token out of the account's address on Aave's chain. */
  | { evm_withdraw: { token: string; amount: string } };

const LENDER_NAMES = ["aave", "rhea"];
const EVM_TOKEN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Reads an intent, refusing anything but the six shapes the engine's preview answers. A withdrawal must name one of
 * the accounts' tokens. The three from Phase 6 are the ones a check on chain already carries: until 13 Nov a preview
 * of them was refused as "Unknown intent", which the app's "Preview the result (free)" link then showed.
 */
export function parseIntent(value: unknown, tokens: string[]): Intent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("intent must be an object");
  const keys = Object.keys(value);
  if (keys.length !== 1) throw badRequest("intent must have exactly one of check, borrow, withdraw, fund, lender_withdraw or evm_withdraw");
  const body = (value as Record<string, unknown>)[keys[0]!];
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest(`intent.${keys[0]} must be an object`);
  const fields = body as Record<string, unknown>;

  switch (keys[0]) {
    case "check":
      return { check: {} };
    case "borrow":
      return { borrow: { amount: positiveU128(fields.amount, "intent.borrow.amount") } };
    case "withdraw": {
      if (typeof fields.token !== "string" || !tokens.includes(fields.token)) {
        throw badRequest(`intent.withdraw.token must be one of ${tokens.join(", ")}`);
      }
      return { withdraw: { token: fields.token, amount: positiveU128(fields.amount, "intent.withdraw.amount") } };
    }
    case "fund":
      return { fund: { amount: positiveU128(fields.amount, "intent.fund.amount") } };
    case "lender_withdraw": {
      if (typeof fields.lender !== "string" || !LENDER_NAMES.includes(fields.lender)) throw badRequest(`intent.lender_withdraw.lender must be one of ${LENDER_NAMES.join(", ")}`);
      // Rhea holds NEAR tokens, Aave holds tokens of its own chain: the engine checks the token against the lender.
      if (typeof fields.token !== "string" || !(isAccountId(fields.token) || EVM_TOKEN.test(fields.token))) {
        throw badRequest("intent.lender_withdraw.token must be a NEAR token id or a 0x address");
      }
      return { lender_withdraw: { lender: fields.lender, token: fields.token, amount: positiveU128(fields.amount, "intent.lender_withdraw.amount") } };
    }
    case "evm_withdraw": {
      if (typeof fields.token !== "string" || !EVM_TOKEN.test(fields.token)) throw badRequest("intent.evm_withdraw.token must be a 0x address");
      return { evm_withdraw: { token: fields.token.toLowerCase(), amount: positiveU128(fields.amount, "intent.evm_withdraw.amount") } };
    }
    default:
      throw badRequest(`Unknown intent ${keys[0]}: use check, borrow, withdraw, fund, lender_withdraw or evm_withdraw`);
  }
}

/** Reads a JSON body that must be an object. */
export function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("The body must be a JSON object");
  return body as Record<string, unknown>;
}

export { badRequest };
