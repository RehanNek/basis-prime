// The form a run's output is hashed in for its attestation (INTERFACES.md 6, "Hashes"): OutLayer's worker re-serialises
// the program's JSON output with every object's keys sorted and no spaces (serde_json's Value::to_string, as
// risk/backtest's `attested_hash` does), and output_hash is the SHA-256 of that text. JavaScript's JSON.parse can't
// keep that form: it prints the float 82310.0 as 82310. So this reads JSON keeping each number exactly as written, and
// writes it back sorted. On text serde_json wrote, such as OutLayer's HTTPS answer, that gives serde_json's form.
import { createHash } from "node:crypto";

/** A number as it was written. */
class Num {
  constructor(readonly text: string) {}
}

type Raw = null | boolean | string | Num | Raw[] | Map<string, Raw>;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

/** JSON to a value that keeps numbers as written. Throws on anything that isn't JSON. */
export function parseRaw(text: string): Raw {
  let i = 0;
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const fail = (): never => {
    throw new SyntaxError(`not JSON at character ${i}`);
  };
  const value = (): Raw => {
    space();
    const c = text[i];
    if (c === "{") {
      i++;
      const map = new Map<string, Raw>();
      space();
      if (text[i] === "}") {
        i++;
        return map;
      }
      for (;;) {
        space();
        const key = string();
        space();
        if (text[i++] !== ":") fail();
        map.set(key, value()); // serde_json keeps the last of a repeated key
        space();
        const next = text[i++];
        if (next === "}") return map;
        if (next !== ",") fail();
      }
    }
    if (c === "[") {
      i++;
      const list: Raw[] = [];
      space();
      if (text[i] === "]") {
        i++;
        return list;
      }
      for (;;) {
        list.push(value());
        space();
        const next = text[i++];
        if (next === "]") return list;
        if (next !== ",") fail();
      }
    }
    if (c === '"') return string();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail();
    i += m[0].length;
    return new Num(m[0]);
  };
  const string = (): string => {
    STRING.lastIndex = i;
    const m = STRING.exec(text);
    if (!m) return fail();
    i += m[0].length;
    return JSON.parse(m[0]) as string;
  };
  const out = value();
  space();
  if (i !== text.length) fail();
  return out;
}

/** Sorted, compact JSON, numbers as written. Strings are escaped as serde_json escapes them, which JSON.stringify matches. */
export function sortedRaw(value: Raw): string {
  if (value instanceof Num) return value.text;
  if (Array.isArray(value)) return `[${value.map(sortedRaw).join(",")}]`;
  if (value instanceof Map) {
    const keys = [...value.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedRaw(value.get(k)!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The attested output_hash of JSON text: SHA-256 of its sorted form. */
export function sortedHash(text: string): string {
  return sha256Hex(sortedRaw(parseRaw(text)));
}

/**
 * The output_hash for a synchronous OutLayer answer, {call_id, status, output, ...}, from its raw text: the `output`
 * member in sorted form (or the JSON inside it, when it is a string). Null when there is no JSON output.
 */
export function outputHashOfAnswer(text: string): string | null {
  try {
    const answer = parseRaw(text);
    if (!(answer instanceof Map)) return null;
    const output = answer.get("output");
    if (output === undefined || output === null) return null;
    return typeof output === "string" ? sortedHash(output) : sha256Hex(sortedRaw(output));
  } catch {
    return null;
  }
}
