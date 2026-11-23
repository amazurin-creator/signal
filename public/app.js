/* Signal — frontend logic */
'use strict';

// ===== Constants =====
const KEY_LS = 'signal_anthropic_key';

// ===== DOM references =====
const reviewsInput   = document.getElementById('reviews-input');
const analyzeBtn     = document.getElementById('analyze-btn');
const loadSampleBtn  = document.getElementById('load-sample-btn');
const csvUpload      = document.getElementById('csv-upload');
const reviewMeta     = document.getElementById('review-meta');
const resultsSection = document.getElementById('results');
const historyList    = document.getElementById('history-list');
const refreshBtn     = document.getElementById('refresh-history-btn');
const toastEl        = document.getElementById('toast');
const keyForm        = document.getElementById('key-form');

// Header stats
const statRuns      = document.getElementById('stat-total-runs');
const statTokens    = document.getElementById('stat-total-tokens');
const statCost      = document.getElementById('stat-total-cost');
const statCacheHits = document.getElementById('stat-cache-hits');

let activeHistoryId = null;
let toastTimer = null;

// ===== Key management =====

function getKey() { return localStorage.getItem(KEY_LS) || ''; }
function saveKey(k) { localStorage.setItem(KEY_LS, k); }
function forgetKey() { localStorage.removeItem(KEY_LS); }

function renderKeySection() {
  const key = getKey();
  if (key) {
    keyForm.innerHTML = `
      <div class="key-saved">
        <span class="key-indicator">✓ API key saved</span>
        <button class="btn-ghost btn-xs" id="forget-btn">Forget</button>
      </div>`;
    document.getElementById('forget-btn').addEventListener('click', () => {
      forgetKey();
      renderKeySection();
      showToast('API key removed');
    });
  } else {
    keyForm.innerHTML = `
      <div class="key-input-row">
        <input type="password" id="key-input" class="key-input" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">
        <button class="btn-ghost btn-xs" id="save-key-btn">Save</button>
      </div>
      <div class="key-hint">Stored only in your browser. Never sent to our server.</div>`;
    const keyInput = document.getElementById('key-input');
    const saveBtn  = document.getElementById('save-key-btn');
    const doSave = () => {
      const val = keyInput.value.trim();
      if (!val) { showToast('Enter a key first', true); return; }
      saveKey(val);
      renderKeySection();
      showToast('API key saved');
    };
    saveBtn.addEventListener('click', doSave);
    keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
  }
}

// ===== Utilities =====

function fmt(n, decimals = 0) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function fmtCost(usd) {
  if (usd === 0) return '$0.00';
  if (usd < 0.0001) return `$${usd.toExponential(2)}`;
  return `$${usd.toFixed(usd < 0.01 ? 6 : 4)}`;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function showToast(msg, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = 'toast visible' + (isError ? ' error' : '');
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3500);
}

function setAnalyzing(loading) {
  analyzeBtn.disabled = loading;
  const icon  = analyzeBtn.querySelector('.btn-icon');
  const label = analyzeBtn.querySelector('.btn-label');
  if (loading) {
    analyzeBtn.classList.add('loading');
    icon.textContent  = '◌';
    label.textContent = 'Analyzing…';
  } else {
    analyzeBtn.classList.remove('loading');
    icon.textContent  = '▶';
    label.textContent = 'Analyze';
  }
}

function countLines(text) {
  if (!text.trim()) return 0;
  return text.trim().split('\n').filter(l => l.trim()).length;
}

function updateReviewMeta() {
  const n = countLines(reviewsInput.value);
  reviewMeta.textContent = n > 0 ? `${n} line${n !== 1 ? 's' : ''} pasted` : '';
}

// ===== CSV Parsing =====

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (!lines.length) return [];

  const header = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
  const textIdx = header.indexOf('text');

  if (textIdx === -1) {
    return lines.map(l => l.replace(/^"|"$/g, '').trim()).filter(Boolean);
  }

  return lines.slice(1).map(line => {
    const cols = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur);
    return (cols[textIdx] || '').trim();
  }).filter(Boolean);
}

// ===== API calls =====

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost(path, data) {
  const key = getKey();
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-Anthropic-Key'] = key;

  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = res.status === 401
      ? 'No API key set. Enter your Anthropic key in the sidebar to run a live analysis.'
      : (body.error || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return body;
}

// ===== Load sample =====

async function loadSample() {
  loadSampleBtn.disabled = true;
  try {
    const sampleData = await apiGet('/sample.json');
    const lines = sampleData.map(r => (typeof r === 'object' ? r.text : r)).filter(Boolean);

    // Always populate the textarea so the user can see what was analyzed
    reviewsInput.value = lines.join('\n');
    updateReviewMeta();

    if (getKey()) {
      // Live analysis
      await analyze();
    } else {
      // No key — show bundled pre-computed demo
      const demoResult = await apiGet('/sample-result.json');
      renderRun(demoResult);
      showToast('Demo loaded — add your Anthropic key to run live');
    }
  } catch (e) {
    showToast(`Failed: ${e.message}`, true);
  } finally {
    loadSampleBtn.disabled = false;
  }
}

// ===== Analyze =====

async function analyze() {
  const text = reviewsInput.value.trim();
  if (!text) { showToast('Paste some reviews first', true); return; }

  const reviews = text.split('\n').filter(l => l.trim());
  if (!reviews.length) { showToast('No valid reviews found', true); return; }

  setAnalyzing(true);
  showLoadingState(reviews.length);

  try {
    const run = await apiPost('/api/analyze', { reviews });
    renderRun(run);
    activeHistoryId = run.id;
    await Promise.all([loadHistory(), updateStats()]);
  } catch (e) {
    showErrorState(e.message);
    showToast(e.message, true);
  } finally {
    setAnalyzing(false);
  }
}

// ===== History =====

async function loadHistory() {
  try {
    const runs = await apiGet('/api/runs');
    renderHistory(runs);
  } catch { /* non-critical */ }
}

async function loadRun(id) {
  try {
    const run = await apiGet(`/api/runs/${id}`);
    renderRun(run);
    activeHistoryId = id;
    renderHistory(await apiGet('/api/runs'));
  } catch (e) {
    showToast(`Failed to load run: ${e.message}`, true);
  }
}

// ===== Stats =====

async function updateStats() {
  try {
    const s = await apiGet('/api/stats');
    statRuns.textContent      = fmt(s.total_runs);
    statTokens.textContent    = fmtTokens((s.total_input_tokens || 0) + (s.total_output_tokens || 0));
    statCost.textContent      = fmtCost(s.total_cost_usd || 0);
    statCacheHits.textContent = fmt(s.cache_hits);
  } catch { /* non-critical */ }
}

// ===== Rendering =====

function showLoadingState(count) {
  resultsSection.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <div class="loading-text">Analyzing ${count} reviews…</div>
    </div>`;
}

function showErrorState(msg) {
  const isAuthErr = msg.includes('API key') || msg.includes('key');
  resultsSection.innerHTML = `
    <div class="empty-state">
      <div class="empty-mark" style="color:#ef4444">✕</div>
      <p class="empty-title" style="color:#ef4444">Analysis failed</p>
      <p class="empty-sub">${escHtml(msg)}</p>
      ${isAuthErr ? '<p class="empty-sub" style="margin-top:8px">↖ Enter your key in the sidebar</p>' : ''}
    </div>`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderRun(run) {
  const dropped  = run.dropped_count || 0;
  const cacheHit = !!run.cache_hit;
  const clusters = run.result?.clusters || [];
  const isDemo   = !!run.demo;

  const metaLine = dropped > 0
    ? `${fmt(run.review_count)} reviews analyzed · <span style="color:var(--text-dim)">${fmt(dropped)} dropped</span>`
    : `${fmt(run.review_count)} reviews analyzed`;

  const demoBanner = isDemo ? `
    <div class="demo-banner">
      ◈ Pre-computed demo — not a live API call.
      Add your Anthropic key and click <strong>Load sample</strong> again to run live.
    </div>` : '';

  resultsSection.innerHTML = `
    ${demoBanner}
    <div class="run-header">
      <div>
        <div class="run-title">Analysis result</div>
        <div class="run-subtitle">${metaLine}</div>
      </div>
      <div style="font-size:0.7rem;color:var(--text-dim)">${isDemo ? 'pre-computed' : timeAgo(run.created_at)}</div>
    </div>

    ${renderTokenMeter(run, cacheHit)}

    <div class="clusters-title">${clusters.length} cluster${clusters.length !== 1 ? 's' : ''} identified</div>
    <div class="clusters-grid">
      ${clusters.map((c, i) => renderCluster(c, i)).join('')}
    </div>`;

  clusters.forEach((c, i) => {
    document.getElementById(`copy-btn-${i}`)
      ?.addEventListener('click', ev => copyTicket(c, ev.currentTarget));
  });
}

function renderTokenMeter(run, cacheHit) {
  if (run.demo) {
    return `<div class="token-meter">
      <div class="meter-item" style="grid-column:1/-1">
        <div class="meter-label">Status</div>
        <div class="cache-status demo">◈ DEMO — pre-computed result</div>
      </div>
      <div class="meter-item">
        <div class="meter-label">Model</div>
        <div class="meter-value" style="font-size:0.72rem">${escHtml(run.model || '')}</div>
      </div>
      <div class="meter-item"><div class="meter-label">Input tokens</div><div class="meter-value mono" style="color:var(--text-dim)">—</div></div>
      <div class="meter-item"><div class="meter-label">Output tokens</div><div class="meter-value mono" style="color:var(--text-dim)">—</div></div>
      <div class="meter-item"><div class="meter-label">Cost</div><div class="meter-value" style="color:var(--text-dim)">—</div></div>
      <div class="meter-item"><div class="meter-label">Latency</div><div class="meter-value mono" style="color:var(--text-dim)">—</div></div>
    </div>`;
  }

  const inTok = run.input_tokens  || 0;
  const outTok = run.output_tokens || 0;
  const statusClass = cacheHit ? 'hit' : 'miss';
  const statusLabel = cacheHit ? '✓ CACHE HIT' : '● NEW RUN';

  return `<div class="token-meter">
    <div class="meter-item">
      <div class="meter-label">Model</div>
      <div class="meter-value" style="font-size:0.72rem">${escHtml(run.model || '')}</div>
    </div>
    <div class="meter-item">
      <div class="meter-label">Input tokens</div>
      <div class="meter-value mono">${fmt(inTok)}</div>
    </div>
    <div class="meter-item">
      <div class="meter-label">Output tokens</div>
      <div class="meter-value mono">${fmt(outTok)}</div>
    </div>
    <div class="meter-item">
      <div class="meter-label">Cost</div>
      <div class="meter-value accent">${fmtCost(run.cost_usd || 0)}</div>
    </div>
    <div class="meter-item">
      <div class="meter-label">Latency</div>
      <div class="meter-value mono">${fmt(run.latency_ms || 0)}ms</div>
    </div>
    <div class="meter-item">
      <div class="meter-label">Cache</div>
      <div class="cache-status ${statusClass}">${statusLabel}</div>
    </div>
  </div>`;
}

const TYPE_ICONS = { bug: '🐛', balance: '⚖️', monetization: '💰', feature_request: '✨', praise: '⭐' };
const SEV_COLORS = ['', '#4ade80', '#a3e635', '#fbbf24', '#f97316', '#ef4444'];

function renderSeverityBar(severity) {
  const sev = Math.max(1, Math.min(5, severity || 1));
  return ['lv1','lv2','lv3','lv4','lv5'].map((lv, i) =>
    `<div class="sev-seg ${i < sev ? `active ${lv}` : ''}"></div>`
  ).join('');
}

function renderCluster(c, idx) {
  const icon  = TYPE_ICONS[c.type] || '◆';
  const share = Math.round((c.share || 0) * 100);
  const quotes = (c.quotes || []).map(q => `<div class="quote-item">"${escHtml(q)}"</div>`).join('');
  const acItems = (c.ticket?.acceptance_criteria || []).map(ac => `<li>${escHtml(ac)}</li>`).join('');

  return `
    <div class="cluster-card">
      <div class="cluster-top">
        <div class="cluster-title">${icon} ${escHtml(c.title)}</div>
        <div class="cluster-badges">
          <span class="type-badge type-${escHtml(c.type)}">${escHtml((c.type || '').replace('_', ' '))}</span>
          <span class="sentiment-badge">${escHtml(c.sentiment || '')}</span>
        </div>
      </div>
      <div class="cluster-meta">
        <div class="severity-wrap">
          <span class="severity-label">Severity</span>
          <div class="severity-bar">${renderSeverityBar(c.severity)}</div>
          <span style="font-family:var(--mono);font-size:0.72rem;color:${SEV_COLORS[c.severity]||'var(--text-dim)'}">${c.severity}/5</span>
        </div>
        <div class="share-wrap">Share: <span class="share-pct">${share}%</span> of reviews</div>
      </div>
      ${quotes ? `<div class="quotes-label">Player quotes</div><div class="quotes-list">${quotes}</div>` : ''}
      <div class="ticket-wrap">
        <div class="ticket-header">
          <span class="ticket-label">◆ Ready Ticket</span>
          <button class="copy-btn" id="copy-btn-${idx}">Copy as Markdown</button>
        </div>
        <div class="ticket-title">${escHtml(c.ticket?.title || '')}</div>
        <div class="ticket-desc">${escHtml(c.ticket?.description || '')}</div>
        ${acItems ? `<div class="ticket-ac-label">Acceptance criteria</div><ul class="ticket-ac-list">${acItems}</ul>` : ''}
      </div>
    </div>`;
}

function getTicketMarkdown(cluster) {
  const t = cluster.ticket || {};
  const ac = (t.acceptance_criteria || []).map(a => `- [ ] ${a}`).join('\n');
  return `# ${t.title || ''}\n\n**Type:** ${(cluster.type||'').replace('_',' ')} | **Severity:** ${cluster.severity}/5 | **Share:** ${Math.round((cluster.share||0)*100)}%\n\n## Description\n\n${t.description||''}\n\n## Acceptance Criteria\n\n${ac}`;
}

function copyTicket(cluster, btn) {
  navigator.clipboard.writeText(getTicketMarkdown(cluster)).then(() => {
    btn.textContent = '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy as Markdown'; btn.classList.remove('copied'); }, 2000);
  }).catch(() => showToast('Clipboard write failed', true));
}

// ===== History rendering =====

function renderHistory(runs) {
  if (!runs || !runs.length) {
    historyList.innerHTML = '<div class="history-empty">No runs yet</div>';
    return;
  }
  historyList.innerHTML = runs.map(r => {
    const isActive = r.id === activeHistoryId;
    const hit = !!r.cache_hit;
    return `
      <div class="history-item${isActive ? ' active' : ''}" data-id="${escHtml(r.id)}">
        <div class="history-item-top">
          <span class="history-id">${escHtml(r.id.slice(0,8))}…</span>
          <span class="history-time">${timeAgo(r.created_at)}</span>
        </div>
        <div class="history-item-meta">
          <span class="history-chip">${fmt(r.review_count)} reviews</span>
          <span class="history-chip">${r.cluster_count} clusters</span>
          <span class="history-chip">${fmtCost(r.cost_usd||0)}</span>
          <span class="cache-badge ${hit?'hit':'miss'}">${hit?'CACHE':'NEW'}</span>
        </div>
      </div>`;
  }).join('');

  historyList.querySelectorAll('.history-item').forEach(el => {
    el.addEventListener('click', () => loadRun(el.dataset.id));
  });
}

// ===== Event listeners =====

analyzeBtn.addEventListener('click', analyze);
loadSampleBtn.addEventListener('click', loadSample);
refreshBtn.addEventListener('click', loadHistory);
reviewsInput.addEventListener('input', updateReviewMeta);
reviewsInput.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); analyze(); }
});
csvUpload.addEventListener('change', e => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const text = ev.target?.result;
    if (typeof text !== 'string') return;
    const reviews = parseCSV(text);
    reviewsInput.value = reviews.join('\n');
    updateReviewMeta();
    showToast(`${reviews.length} reviews loaded from CSV`);
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ===== Init =====

(async function init() {
  renderKeySection();
  await Promise.all([loadHistory(), updateStats()]);
})();
