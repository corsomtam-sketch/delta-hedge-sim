// ── Render helpers ──────────────────────────────────────────────────

function renderRangeBar(current, lower, upper) {
  const cur = parseFloat(current);
  const lo = parseFloat(lower);
  const hi = parseFloat(upper);
  const range = hi - lo;
  let pct = range > 0 ? ((cur - lo) / range) * 100 : 50;
  pct = Math.max(-10, Math.min(110, pct));

  const dotLeft = Math.max(0, Math.min(100, pct));

  return `
    <div class="range-bar-container">
      <div class="range-bar">
        <div class="range-bar-fill"></div>
        <div class="range-bar-dot" style="left: ${dotLeft}%"></div>
      </div>
      <div class="range-labels">
        <span>${formatPrice(lower)}</span>
        <span>${formatPrice(current)}</span>
        <span>${formatPrice(upper)}</span>
      </div>
    </div>
  `;
}

function formatPrice(p) {
  const num = parseFloat(p);
  if (num >= 1000) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  if (num >= 0.01) return num.toFixed(4);
  return num.toFixed(6);
}

function formatUSD(v) {
  return "$" + parseFloat(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderLeverageTable(table) {
  if (!table || table.length === 0) return "";
  const rows = table.map((r) => `
    <tr>
      <td>${r.leverage}x</td>
      <td>${formatUSD(r.margin)}</td>
      <td>${formatPrice(r.liqPrice)}</td>
    </tr>
  `).join("");

  return `
    <table class="leverage-table">
      <thead>
        <tr><th>Lev</th><th>Margin</th><th>Liq Price</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderHedge(hedge) {
  if (!hedge) return '<p class="no-hedge">No hedge data</p>';

  const amount = parseFloat(hedge.amount);
  if (amount === 0 || isNaN(amount)) {
    return '<p class="hedge-direction none">No hedge needed right now</p>';
  }

  const dirClass = hedge.type === "SHORT" ? "short" : "long";

  return `
    <div class="hedge-direction ${dirClass}">
      ${hedge.type} ${formatPrice(hedge.amount)} ${hedge.asset} (${formatUSD(hedge.amountUSD)})
    </div>
    <div class="hedge-details">
      Entry: <span>${formatPrice(hedge.entry)}</span> &nbsp;|&nbsp;
      TP: <span>${formatPrice(hedge.takeProfit)}</span> &nbsp;|&nbsp;
      SL: <span>${formatPrice(hedge.stopLoss)}</span>
    </div>
    ${renderLeverageTable(hedge.leverageTable)}
  `;
}

function renderPositionCard(pos) {
  const badgeClass = pos.inRange ? "in-range" : "out-of-range";
  const badgeText = pos.inRange ? "In Range" : "Out of Range";

  const priceNum = parseFloat(pos.currentPrice);
  const aUSD = parseFloat(pos.amountA) * priceNum;
  const bVal = parseFloat(pos.amountB);

  const stables = ["USDC", "USDT"];
  const bIsStable = stables.includes(pos.tokenBSymbol);

  let amountsHTML;
  if (bIsStable) {
    amountsHTML = `
      <span>${pos.tokenASymbol}: ${formatPrice(pos.amountA)} (${formatUSD(aUSD)})</span>
      <span>${pos.tokenBSymbol}: ${formatUSD(bVal)}</span>
    `;
  } else {
    amountsHTML = `
      <span>${pos.tokenASymbol}: ${formatPrice(pos.amountA)}</span>
      <span>${pos.tokenBSymbol}: ${formatPrice(pos.amountB)}</span>
    `;
  }

  return `
    <div class="position-card">
      <div class="card-header">
        <h3>${pos.pairName}</h3>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="card-value">${formatUSD(pos.positionValueUSD)}</div>
      ${renderRangeBar(pos.currentPrice, pos.lowerPrice, pos.upperPrice)}
      <div class="amounts-row">${amountsHTML}</div>
      <div class="hedge-section">
        ${renderHedge(pos.hedge)}
      </div>
    </div>
  `;
}

// ── Simulate ────────────────────────────────────────────────────────

async function loadPools() {
  try {
    const res = await fetch("/api/pools");
    const pools = await res.json();

    const select = document.getElementById("sim-pair");
    select.innerHTML = pools.map((p) => `<option value="${p}">${p}</option>`).join("");

    updateTokenDropdown();
    select.addEventListener("change", updateTokenDropdown);
    document.getElementById("sim-token").addEventListener("change", toggleAmountFields);
  } catch (err) {
    console.error("Failed to load pools:", err);
  }
}

function updateTokenDropdown() {
  const pair = document.getElementById("sim-pair").value;
  const [a, b] = pair.split("/");
  const tokenSelect = document.getElementById("sim-token");
  tokenSelect.innerHTML = `<option value="${a}">${a}</option><option value="${b}">${b}</option><option value="BOTH">Both</option>`;
  document.getElementById("amount-a-label").textContent = a;
  document.getElementById("amount-b-label").textContent = b;
  toggleAmountFields();
}

function toggleAmountFields() {
  const isBoth = document.getElementById("sim-token").value === "BOTH";
  document.getElementById("single-amount").style.display = isBoth ? "none" : "";
  document.getElementById("both-amounts").style.display = isBoth ? "" : "none";
  document.getElementById("sim-price-label").style.display = isBoth ? "" : "none";

  // Toggle required attributes
  document.getElementById("sim-amount").required = !isBoth;
  document.getElementById("sim-amount-a").required = isBoth;
  document.getElementById("sim-amount-b").required = isBoth;
  document.getElementById("sim-price").required = isBoth;
}

loadPools();

document.getElementById("sim-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Calculating...";

  const resultDiv = document.getElementById("sim-result");
  resultDiv.innerHTML = '<div class="loading">Calculating hedge...</div>';

  try {
    const entryToken = document.getElementById("sim-token").value;
    const body = {
      pair: document.getElementById("sim-pair").value,
      rangeLow: document.getElementById("sim-range-low").value,
      rangeHigh: document.getElementById("sim-range-high").value,
      entryToken,
    };

    if (entryToken === "BOTH") {
      body.amountA = document.getElementById("sim-amount-a").value;
      body.amountB = document.getElementById("sim-amount-b").value;
      body.currentPrice = document.getElementById("sim-price").value;
    } else {
      body.amount = document.getElementById("sim-amount").value;
    }

    const res = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Simulation failed");
    }

    const result = await res.json();

    let html = renderPositionCard(result);

    if (result.midRangeHedge) {
      const mid = result.midRangeHedge;
      const midAmount = parseFloat(mid.amount);

      let noteText;
      if (midAmount === 0 || isNaN(midAmount)) {
        noteText = `At mid-range (~${formatPrice(mid.atPrice)}): no hedge needed`;
      } else {
        noteText = `At mid-range (~${formatPrice(mid.atPrice)}): hedge adjusts to <strong>${mid.type} ${formatPrice(mid.amount)} ${mid.asset} (${formatUSD(mid.amountUSD)})</strong>`;
      }

      html += `<div class="mid-range-note">${noteText}</div>`;
    }

    resultDiv.innerHTML = html;
  } catch (err) {
    resultDiv.innerHTML = `<div class="error">${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Calculate Hedge";
  }
});
