// The Activity page (PLAN.md 5.8; INTERFACES.md 22): the account's history from GET /api/activity, in plain words,
// newest first, each line with its transaction (or, for a step the gateway placed on Hyperliquid, its attestation).
import type { ActivityItem } from './api.ts';
import type { Intent, Token } from './types.ts';
import { displayUnits, formatUsd } from './units.ts';
import { intentWords } from './verdict.ts';

export interface ActivityLine {
  at: number;
  kind: ActivityItem['kind'];
  what: string;
  ok: boolean;
  links: { href: string; text: string }[];
}

/** Money moves, deposits to withdrawals; checks and the rest are shown only when asked for. */
export const MONEY_KINDS: ActivityItem['kind'][] = ['create', 'deposit', 'borrow', 'repay', 'to_hl', 'home', 'arrived', 'refund', 'plan', 'plan_step', 'withdraw', 'kyb'];

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

function amountOf(tokens: Token[], token: string | null, units: string | null): string {
  if (units === null || !/^-?\d+$/.test(units)) return '?';
  const t = tokens.find((x) => x.id === token);
  const plain = units.replace('-', '');
  return t ? `${displayUnits(plain, t.decimals)} ${t.label}` : `${plain} units of ${token ?? '?'}`;
}

/** USDC amounts the pool and Hyperliquid count in micro-USDC. */
const usdc = (micro: string | null) => (micro !== null && /^\d+$/.test(micro) ? formatUsd(micro) : '?');

const SETUP: Record<string, string> = {
  hl_init: 'Set up the account’s Hyperliquid address (Chain Signatures)',
  request_agent: 'Asked the gateway for its trading agent',
  hl_approve_agent: 'Signed the agent’s approval on Hyperliquid',
};

/** One item in words. `oneClick` is the NEAR account 1Click delivers from: the stand-in's float on testnet. */
export function activityWords(item: ActivityItem, tokens: Token[], oneClick?: string | null): string {
  const d = item.detail;
  const moveIn = (token: string | null) => item.moves.find((m) => m.token === token && !m.amount.startsWith('-'));
  const transfer = str(d.transfer);
  const id = transfer ? ` (transfer ${transfer})` : '';
  switch (item.kind) {
    case 'create':
      return `Account created, owned by ${str(d.owner) ?? '?'}${d.registered ? ', and registered with the pool' : ''}`;
    case 'deposit': {
      const token = str(d.token);
      const kept = moveIn(token);
      if (!kept) return `A deposit of ${amountOf(tokens, token, str(d.sent))} came back: the account didn't keep it`;
      const via = oneClick && item.by === oneClick ? ' through 1Click (the stand-in on testnet)' : ` from ${item.by}`;
      return `Deposited ${amountOf(tokens, token, kept.amount)}${via}`;
    }
    case 'borrow': {
      const amount = str(d.amount);
      if (!amount) return `Asked to borrow ${usdc(str(d.asked))}: no loan was made`;
      const tier = str(d.tier);
      return `Borrowed ${usdc(amount)} from the pool${tier ? ` (${tier.toLowerCase()} tier)` : ''}; it now owes ${usdc(str(d.debt))}`;
    }
    case 'repay': {
      const used = str(d.amount);
      const sent = str(d.sent);
      const back = used && sent && BigInt(sent) > BigInt(used) ? `; the pool sent back ${usdc((BigInt(sent) - BigInt(used)).toString())} it didn't need` : '';
      return `Repaid ${usdc(used ?? sent)} to the pool${back}`;
    }
    case 'to_hl':
      return `Sent ${amountOf(tokens, str(d.token), str(d.amount))} to Hyperliquid through 1Click${id}`;
    case 'home':
      return `Signed ${usdc(str(d.amount))} of USDC home from Hyperliquid, for 1Click to carry${id}`;
    case 'arrived':
      if (d.how === 'verdict') return `The move to Hyperliquid${id} arrived: a check saw the USDC there`;
      return `${amountOf(tokens, str(d.token), moveIn(str(d.token))?.amount ?? str(d.sent))} arrived from 1Click${id}`;
    case 'refund':
      return `1Click refunded ${amountOf(tokens, str(d.token), moveIn(str(d.token))?.amount ?? str(d.sent))}${id}`;
    case 'plan': {
      const steps = Array.isArray(d.steps) ? (d.steps as unknown[]).map(String).join(', ') : '';
      const action = str(d.action);
      return `${action ? `A ${action}` : 'A'} plan was stored: ${steps || 'no steps'}`;
    }
    case 'plan_step': {
      const head = `Plan ${str(d.pid) ?? '?'}, step ${str(d.i) ?? '?'} (${str(d.k) ?? '?'})`;
      if (item.source === 'keeper_log') {
        const filled = str(d.filled_sz) ? `, ${str(d.filled_sz)} at ${str(d.avg_px) ?? '?'}` : '';
        return `${head}: the gateway placed it on Hyperliquid, ${str(d.status) ?? 'sent'}${filled}`;
      }
      if (d.k === 'repay') return `${head}: repaid ${usdc(str(d.repaid))} to the pool`;
      const out = item.moves.find((m) => m.amount.startsWith('-'));
      return `${head}: ran${out ? `, ${amountOf(tokens, out.token, out.amount)} out` : ''}${id}`;
    }
    case 'withdraw': {
      const to = str(d.to) ?? '?';
      return `Withdrew ${amountOf(tokens, str(d.token), str(d.amount))} to ${d.implicit_receiver ? `a 1Click deposit address (${to.slice(0, 8)}…)` : to}`;
    }
    case 'setup':
      return SETUP[String(d.method)] ?? `Called ${String(d.method)}`;
    case 'check':
      return `A check of ${d.intent ? intentWords(d.intent as Intent, tokens) : 'the account'}, asked by ${item.by}`;
    case 'kyb':
      return d.entity ? `The operator set the KYB flag, entity ${String(d.entity)}` : 'The operator cleared the KYB flag';
    default:
      return `${String(d.method ?? 'A transaction')} on ${String(d.receiver ?? '?')}`;
  }
}

/** The items as lines, newest first as given, each with its links. */
export function activityLines(items: ActivityItem[], tokens: Token[], txUrl: (hash: string) => string, oneClick?: string | null): ActivityLine[] {
  return items.map((item) => {
    const links: { href: string; text: string }[] = [];
    if (item.tx) links.push({ href: txUrl(item.tx), text: 'transaction' });
    if (item.attestation_url) links.push({ href: item.attestation_url, text: 'attestation' });
    const words = activityWords(item, tokens, oneClick);
    return { at: item.at_ms, kind: item.kind, what: item.ok ? words : `Failed: ${words}`, ok: item.ok, links };
  });
}
