// `pnpm --filter @pb/keeper funding:demo -- --lender rhea|aave [--moves]`: one command for the funding gates
// (FUNDING.md 10). Gate 2, Rhea and pricing, is funding-demo.ts; gate 3, Aave, is aave-demo.ts; gate 4, the moves
// between NEAR and Aave's chain (`--lender aave --moves`), is moves-demo.ts. Each reads its own flags.
const argv = process.argv.slice(2);
const at = argv.indexOf("--lender");
const lender = at >= 0 ? argv[at + 1] : argv.find((a) => a.startsWith("--lender="))?.slice("--lender=".length);
await import(lender === "aave" ? (argv.includes("--moves") ? "./moves-demo.js" : "./aave-demo.js") : "./funding-demo.js");
