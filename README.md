# Agentic — Agentical Glyphs Mint Helper

This repository contains a narrowly scoped helper for preparing **one** Agentical Glyphs mint from the configured Binance Agentic Wallet. It is not a general-purpose wallet, does not hold keys, and does not support transfers, token approvals, swaps, or arbitrary contract calls.

## Locked request

- Chain: BNB Smart Chain, chain ID `56`
- Wallet: `0x1E0ee1c082084c17f0078bbC0909c6f64Bd8ae5b`
- Contract: `0x111738f3937547BF9FB2CA36B0E9ef0fcDD18d89`
- Function: `mint(uint256 qty, uint256 answer)`
- Quantity: `1`
- Expected challenge answer: `1263` (the helper independently recomputes it and stops if it differs)
- Exact authorized value: `667000000000000` wei (`0.000667 BNB`)

The helper stops if the connected wallet differs, Developer Mode is disabled/expired, the Agent ID is empty, `allowedQty` is zero, the live quote differs from the exact authorized value, the computed answer differs from 1263, the preview targets another contract/value, the preview contains an allowance/authority change, or the preview would broadcast without Binance App confirmation.

## Requirements

- Node.js 22 or later
- Binance Agentic Wallet CLI (`@binance/agentic-wallet`) installed and authenticated on the machine running this helper
- The Binance Agentic Wallet Skill installed and current
- Developer Mode enabled in Binance App: Agentic Wallet management → Settings → Developer Mode

Install the CLI and skill using Binance's official instructions:

```powershell
npm install -g @binance/agentic-wallet
npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet
```

If the wallet is not connected, follow Binance's official `baw auth signin --json` → QR approval → `baw auth verify` flow. Never paste QR pairing codes, session tokens, private keys, or recovery phrases into chat.

## Run on Windows PowerShell

Clone this repository, then from its directory:

```powershell
npm install
npm run check
baw wallet status --json
baw wallet settings --json
npm run inspect
```

`inspect` is read-only. It checks wallet identity and Developer Mode, then reads `agentIdOf`, `challengeOf`, and `quote` on BSC.

If the inspection passes, create the transaction preview:

```powershell
npm run prepare
```

Review the entire JSON output. It must show the exact wallet, contract, `qty=1`, `answer=1263`, `value=667000000000000 wei`, no allowance/authority changes, and `requireConfirmation=true`. Review every item in `risks` and `riskDetails`. If anything is missing, different, or flagged in a way you do not accept, stop.

Only after reviewing the preview and deciding to proceed, request the Binance App confirmation:

```powershell
npm run execute -- --request-app-confirmation
```

This submits the already-previewed request to Binance Agentic Wallet. If it returns `PENDING_CONFIRMATION`, approve **only the matching mint transaction** in Binance App. Do not approve any other request. If Binance reports `BROADCASTED` directly, this helper will report it; it will not claim that App confirmation occurred.

After the wallet returns a transaction hash, inspect the receipt and ERC-721 Transfer token ID:

```powershell
npm run receipt -- 0xYOUR_TRANSACTION_HASH
```

## Important implementation notes

- This code does not itself sign or store private keys. Binance Agentic Wallet remains the signer.
- The helper deliberately fails closed. It does not change quantity, answer, contract, chain, or BNB value to make a transaction pass.
- The ABI return types used for the three read methods are declared in `src/mint.mjs`. If the live contract does not match them, the helper stops rather than guessing.
- The receipt parser recognizes ERC-721 `Transfer` events emitted by the specified contract. It reports a tier only for token IDs in the supplied phase ranges (#6–#500 free, #501–#3,500 paid).
- The RPC endpoint defaults to the public BNB Chain endpoint. You can override it with `BSC_RPC_URL`.
- Run this helper on a trusted machine. The local preview state file contains a short-lived request ID; do not publish it.
