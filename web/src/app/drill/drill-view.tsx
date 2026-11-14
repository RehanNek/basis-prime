'use client';
// The testnet drill panel (PLAN.md 5.8; INTERFACES.md 17): the nBTC/BTC ratio the drill contract holds, which
// pb-risk reads on testnet in place of its price readings; the 1Click stand-in's fault switch; and the commands that
// run the drill. The slide runs from the command line with the operator's key, so nobody touches anything once it
// starts. The drill contract's owner can also set the ratio here with the wallet.
import { useState } from 'react';

import { ApiProblem } from '@/components/notices';
import { TxStatus } from '@/components/tx-status';
import { useApi } from '@/hooks/use-api';
import { useTx } from '@/hooks/use-tx';
import { FactoryContract } from '@/config';
import { accountPath, ApiError, DRILL_PATH, setFault, type AccountAnswer, type DrillAnswer, type FaultMode } from '@/lib/api';
import { accountIdFor, nameProblem } from '@/lib/names';
import { showLevel, slideCommand, slideFromBands, slideProblem } from '@/lib/risk';
import { setRatioTx } from '@/lib/tx';
import { useNearWallet } from '@/providers/near-provider';

export function DrillView() {
  const drill = useApi<DrillAnswer>(DRILL_PATH, 10_000);
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 960 }}>
      <h1 className="h3">Drill</h1>
      <p className="lead">
        Testnet only. Shock the nBTC/BTC ratio to play a bridge depeg, and switch on 1Click faults, then watch the keeper and the account handle them
        on the Risk page.
      </p>
      <ApiProblem error={drill.error} />
      <Ratio drill={drill.data} reload={drill.reload} />
      <Faults drill={drill.data} reload={drill.reload} />
      <Commands />
    </main>
  );
}

function Ratio({ drill, reload }: { drill: DrillAnswer | undefined; reload: () => void }) {
  const { signedAccountId } = useNearWallet();
  const [text, setText] = useState('0.75');
  const tx = useTx();
  const problem = slideProblem(text) ?? (text.includes(',') ? 'One ratio here' : null);
  const isOwner = Boolean(drill?.owner && signedAccountId === drill.owner);
  const set = async (bp: number, label: string) => {
    if (!drill) return;
    await tx.run(label, setRatioTx(drill.drill_id, bp));
    reload();
  };
  const setAt = drill?.ratio ? Number(BigInt(drill.ratio.set_at) / 1_000_000n) : null;
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">The nBTC/BTC ratio</div>
      <div className="card-body small">
        {!drill ? (
          <p className="mb-0">Reading the drill contract…</p>
        ) : !drill.deployed || !drill.ratio ? (
          <p className="mb-0">The drill contract {drill.drill_id} isn&apos;t live yet.</p>
        ) : (
          <>
            <p className="mb-2">
              <span className="fs-4 font-monospace">{showLevel('pi', drill.ratio.bp)}</span>{' '}
              {drill.ratio.bp < 10_000 ? <span className="badge text-bg-warning">nBTC is below BTC</span> : <span className="badge text-bg-success">At par</span>}
            </p>
            <p className="mb-2">
              Set {setAt ? new Date(setAt).toLocaleString() : '?'} on <code>{drill.drill_id}</code>, owned by <code>{drill.owner ?? '?'}</code>. On testnet the risk engine
              reads this as nBTC&apos;s price against BTC, at once. 1.0000 is par.
            </p>
            {isOwner ? (
              <div className="d-flex flex-wrap gap-2 align-items-center">
                <div className="input-group input-group-sm" style={{ maxWidth: 200 }}>
                  <input className="form-control" value={text} onChange={(e) => setText(e.target.value)} aria-label="The ratio to set" />
                  <button className="btn btn-outline-danger" disabled={Boolean(problem) || tx.busy} onClick={() => set(Math.round(Number(text) * 10_000), `Set the ratio to ${text}`)}>
                    Set
                  </button>
                </div>
                <button className="btn btn-sm btn-outline-secondary" disabled={tx.busy} onClick={() => set(10_000, 'Reset the ratio to 1.0')}>
                  Reset to 1.0
                </button>
                {text && problem && <span className="text-danger">{problem}</span>}
              </div>
            ) : (
              <p className="text-body-secondary mb-0">Only the drill&apos;s owner can set it. The slide below runs from the command line with its key.</p>
            )}
            <TxStatus record={tx.last} busy={tx.busy} />
          </>
        )}
      </div>
    </section>
  );
}

const FAULTS: { mode: FaultMode; label: string; words: string }[] = [
  { mode: 'none', label: 'No fault', words: 'Every swap is delivered after its quoted time.' },
  { mode: 'refund', label: 'Refund', words: 'The deposit goes back to whoever sent it, as REFUNDED.' },
  { mode: 'fail', label: 'Failure', words: 'Nothing moves, as FAILED; the deposit stays with 1Click.' },
  { mode: 'late', label: 'Late delivery', words: 'Delivered, but this many seconds after the quoted time.' },
];

function Faults({ drill, reload }: { drill: DrillAnswer | undefined; reload: () => void }) {
  const [delay, setDelay] = useState('120');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const delaySeconds = Number(delay);
  const delayOk = Number.isInteger(delaySeconds) && delaySeconds >= 1 && delaySeconds <= 86_400;
  const choose = async (mode: FaultMode) => {
    setBusy(true);
    setError(null);
    try {
      await setFault(mode, mode === 'late' ? delaySeconds : undefined);
      reload();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const current = drill?.fault;
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">1Click faults</div>
      <div className="card-body small">
        <p className="mb-2">
          On testnet our stand-in plays 1Click. Its fault switch applies to every swap whose deposit arrives while it is on, so a move to or from
          Hyperliquid can be refunded, fail or arrive late. The account&apos;s pending transfers on the Risk page show how it copes.
        </p>
        {!drill ? null : !drill.faults_enabled ? (
          <p className="text-body-secondary mb-0">{drill.fault_error ?? 'The fault switch is off.'}</p>
        ) : (
          <>
            <p className="mb-2">
              In force:{' '}
              {current ? (
                <span className={`badge text-bg-${current.mode === 'none' ? 'success' : 'warning'}`}>
                  {FAULTS.find((f) => f.mode === current.mode)?.label ?? current.mode}
                  {current.mode === 'late' ? `, ${current.delaySeconds} s` : ''}
                </span>
              ) : (
                <span className="text-danger">{drill.fault_error ?? 'unknown'}</span>
              )}
            </p>
            <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
              {FAULTS.map((f) => (
                <button key={f.mode} className={`btn btn-sm ${current?.mode === f.mode ? 'btn-dark' : 'btn-outline-dark'}`} disabled={busy || (f.mode === 'late' && !delayOk)} onClick={() => choose(f.mode)} title={f.words}>
                  {f.label}
                </button>
              ))}
              <div className="input-group input-group-sm" style={{ maxWidth: 190 }}>
                <span className="input-group-text">late by</span>
                <input className="form-control" value={delay} onChange={(e) => setDelay(e.target.value)} aria-label="Seconds late" />
                <span className="input-group-text">s</span>
              </div>
            </div>
            <ul className="mb-0">
              {FAULTS.map((f) => (
                <li key={f.mode}>
                  <strong>{f.label}:</strong> {f.words}
                </li>
              ))}
            </ul>
            {error && <div className="alert alert-warning py-1 px-2 mt-2 mb-0">{error}</div>}
          </>
        )}
      </div>
    </section>
  );
}

function Commands() {
  const [points, setPoints] = useState('0.82,0.78,0.75');
  const [every, setEvery] = useState('2');
  const [name, setName] = useState('drill1');
  const problem = slideProblem(points) ?? (Number(every) > 0 && Number(every) <= 60 ? null : 'Minutes between steps: above 0, at most 60');
  const nameOk = name !== '' && nameProblem(name, FactoryContract) === null;
  const account = useApi<AccountAnswer>(nameOk ? accountPath(accountIdFor(name, FactoryContract)) : null, 30_000);
  const suggested = account.data?.state ? slideFromBands(account.data.state.verdict?.verdict.bands) : null;
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Run the drill</div>
      <div className="card-body small">
        <p className="mb-2">
          The slide walks the ratio down by itself, with the operator&apos;s key, so nobody touches anything after starting it. The keeper must be running:
          it asks for checks as the ratio crosses the bands, confirms DELEVERAGE with a second check about 2.5 minutes later, and runs the plan.
        </p>
        <p className="mb-2">
          Each step should land just past one of the account&apos;s bands, so it goes WATCH, then MARGIN_CALL, then DELEVERAGE. The bands move with BTC:
          on the small demo book at $75,800 they are 0.8406, 0.7970 and 0.7594, so 0.82, 0.78 and 0.75 work there, and 0.84, 0.80, 0.75 would skip the margin
          call. Hold each level about 2 minutes, so the keeper can notice and get a verdict.
        </p>
        <div className="d-flex flex-wrap gap-2 mb-2">
          <div className="input-group input-group-sm" style={{ maxWidth: 240 }}>
            <span className="input-group-text">account</span>
            <input className="form-control" value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} aria-label="The drill's account name" />
          </div>
          {suggested ? (
            <span className="align-self-center">
              Its bands suggest <code>{suggested}</code>{' '}
              <button className="btn btn-sm btn-outline-secondary ms-1" onClick={() => setPoints(suggested)}>
                Use them
              </button>
            </span>
          ) : (
            nameOk && account.data && <span className="align-self-center text-body-secondary">Its last check has no nBTC bands: they come with a loan.</span>
          )}
          {/* Privacy level 1 (INTERFACES.md 48): the backend shows an account only to its owner and to us. */}
          {nameOk && !account.data && account.error?.code === 'sign_in' && (
            <span className="align-self-center text-body-secondary">Connect the wallet that owns this account and confirm it, on Home, to read its bands here.</span>
          )}
          {nameOk && !account.data && account.error?.code === 'not_yours' && (
            <span className="align-self-center text-body-secondary">This name belongs to another wallet, so its bands can’t be read here.</span>
          )}
        </div>
        <div className="d-flex flex-wrap gap-2 mb-2">
          <div className="input-group input-group-sm" style={{ maxWidth: 300 }}>
            <span className="input-group-text">ratios</span>
            <input className="form-control font-monospace" value={points} onChange={(e) => setPoints(e.target.value)} aria-label="The slide's ratios" />
          </div>
          <div className="input-group input-group-sm" style={{ maxWidth: 200 }}>
            <span className="input-group-text">every</span>
            <input className="form-control" value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Minutes between steps" />
            <span className="input-group-text">min</span>
          </div>
        </div>
        {problem ? <p className="text-danger">{problem}</p> : <Command text={slideCommand(points, every, nameOk ? name : undefined)} />}
        <p className="mb-1 mt-3">Or let the tool read the account&apos;s bands itself:</p>
        <Command text={`pnpm --filter @pb/keeper drill -- --slide auto --account ${nameOk ? name : '<name>'} --every ${problem ? '2' : every}`} />
        <p className="mb-1 mt-3">Afterwards, back to par:</p>
        <Command text={`pnpm --filter @pb/keeper drill -- --reset${nameOk ? ` --account ${name}` : ''}`} />
        <p className="mt-2 mb-0 text-body-secondary">
          With --account, the tool sets that account&apos;s own ratio, so the drill moves only it, once the drill contract has per-account ratios
          (set_ratio_for). Until then it sets the shared ratio, which every account reads, and says so.
        </p>
        <p className="mb-1 mt-3">The keeper, in its own terminal (JSON lines; its status on http://127.0.0.1:8789/):</p>
        <Command text="pnpm --filter @pb/keeper start" />
        <p className="mb-1 mt-3">
          The whole gate, from a fresh account to the close-out, while the keeper runs. It takes the slide from a preview of the account once the loan is out,
          and moves to the next level once the state has shown:
        </p>
        <Command text={`pnpm --filter @pb/keeper drill:demo -- --name ${nameOk ? name : '<label>'}`} />
        <p className="mb-1 mt-3">The three faults, each on a small move, on an account of their own:</p>
        <Command text="pnpm --filter @pb/keeper faults -- --name faults1" />
      </div>
    </section>
  );
}

function Command({ text }: { text: string }) {
  return <pre className="bg-body-tertiary border rounded p-2 mb-0 text-wrap user-select-all">{text}</pre>;
}
