import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { Interface, JsonRpcProvider, getAddress } from "ethers";

const execFileAsync = promisify(execFile);

const CONFIG = Object.freeze({
  chainId: 56,
  rpcUrl: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
  wallet: "0x1E0ee1c082084c17f0078bbC0909c6f64Bd8ae5b",
  contract: "0x111738f3937547BF9FB2CA36B0E9ef0fcDD18d89",
  qty: 1n,
  expectedValueWei: 667000000000000n,
  stateFile: ".agentical-glyphs-preview.json"
});

// Fail closed if the live contract ABI differs from the supplied mint instructions.
const ABI = [
  "function agentIdOf(address wallet) view returns (string)",
  "function challengeOf(address wallet) view returns (uint256 a, uint256 b)",
  "function quote(address wallet, uint256 qty) view returns (uint256 totalCost, uint256 allowedQty)",
  "function mint(uint256 qty, uint256 answer) payable"
];
const iface = new Interface(ABI);
const erc721TransferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function fail(message) {
  console.error("\nSTOP: " + message);
  process.exit(1);
}

function parseJson(stdout, label) {
  try { return JSON.parse(stdout); }
  catch { fail(label + " did not return valid JSON. Raw output:\n" + stdout); }
}

async function baw(args, label) {
  try {
    const { stdout } = await execFileAsync("baw", [...args, "--json"], {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024
    });
    const parsed = parseJson(stdout, label);
    if (parsed.success === false) fail(label + " failed: " + JSON.stringify(parsed));
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") fail("Binance Agentic Wallet CLI 'baw' is not installed or is not on PATH.");
    if (error.stdout) fail(label + " failed: " + error.stdout);
    fail(label + " failed: " + (error.message || String(error)));
  }
}

function dataOf(result) { return result?.data ?? result; }

function expiryIsValid(value) {
  if (value === undefined || value === null || value === "") return true;
  let ms;
  if (typeof value === "number") ms = value < 1e12 ? value * 1000 : value;
  else ms = Date.parse(value);
  return Number.isFinite(ms) && ms > Date.now();
}

async function verifyWalletAndDeveloperMode() {
  const status = dataOf(await baw(["wallet", "status"], "wallet status"));
  if (status.status !== "CONNECTED") fail("Binance Agentic Wallet is not CONNECTED. Connect it with the Binance Agentic Wallet Skill first.");

  const addressResult = dataOf(await baw(["wallet", "address"], "wallet address"));
  const address = addressResult.address || addressResult.walletAddress || addressResult;
  if (typeof address !== "string" || getAddress(address) !== getAddress(CONFIG.wallet)) {
    fail("Connected wallet does not match the requested wallet " + CONFIG.wallet + ". No transaction was prepared.");
  }

  const settings = dataOf(await baw(["wallet", "settings"], "wallet settings"));
  if (settings?.devMode?.enabled !== true || !expiryIsValid(settings?.devMode?.expiresAt)) {
    fail("Developer Mode is disabled or expired. Enable it in Binance App → Agentic Wallet management → Settings, then retry. No preview or transaction was sent.");
  }
  return { address: getAddress(address), settings };
}

async function readMintConditions(wallet) {
  const provider = new JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CONFIG.chainId) fail("RPC returned the wrong chain ID.");

  const contract = new (await import("ethers")).Contract(CONFIG.contract, ABI, provider);
  let agentId, a, b, totalCost, allowedQty;
  try {
    agentId = await contract.agentIdOf(wallet);
    [a, b] = await contract.challengeOf(wallet);
    [totalCost, allowedQty] = await contract.quote(wallet, CONFIG.qty);
  } catch (error) {
    fail("Could not read the expected contract methods / ABI. No transaction was prepared. Details: " + (error.shortMessage || error.message));
  }

  agentId = String(agentId ?? "").trim();
  if (!agentId) fail("This wallet has no .ai Agent ID. Mint stopped.");
  if (agentId.toLowerCase().endsWith(".ai")) agentId = agentId.slice(0, -3);

  const characterCount = Array.from(agentId).length;
  const answer = BigInt(a) * BigInt(b) + BigInt(characterCount);
  if (BigInt(allowedQty) === 0n) fail("allowedQty is 0. This wallet has reached its mint limit.");
  if (BigInt(allowedQty) < CONFIG.qty) fail("The contract does not allow qty=1 for this wallet.");
  if (BigInt(totalCost) !== CONFIG.expectedValueWei) {
    fail("On-chain quote is " + totalCost.toString() + " wei, but the user authorized exactly " + CONFIG.expectedValueWei.toString() + " wei. Stopping without changing the amount.");
  }

  return {
    agentId,
    characterCount,
    a: BigInt(a).toString(),
    b: BigInt(b).toString(),
    answer: answer.toString(),
    totalCostWei: BigInt(totalCost).toString(),
    allowedQty: BigInt(allowedQty).toString()
  };
}

async function inspect() {
  const { address } = await verifyWalletAndDeveloperMode();
  const conditions = await readMintConditions(address);
  console.log(JSON.stringify({
    success: true,
    wallet: address,
    chainId: CONFIG.chainId,
    contract: CONFIG.contract,
    qty: CONFIG.qty.toString(),
    ...conditions,
    note: "Read-only checks only. No signing, approval, or transaction was sent."
  }, null, 2));
}

async function prepare() {
  const { address } = await verifyWalletAndDeveloperMode();
  const conditions = await readMintConditions(address);
  const inputData = iface.encodeFunctionData("mint", [CONFIG.qty, BigInt(conditions.answer)]);
  const preview = await baw([
    "contract-call", "preview",
    "--binanceChainId", String(CONFIG.chainId),
    "--from", address,
    "--to", CONFIG.contract,
    "--value", CONFIG.expectedValueWei.toString(),
    "--inputData", inputData
  ], "contract-call preview");

  const previewData = dataOf(preview);
  const requestId = previewData.requestId;
  if (!requestId || typeof requestId !== "string") fail("Preview did not return a requestId. Execute is forbidden.");

  const record = {
    createdAt: new Date().toISOString(),
    requestId,
    wallet: address,
    contract: CONFIG.contract,
    chainId: CONFIG.chainId,
    qty: CONFIG.qty.toString(),
    answer: conditions.answer,
    valueWei: CONFIG.expectedValueWei.toString(),
    inputData,
    preview
  };
  await writeFile(CONFIG.stateFile, JSON.stringify(record, null, 2), { flag: "w", mode: 0o600 });

  console.log(JSON.stringify({
    success: true,
    stage: "PREVIEW_READY_NOT_EXECUTED",
    requestId,
    wallet: address,
    chainId: CONFIG.chainId,
    contract: CONFIG.contract,
    function: "mint(uint256,uint256)",
    qty: CONFIG.qty.toString(),
    answer: conditions.answer,
    valueWei: CONFIG.expectedValueWei.toString(),
    valueBnb: "0.000667",
    contractChecks: conditions,
    preview: previewData,
    nextStep: "Inspect the parsed transaction and all risks above. Only after the user explicitly agrees, run: npm run execute -- --request-app-confirmation"
  }, null, 2));
}

async function execute() {
  if (!process.argv.includes("--request-app-confirmation")) {
    fail("Execution is disabled unless you explicitly pass --request-app-confirmation after reviewing the preview.");
  }
  let saved;
  try { saved = JSON.parse(await readFile(CONFIG.stateFile, "utf8")); }
  catch { fail("No saved successful preview. Run 'npm run prepare' first."); }

  if (saved.wallet !== CONFIG.wallet || saved.contract !== CONFIG.contract ||
      saved.chainId !== CONFIG.chainId || saved.qty !== "1" ||
      saved.valueWei !== CONFIG.expectedValueWei.toString()) {
    fail("Saved preview does not match the locked mint parameters.");
  }
  await verifyWalletAndDeveloperMode();

  const result = await baw(["contract-call", "execute", "--requestId", saved.requestId], "contract-call execute");
  const data = dataOf(result);
  console.log(JSON.stringify({
    success: true,
    stage: data.status || "SUBMITTED",
    txHash: data.txHash || null,
    message: data.message || null,
    requestId: saved.requestId,
    note: data.status === "PENDING_CONFIRMATION"
      ? "Approve only this matching mint request in Binance App. Do not approve any other request."
      : "Execution response received. Check the transaction receipt before treating the mint as complete."
  }, null, 2));
}

async function receipt() {
  const txHash = process.argv[3];
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) fail("Usage: npm run receipt -- 0x<transaction-hash>");
  const provider = new JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId);
  const txReceipt = await provider.getTransactionReceipt(txHash);
  if (!txReceipt) fail("Transaction receipt is not available yet. Try again later.");
  if (txReceipt.status !== 1) fail("Transaction reverted. Hash: " + txHash);

  const tokenIds = [];
  for (const log of txReceipt.logs) {
    if (log.address.toLowerCase() !== CONFIG.contract.toLowerCase()) continue;
    if (log.topics[0]?.toLowerCase() === erc721TransferTopic && log.topics.length === 4) {
      tokenIds.push(BigInt(log.topics[3]).toString());
    }
  }
  console.log(JSON.stringify({
    success: true,
    txHash,
    status: "CONFIRMED",
    blockNumber: txReceipt.blockNumber,
    contract: CONFIG.contract,
    tokenIds,
    tiers: tokenIds.map(id => ({ tokenId: id, tier: BigInt(id) >= 501n && BigInt(id) <= 3500n ? "Paid phase" : BigInt(id) >= 6n && BigInt(id) <= 500n ? "Free phase" : "Outside the published phase ranges" }))
  }, null, 2));
}

const command = process.argv[2];
if (command === "inspect") await inspect();
else if (command === "prepare") await prepare();
else if (command === "execute") await execute();
else if (command === "receipt") await receipt();
else {
  console.log("Agentical Glyphs mint helper\nCommands: inspect | prepare | execute --request-app-confirmation | receipt <txHash>");
  process.exit(command ? 1 : 0);
}
