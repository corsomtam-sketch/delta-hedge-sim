import { Connection, PublicKey } from "@solana/web3.js";
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  PoolUtil,
  PriceMath,
} from "@orca-so/whirlpools-sdk";
import Decimal from "decimal.js";

// ── Token maps ──────────────────────────────────────────────────────

const TOKEN_SYMBOLS = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
  "So11111111111111111111111111111111111111112": "SOL",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": "mSOL",
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE": "ORCA",
  "3dQTr7ror2QPKQ3GbBCokJUmjErGg8kTJzdnYjNfvi3Z": "BORG",
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": "PYTH",
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof": "RENDER",
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ": "W",
};

const STABLECOINS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

// Reverse lookup: symbol → mint address
const SYMBOL_TO_MINT = {};
for (const [mint, sym] of Object.entries(TOKEN_SYMBOLS)) {
  SYMBOL_TO_MINT[sym] = mint;
}

function getTokenSymbol(mint) {
  return TOKEN_SYMBOLS[mint] || mint.slice(0, 4) + "..." + mint.slice(-4);
}

// ── Orca client setup ───────────────────────────────────────────────

let _client = null;
let _connection = null;

export function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _connection;
}

export function getClient() {
  if (!_client) {
    const connection = getConnection();
    const ctx = WhirlpoolContext.withProvider(
      { connection, wallet: null, opts: { commitment: "confirmed" } },
      ORCA_WHIRLPOOL_PROGRAM_ID
    );
    _client = buildWhirlpoolClient(ctx);
  }
  return _client;
}

// ── Wallet position discovery ───────────────────────────────────────

export async function getWalletPositions() {
  const connection = getConnection();
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) throw new Error("WALLET_ADDRESS not set");

  const wallet = new PublicKey(walletAddress);
  const positions = [];

  const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet, { programId });

      for (const { account } of tokenAccounts.value) {
        const tokenAmount = account.data.parsed.info.tokenAmount;

        if (tokenAmount.uiAmount === 1 && tokenAmount.decimals === 0) {
          const mint = new PublicKey(account.data.parsed.info.mint);

          try {
            const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mint);
            const positionAccount = await connection.getAccountInfo(positionPda.publicKey);

            if (positionAccount && positionAccount.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) {
              positions.push({
                mint: mint.toBase58(),
                positionAddress: positionPda.publicKey.toBase58(),
              });
            }
          } catch {
            // Not a whirlpool position
          }
        }
      }
    } catch (e) {
      console.error(`Error scanning token program:`, e.message);
    }
  }

  return positions;
}

// ── Fetch position data ─────────────────────────────────────────────

export async function getPositionInfo(positionAddress) {
  const client = getClient();

  try {
    const position = await client.getPosition(new PublicKey(positionAddress));
    const positionData = position.getData();
    const whirlpool = await client.getPool(positionData.whirlpool);
    const whirlpoolData = whirlpool.getData();

    const currentTick = whirlpoolData.tickCurrentIndex;
    const lowerTick = positionData.tickLowerIndex;
    const upperTick = positionData.tickUpperIndex;

    const inRange = currentTick >= lowerTick && currentTick < upperTick;

    const tokenA = whirlpool.getTokenAInfo();
    const tokenB = whirlpool.getTokenBInfo();

    const currentPrice = PriceMath.sqrtPriceX64ToPrice(
      whirlpoolData.sqrtPrice,
      tokenA.decimals,
      tokenB.decimals
    );
    const lowerPrice = PriceMath.tickIndexToPrice(lowerTick, tokenA.decimals, tokenB.decimals);
    const upperPrice = PriceMath.tickIndexToPrice(upperTick, tokenA.decimals, tokenB.decimals);

    const tokenAMint = tokenA.mint.toBase58();
    const tokenBMint = tokenB.mint.toBase58();
    const tokenASymbol = getTokenSymbol(tokenAMint);
    const tokenBSymbol = getTokenSymbol(tokenBMint);
    const pairName = `${tokenASymbol}/${tokenBSymbol}`;

    const tokenAmounts = PoolUtil.getTokenAmountsFromLiquidity(
      positionData.liquidity,
      whirlpoolData.sqrtPrice,
      PriceMath.tickIndexToSqrtPriceX64(lowerTick),
      PriceMath.tickIndexToSqrtPriceX64(upperTick),
      true
    );

    const amountA = Number(tokenAmounts.tokenA) / Math.pow(10, tokenA.decimals);
    const amountB = Number(tokenAmounts.tokenB) / Math.pow(10, tokenB.decimals);

    const priceNum = parseFloat(currentPrice.toString());

    let positionValueUSD = 0;
    if (STABLECOINS.has(tokenBMint)) {
      positionValueUSD = amountA * priceNum + amountB;
    } else if (STABLECOINS.has(tokenAMint)) {
      positionValueUSD = amountA + amountB / priceNum;
    } else {
      positionValueUSD = amountA * priceNum + amountB;
    }

    const rangeWidth = parseFloat(upperPrice.toString()) - parseFloat(lowerPrice.toString());
    const rangePercent = rangeWidth / parseFloat(lowerPrice.toString()) * 100;

    return {
      positionAddress,
      pairName,
      positionValueUSD: positionValueUSD.toFixed(2),
      currentPrice: currentPrice.toFixed(6),
      lowerPrice: lowerPrice.toFixed(6),
      upperPrice: upperPrice.toFixed(6),
      inRange,
      rangePercent: Math.round(rangePercent),
      amountA: amountA.toFixed(6),
      amountB: amountB.toFixed(6),
      tokenASymbol,
      tokenBSymbol,
      tokenAMint,
      tokenBMint,
    };
  } catch (error) {
    console.error(`Error fetching position ${positionAddress}:`, error.message);
    return null;
  }
}

// ── Hedge calculation ───────────────────────────────────────────────

export function calculateHedge(posInfo) {
  const {
    currentPrice, lowerPrice, upperPrice,
    amountA, amountB,
    tokenASymbol, tokenBSymbol,
    tokenAMint, tokenBMint,
  } = posInfo;

  const price = parseFloat(currentPrice);
  const lower = parseFloat(lowerPrice);
  const upper = parseFloat(upperPrice);
  const numA = parseFloat(amountA);
  const numB = parseFloat(amountB);

  const aIsStable = STABLECOINS.has(tokenAMint);
  const bIsStable = STABLECOINS.has(tokenBMint);

  let hedgeType, hedgeAsset, hedgeAmount, hedgeAmountUSD, entry;

  if (bIsStable) {
    // tokenA is volatile (e.g., SOL/USDC, BORG/USDC)
    hedgeType = "SHORT";
    hedgeAsset = tokenASymbol;
    hedgeAmount = numA;
    hedgeAmountUSD = numA * price;
    entry = price;
  } else if (aIsStable) {
    // tokenB is volatile (e.g., USDC/SOL — rare but possible)
    hedgeType = "LONG";
    hedgeAsset = tokenBSymbol;
    hedgeAmount = numB;
    hedgeAmountUSD = numB * price;
    entry = price;
  } else {
    // Both volatile — hedge the larger USD exposure
    const usdA = numA * price;
    const usdB = numB; // assume tokenB price ~1 relative to tokenA
    if (usdA >= usdB) {
      hedgeType = "SHORT";
      hedgeAsset = tokenASymbol;
      hedgeAmount = numA;
      hedgeAmountUSD = usdA;
      entry = price;
    } else {
      hedgeType = "LONG";
      hedgeAsset = tokenBSymbol;
      hedgeAmount = numB;
      hedgeAmountUSD = usdB;
      entry = price;
    }
  }

  // TP/SL based on range bounds
  let takeProfit, stopLoss;
  if (hedgeType === "SHORT") {
    takeProfit = lower * 0.96; // range bottom - 4%
    stopLoss = upper * 1.02;   // range top + 2%
  } else {
    takeProfit = upper * 1.04; // range top + 4%
    stopLoss = lower * 0.98;   // range bottom - 2%
  }

  // Leverage table
  const leverages = [2, 3, 5, 10];
  const leverageTable = leverages.map((lev) => {
    const margin = hedgeAmountUSD / lev;
    let liqPrice;
    if (hedgeType === "SHORT") {
      liqPrice = entry * (1 + 1 / lev);
    } else {
      liqPrice = entry * (1 - 1 / lev);
    }
    return {
      leverage: lev,
      margin: margin.toFixed(2),
      liqPrice: liqPrice.toFixed(2),
    };
  });

  return {
    type: hedgeType,
    asset: hedgeAsset,
    amount: hedgeAmount.toFixed(6),
    amountUSD: hedgeAmountUSD.toFixed(2),
    entry: entry.toFixed(4),
    takeProfit: takeProfit.toFixed(4),
    stopLoss: stopLoss.toFixed(4),
    leverageTable,
  };
}

// ── Simulation ──────────────────────────────────────────────────────

export function simulatePosition({ pair, rangeLow, rangeHigh, amount, amountA: inputAmountA, amountB: inputAmountB, currentPrice: inputCurrentPrice, entryToken }) {
  // Parse pair (e.g., "SOL/USDC")
  const [symbolA, symbolB] = pair.split("/");
  const mintA = SYMBOL_TO_MINT[symbolA];
  const mintB = SYMBOL_TO_MINT[symbolB];

  if (!mintA || !mintB) {
    throw new Error(`Unknown pair: ${pair}. Known tokens: ${Object.keys(SYMBOL_TO_MINT).join(", ")}`);
  }

  const aIsStable = STABLECOINS.has(mintA);
  const bIsStable = STABLECOINS.has(mintB);

  let currentPrice;
  let amountA = 0;
  let amountB = 0;

  if (entryToken === "BOTH") {
    // Mixed entry — user provides both amounts and current price
    amountA = inputAmountA;
    amountB = inputAmountB;
    currentPrice = inputCurrentPrice;
  } else if (entryToken === symbolA) {
    // All tokenA entry — price is at or below rangeLow
    amountA = amount;
    amountB = 0;
    currentPrice = rangeLow;
  } else if (entryToken === symbolB) {
    // All tokenB entry — price is at or above rangeHigh
    amountA = 0;
    amountB = amount;
    currentPrice = rangeHigh;
  } else {
    throw new Error(`entryToken must be ${symbolA}, ${symbolB}, or BOTH`);
  }

  // Calculate position USD value
  let positionValueUSD;
  if (bIsStable) {
    positionValueUSD = amountA * currentPrice + amountB;
  } else if (aIsStable) {
    positionValueUSD = amountA + (currentPrice > 0 ? amountB / currentPrice : 0);
  } else {
    positionValueUSD = amountA * currentPrice + amountB;
  }

  const rangePercent = ((rangeHigh - rangeLow) / rangeLow) * 100;

  const posInfo = {
    currentPrice: currentPrice.toFixed(6),
    lowerPrice: rangeLow.toFixed(6),
    upperPrice: rangeHigh.toFixed(6),
    amountA: amountA.toFixed(6),
    amountB: amountB.toFixed(6),
    tokenASymbol: symbolA,
    tokenBSymbol: symbolB,
    tokenAMint: mintA,
    tokenBMint: mintB,
  };

  const hedge = calculateHedge(posInfo);

  // Mid-range estimate: at midpoint, position is roughly 50/50 by value
  const midPrice = (rangeLow + rangeHigh) / 2;
  const totalValueAtMid = positionValueUSD; // value stays approximately the same

  let midAmountA, midAmountB;
  if (bIsStable) {
    // At mid-range, ~50% in each token by value
    const halfValue = totalValueAtMid / 2;
    midAmountA = halfValue / midPrice;
    midAmountB = halfValue;
  } else if (aIsStable) {
    const halfValue = totalValueAtMid / 2;
    midAmountA = halfValue;
    midAmountB = halfValue * midPrice;
  } else {
    const halfValue = totalValueAtMid / 2;
    midAmountA = halfValue / midPrice;
    midAmountB = halfValue;
  }

  const midPosInfo = {
    ...posInfo,
    currentPrice: midPrice.toFixed(6),
    amountA: midAmountA.toFixed(6),
    amountB: midAmountB.toFixed(6),
  };

  const midRangeHedge = calculateHedge(midPosInfo);

  return {
    pairName: pair,
    positionValueUSD: positionValueUSD.toFixed(2),
    currentPrice: currentPrice.toFixed(6),
    lowerPrice: rangeLow.toFixed(6),
    upperPrice: rangeHigh.toFixed(6),
    inRange: currentPrice >= rangeLow && currentPrice < rangeHigh,
    rangePercent: Math.round(rangePercent),
    amountA: amountA.toFixed(6),
    amountB: amountB.toFixed(6),
    tokenASymbol: symbolA,
    tokenBSymbol: symbolB,
    entryToken,
    hedge,
    midRangeHedge: {
      ...midRangeHedge,
      atPrice: midPrice.toFixed(4),
    },
  };
}

// ── Pool list for dropdown ──────────────────────────────────────────

export function getAvailablePairs() {
  const symbols = Object.values(TOKEN_SYMBOLS);
  const stableSymbols = ["USDC", "USDT"];
  const volatileSymbols = symbols.filter((s) => !stableSymbols.includes(s));

  const pairs = [];
  for (const vol of volatileSymbols) {
    for (const stable of stableSymbols) {
      pairs.push(`${vol}/${stable}`);
    }
  }
  // Also add some vol/vol pairs
  pairs.push("SOL/BORG", "SOL/JUP", "SOL/BONK");

  return pairs;
}

// ── Fetch all positions with hedges ─────────────────────────────────

export async function getAllPositionsWithHedges() {
  const walletPositions = await getWalletPositions();
  const results = [];

  for (const wp of walletPositions) {
    const info = await getPositionInfo(wp.positionAddress);
    if (!info) continue;

    const hedge = calculateHedge(info);

    results.push({
      ...info,
      hedge,
    });
  }

  // Sort by USD value descending
  results.sort((a, b) => parseFloat(b.positionValueUSD) - parseFloat(a.positionValueUSD));

  return results;
}
