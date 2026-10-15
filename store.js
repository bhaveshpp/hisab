/* =====================================================================
 *  FINANCE — store.js : local-first data layer (load after common.js)
 *   • ONE dataset (accounts, categories, ALL transactions) is fetched once and cached on the device
 *     (5-minute freshness). Month lists, analysis (month / year / custom, category-wise, day-wise)
 *     and balances are computed from it → switching month / range never calls the API; works offline.
 *   • Add / edit / delete of transactions: instant, saved in the background (⚠ Not saved + Retry on error,
 *     offline changes stay queued — also after a reload).
 *   • Accounts / categories: saved on the server first, then the cache is updated.
 * ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.App) return;
  const A = window.App;

  const D_KEY = 'dukan_data_v1', Q_KEY = 'dukan_queue_v1';
  const TTL = 5 * 60 * 1000, RETRY_MS = 30000;

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* quota / private mode */ } };

  let data = read(D_KEY, null);      // {ts, accounts, categories, txns} — server snapshot
  let queue = read(Q_KEY, []);       // [{id, kind:'save'|'delete', payload, item, old, state:'queued'|'failed', error}]
  let running = false, inflight = null, retryTimer = null;

  const isTmp = (id) => String(id).indexOf('tmp_') === 0;
  const newTmp = () => 'tmp_' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
  const emit = () => window.dispatchEvent(new Event('dukan:change'));
  const saveD = () => write(D_KEY, data);
  const saveQ = () => write(Q_KEY, queue);
  const idle = () => !queue.some((o) => o.state === 'queued') && !inflight;
  const fresh = () => !!data && Date.now() - data.ts < TTL;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const sortDesc = (items) => items.slice().sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

  /* ------------------------------- the view ------------------------------- */
  function applyEffect(t, sign, d) {
    const add = (n, v) => { if (n) d[n] = (d[n] || 0) + v * sign; };
    if (t.type === 'Income') add(t.account, t.amount);
    else if (t.type === 'Transfer') { add(t.account, -t.amount); add(t.to_account, t.amount); }
    else add(t.account, -t.amount);
  }
  /** server snapshot + every unsynced local change (failed ones are shown but not counted in balances). */
  function view() {
    if (!data) return null;
    let txns = data.txns.slice();
    const d = {};
    queue.forEach((op) => {
      if (op.kind === 'delete') txns = txns.filter((x) => x.id !== op.id);
      else { txns = txns.filter((x) => x.id !== op.item.id); txns.push(op.item); }
      if (op.state === 'failed') return;
      if (op.old) applyEffect(op.old, -1, d);
      if (op.kind === 'save') applyEffect(op.item, 1, d);
    });
    // accounts trimmed by the server (no 'accounts' access) have no balance → leave it undefined
    const accounts = data.accounts.map((a) => (a.balance === undefined ? a : Object.assign({}, a, { balance: Math.round(((Number(a.balance) || 0) + (d[a.name] || 0)) * 100) / 100 })));
    return { ts: data.ts, accounts, categories: data.categories, txns: sortDesc(txns) };
  }
  const masters = () => { const v = view(); return v ? { accounts: v.accounts, categories: v.categories, ts: v.ts } : { accounts: [], categories: [], ts: 0 }; };
  const dayItems = (day) => { const v = view(); return v ? v.txns.filter((t) => t.time.slice(0, 10) === day) : []; };     // 'YYYY-MM-DD'
  const monthItems = (y, m) => { const v = view(); const key = y + '-' + A.pad(m + 1); return v ? v.txns.filter((t) => t.time.slice(0, 7) === key) : []; };

  function setMasters(d) { if (data && d && d.accounts) { data.accounts = d.accounts; data.categories = d.categories; } }

  /** Fetch the whole dataset (skipped while fresh, unless forced). Waits for unsynced changes first. */
  async function load(force) {
    if (!force && fresh()) return view();
    await whenIdle(6000);
    const d = await A.call('all_data');
    data = { ts: Date.now(), accounts: d.accounts, categories: d.categories, txns: d.transactions };
    A.updateAccess(d.role, d.access);          // role / access may have changed in the sheet
    saveD(); emit();
    return view();
  }

  /* --------------------- accounts / categories (server first) --------------------- */
  async function writeMasters(action, payload) {
    const d = await A.call(action, payload);
    if (data) { setMasters(d); saveD(); emit(); }
    return d;
  }

  /* ------------------- transactions (optimistic + queue) ------------------- */
  const toPayload = (f, id) => ({ id: id || '', type: f.type, amount: f.amount, time: f.time, note: f.note || '',
    account: f.account || '', category: f.category || '', to_account: f.to_account || '' });
  const opFor = (id) => queue.find((o) => o.id === id && o !== inflight);
  function enqueue(op) { queue.push(op); afterChange(); }
  function afterChange() { saveQ(); emit(); run(); }

  function addTxn(f) {
    const item = Object.assign({}, f, { id: newTmp() });
    enqueue({ id: item.id, kind: 'save', payload: toPayload(f, ''), item, old: null, state: 'queued', error: '' });
    return item;
  }
  function editTxn(old, f) {
    const item = Object.assign({}, f, { id: old.id });
    const payload = toPayload(f, isTmp(old.id) ? '' : old.id);
    const op = opFor(old.id);
    if (op && op.kind === 'save') { op.item = item; op.payload = payload; op.state = 'queued'; op.error = ''; afterChange(); return item; }
    enqueue({ id: old.id, kind: 'save', payload, item, old: isTmp(old.id) ? null : clone(old), state: 'queued', error: '' });
    return item;
  }
  function deleteTxn(item) {
    const op = opFor(item.id);
    if (op && op.kind === 'save') {
      queue = queue.filter((o) => o !== op);
      if (isTmp(item.id)) { afterChange(); return; }          // never reached the sheet
      enqueue({ id: item.id, kind: 'delete', old: op.old || clone(item), state: 'queued', error: '' });
      return;
    }
    enqueue({ id: item.id, kind: 'delete', old: clone(item), state: 'queued', error: '' });
  }
  function retry(id) { const op = queue.find((o) => o.id === id && o.state === 'failed'); if (op) { op.state = 'queued'; op.error = ''; afterChange(); } }
  const statusOf = (id) => { const o = queue.find((x) => x.id === id && x.kind === 'save'); return o ? (o.state === 'failed' ? 'failed' : 'queued') : null; };
  const errorOf = (id) => { const o = queue.find((x) => x.id === id && x.state === 'failed'); return o ? o.error : ''; };
  const pendingCount = () => queue.filter((o) => o.state === 'queued').length;

  function onSaved(op, resp) {
    queue = queue.filter((o) => o !== op);
    const txn = resp.txn;
    if (data) { setMasters(resp); data.txns = data.txns.filter((x) => x.id !== txn.id && x.id !== op.id).concat([txn]); }
    if (isTmp(op.id)) {
      queue.forEach((o) => {            // later edits / deletes of the same new entry now point to the real row
        if (o.id !== op.id) return;
        o.id = txn.id;
        if (o.item) o.item.id = txn.id;
        if (o.payload) o.payload.id = txn.id;
        if (o.kind === 'save' && !o.old) o.old = clone(Object.assign({}, op.item, { id: txn.id }));
      });
    }
  }

  async function run() {
    if (running) return;
    running = true;
    let stopped = false;
    try {
      for (;;) {
        const op = queue.find((o) => o.state === 'queued');
        if (!op) break;
        inflight = op; emit();
        try {
          if (op.kind === 'save') onSaved(op, await A.call('save_transaction', op.payload));
          else if (isTmp(op.id)) queue = queue.filter((o) => o !== op);
          else {
            let d = null;
            try { d = await A.call('delete_transaction', { id: op.id }); } catch (e) { if (e.code !== 'not_found') throw e; }   // already gone
            queue = queue.filter((o) => o !== op);
            if (data) { if (d) setMasters(d); data.txns = data.txns.filter((x) => x.id !== op.id); }
          }
        } catch (err) {
          if (err.code === 'network' || err.code === 'session_expired' || err.code === 'config') {
            stopped = true;
            if (err.code === 'network') A.toast('Offline — changes will sync when you are back online.', 'error');
            break;
          }
          op.state = 'failed'; op.error = err.message || 'Could not save.';
          A.toast('Not saved: ' + op.error, 'error');
        }
        inflight = null; saveQ(); saveD(); emit();
      }
    } finally {
      inflight = null; running = false; saveQ(); saveD(); emit();
    }
    if (stopped) { clearTimeout(retryTimer); retryTimer = setTimeout(run, RETRY_MS); }
  }
  const resume = () => (queue.some((o) => o.state === 'queued') ? run() : Promise.resolve());
  window.addEventListener('online', resume);

  function whenIdle(maxMs) {
    if (idle()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { window.removeEventListener('dukan:change', check); clearTimeout(t); resolve(); };
      const check = () => { if (idle()) done(); };
      const t = setTimeout(done, maxMs || 6000);
      window.addEventListener('dukan:change', check);
    });
  }

  A.store = { TTL, view, masters, monthItems, dayItems, load, fresh, writeMasters, addTxn, editTxn, deleteTxn, retry, statusOf, errorOf, pendingCount, resume, whenIdle };
})();
