/* =====================================================================
 *  FINANCE — common.js : config, API, session, cache, helpers, header/nav, bottom-sheet
 *  Only thing to configure: API_URL
 * ===================================================================== */
(function () {
  'use strict';

  /* ============ CONFIG: paste your Apps Script Web App URL ============ */
  const API_URL = 'https://script.google.com/macros/s/AKfycbznwEcaFZBuRLPKeEwjH4uhqC_uU361gEvJkam98aIBasucQw5Y-91yZXxNq7XtidPF/exec';   // https://script.google.com/macros/s/XXXX/exec
  /* =================================================================== */

  const SESSION_KEY = 'dukan_session_v1';
  const FLASH_KEY = 'dukan_flash_v1';
  const TYPES = ['Income', 'Expense', 'Investment', 'Transfer'];      // internal keys
  const TYPE_LABEL = { Income: 'વેપાર', Expense: 'ખર્ચા', Investment: 'ઉપાડ', Transfer: 'ટ્રાન્સફર' };

  /* ---------------------------- pure helpers ---------------------------- */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const nowLocalInput = () => { const d = new Date(); return ymd(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  /** m = 0..11 → {from:'YYYY-MM-01', to:'YYYY-MM-last'} */
  function monthBounds(y, m) {
    const last = new Date(y, m + 1, 0).getDate();
    return { from: y + '-' + pad(m + 1) + '-01', to: y + '-' + pad(m + 1) + '-' + pad(last) };
  }
  function shiftMonth(y, m, delta) {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  }
  function money(n) {
    return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  /** Income +200 (green) · Expense -200 (red) · Investment *200 (blue) · Transfer 200 (black) */
  function amountView(t) {
    const a = money(t.amount);
    if (t.type === 'Income') return { text: '+' + a, cls: 'amt-income' };
    if (t.type === 'Expense') return { text: '-' + a, cls: 'amt-expense' };
    if (t.type === 'Investment') return { text: '-' + a, cls: 'amt-invest' };      // ઉપાડ
    return { text: a, cls: 'amt-transfer' };
  }
  function dayLabel(dateStr) {
    const p = dateStr.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('gu-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function timeLabel(timeStr) {
    const p = timeStr.slice(11, 16).split(':').map(Number);
    const h = p[0] % 12 || 12;
    const part = p[0] < 12 ? 'સવારે' : p[0] < 16 ? 'બપોરે' : p[0] < 20 ? 'સાંજે' : 'રાત્રે';
    return part + ' ' + h + ':' + pad(p[1]);
  }
  /** list is already newest-first → [{date, items[]}] */
  function groupByDate(list) {
    const out = [];
    list.forEach((t) => {
      const d = t.time.slice(0, 10);
      if (!out.length || out[out.length - 1].date !== d) out.push({ date: d, items: [] });
      out[out.length - 1].items.push(t);
    });
    return out;
  }
  function totals(list) {
    const s = { Income: 0, Expense: 0, Investment: 0, Transfer: 0 };
    list.forEach((t) => { s[t.type] += Number(t.amount) || 0; });
    return s;
  }
  function shortDay(key) {            // 'YYYY-MM-DD' → '13 Oct, Tue'
    const p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('gu-IN', { day: 'numeric', month: 'short', weekday: 'short' });
  }
  function monthName(key, long) {     // 'YYYY-MM' → 'Oct' / 'October 2026'
    const p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, 1).toLocaleDateString('gu-IN', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
  /** Income / Expense / Investment totals for a range (transfers NOT counted), zero-filled day/month series and
   *  category-wise totals. Same result shape as the backend's get_analysis — computed here from cached data. */
  function computeAnalysis(txns, categories, from, to, group) {
    const f = from.split('-').map(Number), t = to.split('-').map(Number);
    const start = Date.UTC(f[0], f[1] - 1, f[2]), end = Date.UTC(t[0], t[1] - 1, t[2]);
    const keys = [], seen = {}, series = {};
    for (let ms = start; ms <= end; ms += 86400000) {
      const k = new Date(ms).toISOString().slice(0, group === 'month' ? 7 : 10);
      if (!seen[k]) { seen[k] = true; keys.push(k); series[k] = { key: k, income: 0, expense: 0, invest: 0 }; }
    }
    const totals = { Income: 0, Expense: 0, Investment: 0 }, catMap = { Income: {}, Expense: {}, Investment: {} };
    txns.forEach((x) => {
      const d = x.time.slice(0, 10);
      if (x.type === 'Transfer' || d < from || d > to) return;
      totals[x.type] += x.amount;
      const s = series[group === 'month' ? d.slice(0, 7) : d];
      if (s) { if (x.type === 'Income') s.income += x.amount; else if (x.type === 'Expense') s.expense += x.amount; else s.invest += x.amount; }
      catMap[x.type][x.category] = (catMap[x.type][x.category] || 0) + x.amount;
    });
    const r2 = (n) => Math.round(n * 100) / 100, meta = {};
    categories.forEach((c) => { meta[c.type + '|' + c.name] = c; });
    const cats = {};
    ['Income', 'Expense', 'Investment'].forEach((type) => {
      cats[type] = Object.keys(catMap[type]).map((name) => {
        const m = meta[type + '|' + name];
        return { name, icon: m ? m.icon : '🏷️', budget: m ? m.budget : 0, total: r2(catMap[type][name]) };
      }).sort((a, b) => b.total - a.total);
    });
    return { from, to, group, totals: { income: r2(totals.Income), expense: r2(totals.Expense), invest: r2(totals.Investment) },
      series: keys.map((k) => { const s = series[k]; return { key: k, income: r2(s.income), expense: r2(s.expense), invest: r2(s.invest) }; }), categories: cats };
  }
  function initial(name) { return (Array.from(String(name || '?').trim())[0] || '?').toUpperCase(); }

  const pure = { pad, ymd, nowLocalInput, monthBounds, shiftMonth, money, amountView, dayLabel, timeLabel, groupByDate, totals, shortDay, monthName, daysBetween, computeAnalysis, initial, TYPES, TYPE_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ------------------- Gujarati UI: every visible string goes through tr() ------------------- */
  const GU = {
    'Finance': 'દુકાન હિસાબ', '💰 Finance': '🏪 દુકાન હિસાબ', 'Login': 'લોગિન', 'Username': 'યુઝરનેમ', 'Password': 'પાસવર્ડ',
    'Enter username and password.': 'યુઝરનેમ અને પાસવર્ડ લખો.', 'Wrong username or password.': 'ખોટું યુઝરનેમ અથવા પાસવર્ડ.',
    'Income': 'વેપાર', 'Expense': 'ખર્ચા', 'Investment': 'ઉપાડ', 'Invest': 'ઉપાડ', 'Transfer': 'ટ્રાન્સફર',
    'Home': 'આજ', 'Analysis': 'હિસાબ', 'Accounts': 'ખાતા', 'Categories': 'કેટેગરી',
    '📊 Analysis': '📊 હિસાબ', '🏦 Accounts': '🏦 ખાતા', '🏷️ Categories': '🏷️ કેટેગરી',
    'No access': 'પ્રવેશ નથી', 'You do not have access to any page yet. Ask the owner to add pages to your Access.': 'તમને હજી કોઈ પેજની પરવાનગી નથી. એડમિનને Access માં પેજ ઉમેરવા કહો.',
    'Logged out.': 'લોગઆઉટ થયા.', 'Network problem. Check internet and try again.': 'ઇન્ટરનેટ તપાસો અને ફરી પ્રયત્ન કરો.',
    'Unexpected server response.': 'સર્વરનો અણધાર્યો જવાબ.', 'Session expired. Please login again.': 'સત્ર પૂરું થયું. ફરી લોગિન કરો.',
    'Something went wrong.': 'કંઈક ખોટું થયું.', 'Please login again.': 'ફરી લોગિન કરો.', 'API_URL is not set in common.js yet.': 'common.js માં API_URL હજી મૂક્યો નથી.',
    '⟳  Refresh': '⟳  રિફ્રેશ', '🔑  Change password': '🔑  પાસવર્ડ બદલો', '⎋  Logout': '⎋  લોગઆઉટ', 'Profile': 'પ્રોફાઇલ', 'Refresh': 'રિફ્રેશ',
    '⚠ Not saved': '⚠ સેવ ન થયું', '⏳ Saving…': '⏳ સેવ થાય છે…',
    'Refreshed': 'રિફ્રેશ થયું', 'Loading…': 'લોડ થાય છે…', 'Close': 'બંધ કરો', 'View only': 'ફક્ત જોવા',
    'Change password': 'પાસવર્ડ બદલો', 'Current password': 'હાલનો પાસવર્ડ', 'New password (6+ characters)': 'નવો પાસવર્ડ (૬+ અક્ષર)',
    'Repeat new password': 'નવો પાસવર્ડ ફરી લખો', 'New password must be at least 6 characters.': 'નવો પાસવર્ડ ઓછામાં ઓછા ૬ અક્ષરનો હોવો જોઈએ.',
    'The two new passwords do not match.': 'બંને નવા પાસવર્ડ મેળ ખાતા નથી.', 'Password changed': 'પાસવર્ડ બદલાયો',
    'Offline — changes will sync when you are back online.': 'ઇન્ટરનેટ નથી — ઓનલાઇન થતાં જ ફેરફારો સેવ થશે.', 'Could not save.': 'સેવ ન થયું.',
    'Month': 'મહિનો', 'Year': 'વર્ષ', 'Custom': 'કસ્ટમ', 'Select month': 'મહિનો પસંદ કરો', 'Previous month': 'પાછલો મહિનો', 'Next month': 'આગલો મહિનો',
    'Previous year': 'પાછલું વર્ષ', 'Next year': 'આગલું વર્ષ', 'From date': 'શરૂઆતની તારીખ', 'To date': 'છેલ્લી તારીખ', 'From': 'થી', 'To': 'સુધી',
    '"From" must be before "To".': '"થી" તારીખ "સુધી" પહેલાં હોવી જોઈએ.', 'Range too long (max 10 years).': 'સમયગાળો બહુ લાંબો (વધુમાં વધુ ૧૦ વર્ષ).',
    'Day-wise (days with entries)': 'દિવસ મુજબ (જે દિવસે એન્ટ્રી છે)', 'Day-wise': 'દિવસ મુજબ', 'Month-wise': 'મહિના મુજબ', 'tap a month for its days': 'દિવસો જોવા મહિના પર ટેપ કરો',
    'No income / expense / investment in this range.': 'આ સમયગાળામાં કોઈ વેપાર / ખર્ચા / ઉપાડ નથી.', 'Date': 'તારીખ', 'No data': 'માહિતી નથી',
    'Net (Income − Expense)': 'બચ્યું (વેપાર − ખર્ચા − ઉપાડ)',
    'Total balance': 'કુલ બાકી', '+ Add': '+ ઉમેરો', 'Inactive': 'નિષ્ક્રિય', 'Active': 'સક્રિય', 'Inactive (hidden from new entries)': 'નિષ્ક્રિય (નવી એન્ટ્રીમાં દેખાશે નહીં)',
    'No active accounts. Tap + Add.': 'કોઈ સક્રિય ખાતું નથી. + ઉમેરો દબાવો.', 'Update': 'અપડેટ', 'Add account': 'ખાતું ઉમેરો', 'Name': 'નામ',
    'Icon (emoji)': 'આઇકન (ઇમોજી)', 'Opening balance': 'શરૂઆતની બાકી', 'Status': 'સ્થિતિ', 'Note': 'નોંધ', 'Enter account name.': 'ખાતાનું નામ લખો.',
    'Opening balance must be a number.': 'શરૂઆતની બાકી આંકડામાં લખો.', 'Saved': 'સેવ થયું', 'Edit account': 'ખાતું સુધારો', 'New account': 'નવું ખાતું',
    'e.g. Bank KOTAK': 'દા.ત. બેંક ઓફ બરોડા', 'Account details (bank, A/c no. last digits, IFSC, …)': 'ખાતાની વિગત (બેંક, ખાતા નંબરના છેલ્લા અંક, IFSC, …)',
    'Type': 'પ્રકાર', 'Budget': 'બજેટ', 'Budget (monthly)': 'બજેટ (માસિક)', 'Default account': 'ડિફોલ્ટ ખાતું', 'None': 'કોઈ નહીં',
    'Add category': 'કેટેગરી ઉમેરો', 'Edit category': 'કેટેગરી સુધારો', 'New category': 'નવી કેટેગરી', 'Enter category name.': 'કેટેગરીનું નામ લખો.',
    'Budget must be a number.': 'બજેટ આંકડામાં લખો.', 'e.g. Food': 'દા.ત. ચા-નાસ્તો', 'Details (e.g. SIP folio, fund name, monthly target…)': 'વિગત (દા.ત. કારીગરનું નામ, માસિક લક્ષ્ય…)'
  };
  const GU_TYPES = { expense: 'ખર્ચા', income: 'વેપાર', investment: 'ઉપાડ' };
  const GU_PATTERNS = [
    [/^Welcome (.*)!$/, (m) => 'સ્વાગત છે, ' + m[1] + '!'],
    [/^Show inactive accounts \((\d+)\)$/, (m) => 'નિષ્ક્રિય ખાતા બતાવો (' + m[1] + ')'],
    [/^Hide inactive accounts \((\d+)\)$/, (m) => 'નિષ્ક્રિય ખાતા છુપાવો (' + m[1] + ')'],
    [/^Show inactive \((\d+)\)$/, (m) => 'નિષ્ક્રિય બતાવો (' + m[1] + ')'],
    [/^Hide inactive \((\d+)\)$/, (m) => 'નિષ્ક્રિય છુપાવો (' + m[1] + ')'],
    [/^(Expense|Income|Investment) categories$/, (m) => GU[m[1]] + ' કેટેગરી'],
    [/^No active (expense|income|investment) categories\. Tap \+ Add\.$/, (m) => 'કોઈ સક્રિય ' + GU_TYPES[m[1]] + ' કેટેગરી નથી. + ઉમેરો દબાવો.'],
    [/^(Expense|Income|Investment) by category$/, (m) => GU[m[1]] + ' કેટેગરી મુજબ'],
    [/^Budget ₹ (.*?)(?: · over by (.*))?$/, (m) => 'બજેટ ₹ ' + m[1] + (m[2] ? ' · ' + m[2] + ' વધારે' : '')],
    [/^(\d+)% of (expense|income|investment)$/, (m) => m[1] + '% (' + GU_TYPES[m[2]] + ' માંથી)'],
    [/^This account still has a balance of ₹(.*?)\. Make it inactive anyway\? \(Its history stays\.\)$/, (m) => 'આ ખાતામાં હજી ₹' + m[1] + ' બાકી છે. છતાં નિષ્ક્રિય કરવું? (જૂનો હિસાબ રહેશે.)'],
    [/^Not saved: (.*)$/, (m) => 'સેવ ન થયું: ' + m[1]],
    [/^(.*) — Income (.*), Expense (.*), Invest (.*)$/, (m) => m[1] + ' — વેપાર ' + m[2] + ', ખર્ચા ' + m[3] + ', ઉપાડ ' + m[4]]
  ];
  /** English UI text → Gujarati (exact match, then patterns). Anything else (already Gujarati, numbers, server messages) is untouched. */
  function tr(s) {
    if (typeof s !== 'string' || !/[A-Za-z]/.test(s)) return s;
    if (Object.prototype.hasOwnProperty.call(GU, s)) return GU[s];
    for (let i = 0; i < GU_PATTERNS.length; i++) { const m = GU_PATTERNS[i][0].exec(s); if (m) return GU_PATTERNS[i][1](m); }
    return s;
  }
  /** Translates the static HTML of a page (text nodes + placeholder / aria-label / title). */
  function translateDom(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
    const nodes = []; let n;
    while ((n = walker.nextNode())) { if (n.parentNode && !/^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)) nodes.push(n); }
    nodes.forEach((t) => { const v = t.nodeValue, k = v.trim(); if (k) { const g = tr(k); if (g !== k) t.nodeValue = v.replace(k, g); } });
    root.querySelectorAll('[placeholder],[aria-label],[title]').forEach((e) => ['placeholder', 'aria-label', 'title'].forEach((a) => { if (e.hasAttribute(a)) e.setAttribute(a, tr(e.getAttribute(a))); }));
  }
  const runTranslate = () => { translateDom(document.body); document.title = tr(document.title); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runTranslate); else runTranslate();
  const _confirm = window.confirm ? window.confirm.bind(window) : null;
  window.confirm = (m) => (_confirm ? _confirm(tr(String(m))) : true);

  /* ------------------------------ DOM utils ------------------------------ */
  const $ = (id) => document.getElementById(id);

  /** Tiny DOM builder — text always inserted as text nodes (never innerHTML). */
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = tr(v);
        else if (k === 'value') n.value = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : (k === 'placeholder' || k === 'aria-label' || k === 'title' ? tr(String(v)) : v));
      });
    }
    kids.flat(Infinity).forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(tr(String(c)))); });
    return n;
  }

  function toast(message, type = 'ok') {
    let box = $('toasts');
    if (!box) { box = el('div', { id: 'toasts', class: 'toasts' }); document.body.appendChild(box); }
    const t = el('div', { class: 'toast ' + (type === 'error' ? 'toast-err' : 'toast-ok'), text: message });   // (el() translates)
    box.appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 4500 : 2500);
  }
  function flash(message, type = 'ok') { try { sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, type })); } catch (_) {} }
  function showFlash() {
    try {
      const raw = sessionStorage.getItem(FLASH_KEY);
      if (!raw) return;
      sessionStorage.removeItem(FLASH_KEY);
      const f = JSON.parse(raw);
      if (f && f.message) toast(f.message, f.type);
    } catch (_) {}
  }
  function setBusy(btn, busy) {
    btn.disabled = busy;
    btn.classList.toggle('busy', busy);
  }

  /* ------------------------------- Session ------------------------------- */
  let session = null;
  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (s && s.username && s.token && s.exp > Date.now()) return s;
    } catch (_) {}
    return null;
  }
  function saveSession(s) { session = s; try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) {} }
  function clearSession() { session = null; try { Object.keys(localStorage).filter((k) => k.indexOf('dukan_') === 0 && k !== FLASH_KEY).forEach((k) => localStorage.removeItem(k)); } catch (_) {} }

  function requireLogin() {
    const s = loadSession();
    if (!s) { location.replace('index.html'); return null; }
    session = s;
    showFlash();
    return s;
  }

  /* ---------------- roles + page access (the server enforces them; this only shapes the UI) ---------------- */
  const PAGES = ['home', 'analysis', 'accounts', 'categories'];
  const PAGE_META = { home: ['home.html', '🏠', 'આજ'], analysis: ['analysis.html', '📊', 'હિસાબ'], accounts: ['accounts.html', '🏦', 'ખાતા'], categories: ['categories.html', '🏷️', 'કેટેગરી'] };
  const canView = (page) => !!session && (session.role === 'Owner' || (session.access || []).indexOf(page) >= 0);
  /** Owner: always. Editor: pages listed in Access. Viewer: never. (Analysis has nothing to edit.) */
  const canEdit = (page) => !!session && page !== 'analysis' && (session.role === 'Owner' || (session.role === 'Editor' && (session.access || []).indexOf(page) >= 0));
  const firstPage = () => { const p = PAGES.filter(canView)[0]; return p ? PAGE_META[p][0] : 'home.html'; };
  /** The server sends the current role / access with every full load → keep the session in sync. */
  function updateAccess(role, access) {
    if (!session || !role) return;
    if (session.role === role && JSON.stringify(session.access || []) === JSON.stringify(access || [])) return;
    saveSession(Object.assign({}, session, { role, access: access || [] }));
  }
  /** Call first on every page: true = continue. Otherwise redirects to an allowed page, or shows "No access". */
  function guard(page) {
    if (canView(page)) return true;
    const alt = firstPage();
    if (alt !== page + '.html' && PAGES.some(canView)) { location.replace(alt); return false; }
    const host = document.querySelector('main');
    if (host) host.replaceChildren(el('div', { class: 'card', style: 'margin-top:1rem;text-align:center' }, el('b', { text: 'No access' }),
      el('p', { class: 'note', text: 'You do not have access to any page yet. Ask the owner to add pages to your Access.' })));
    mountHeader('🏪 દુકાન હિસાબ', null);
    if ($('nav')) $('nav').replaceChildren();
    const fab = $('fab'); if (fab) fab.hidden = true;
    return false;
  }
  function logout() {
    clearSession();
    flash('Logged out.');
    location.replace('index.html');
  }

  /* ---------------------------------- API ---------------------------------- */
  class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }

  async function api(action, payload = {}) {
    if (API_URL.indexOf('PASTE_') === 0) throw new ApiError('config', 'API_URL is not set in common.js yet.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
      // text/plain = "simple" request → no CORS preflight (Apps Script cannot answer OPTIONS)
      res = await fetch(API_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, payload)), signal: ctrl.signal
      });
    } catch (_) { throw new ApiError('network', 'Network problem. Check internet and try again.'); }
    finally { clearTimeout(timer); }
    let data;
    try { data = await res.json(); } catch (_) { throw new ApiError('bad_response', 'Unexpected server response.'); }
    if (!data.success) {
      if (data.error === 'session_expired') { clearSession(); flash('Session expired. Please login again.', 'error'); location.replace('index.html'); }
      throw new ApiError(data.error || 'error', data.message || 'Something went wrong.');
    }
    return data;
  }
  function call(action, payload = {}) {
    if (!session) throw new ApiError('session_expired', 'Please login again.');
    return api(action, Object.assign({ username: session.username, token: session.token }, payload));
  }

  /* --------------------------- Header + bottom nav --------------------------- */
  /** ⟳ icon (always visible) + profile menu (Refresh · Change password · Logout). onRefresh: async, forces a fresh load. */
  function mountHeader(title, onRefresh) {
    const host = $('hdr');
    const menu = el('div', { class: 'menu', hidden: true },
      el('div', { class: 'menu-note' }, (session && session.name) || '', session && session.role === 'Viewer' ? el('span', { class: 'viewer-tag', text: 'View only' }) : null),
      el('button', { class: 'menu-item', type: 'button', text: '⟳  Refresh', onclick: () => { closeMenu(); refresh(); } }),
      el('button', { class: 'menu-item', type: 'button', text: '🔑  Change password', onclick: () => { closeMenu(); openChangePassword(); } }),
      el('button', { class: 'menu-item danger', type: 'button', text: '⎋  Logout', onclick: logout })
    );
    const avatar = el('button', { class: 'avatar', type: 'button', 'aria-label': 'Profile', text: initial(session && session.name) });
    const rbtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Refresh', title: 'Refresh', text: '⟳', onclick: () => refresh() });
    function closeMenu() { menu.hidden = true; }
    async function refresh() {
      if (!onRefresh || rbtn.classList.contains('spin')) return;
      rbtn.classList.add('spin');
      try { await onRefresh(); } catch (err) { toast(err.message, 'error'); } finally { rbtn.classList.remove('spin'); }
    }
    avatar.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', closeMenu);
    host.replaceChildren(el('div', { class: 'hdr-bar' }, el('h1', { class: 'hdr-title', text: title }),
      el('div', { class: 'hdr-right' }, rbtn, el('div', { class: 'menu-wrap' }, avatar, menu))));
  }

  function openChangePassword() {
    const o = el('input', { class: 'field', type: 'password', autocomplete: 'current-password', id: 'pwOld' });
    const n = el('input', { class: 'field', type: 'password', autocomplete: 'new-password', id: 'pwNew' });
    const c = el('input', { class: 'field', type: 'password', autocomplete: 'new-password', id: 'pwNew2' });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Change password' });
    let close;
    const form = el('form', { novalidate: true },
      el('label', { class: 'lbl', for: 'pwOld', text: 'Current password' }), o,
      el('label', { class: 'lbl', for: 'pwNew', text: 'New password (6+ characters)' }), n,
      el('label', { class: 'lbl', for: 'pwNew2', text: 'Repeat new password' }), c, save);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (n.value.length < 6) { toast('New password must be at least 6 characters.', 'error'); return; }
      if (n.value !== c.value) { toast('The two new passwords do not match.', 'error'); return; }
      setBusy(save, true);
      try {
        const d = await call('change_password', { old_password: o.value, new_password: n.value });
        saveSession(Object.assign({}, session, { token: d.token, exp: d.expires }));
        close(); toast('Password changed');
      } catch (err) { toast(err.message, 'error'); setBusy(save, false); }
    });
    close = openSheet('Change password', form); o.focus();
  }

  let navActive = null;
  function drawNav() {
    const items = PAGES.filter(canView).map((p) => [p].concat(PAGE_META[p]));
    $('nav').replaceChildren(el('div', { class: 'nav-inner' }, ...items.map((i) => el('a', { class: 'nav-item' + (i[0] === navActive ? ' active' : ''), href: i[1] }, el('span', { class: 'nav-ico', text: i[2] }), el('span', { text: i[3] })))));
  }
  /** Only the pages this user may open are shown. */
  function mountNav(active) { navActive = active; drawNav(); }
  window.addEventListener('dukan:change', () => { if (navActive) drawNav(); });

  /* ------------------------------ Bar chart (SVG) ------------------------------ */
  /** series: [{key, income, expense, invest}] · group 'day' | 'month'. Scrolls sideways when wide. */
  function barChart(series, group) {
    const NS = 'http://www.w3.org/2000/svg';
    const gw = group === 'day' ? 30 : 46, bw = group === 'day' ? 8 : 11, H = 140, LBL = 18;
    const max = Math.max(1, ...series.map((s) => Math.max(s.income, s.expense, s.invest)));
    const svg = document.createElementNS(NS, 'svg');
    const W = series.length * gw + 8;
    svg.setAttribute('width', W); svg.setAttribute('height', H + LBL);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + LBL)); svg.setAttribute('role', 'img');
    const mk = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k])); if (text != null) n.textContent = text; return n; };
    series.forEach((s, i) => {
      const g = mk('g', {});
      const label = group === 'day' ? shortDay(s.key) : monthName(s.key);
      g.append(mk('title', {}, label + ' — વેપાર ' + money(s.income) + ', ખર્ચા ' + money(s.expense) + ', ઉપાડ ' + money(s.invest)));
      [['income', s.income], ['expense', s.expense], ['invest', s.invest]].forEach((b, k) => {
        const h = b[1] > 0 ? Math.max(2, Math.round((b[1] / max) * (H - 6))) : 0;
        if (h) g.append(mk('rect', { x: 4 + i * gw + k * (bw + 1), y: H - h, width: bw, height: h, rx: 1.5, class: 'b-' + b[0] }));
      });
      g.append(mk('text', { x: 4 + i * gw + (3 * bw + 2) / 2, y: H + 13, 'text-anchor': 'middle', class: 'b-lbl' }, group === 'day' ? s.key.slice(8).replace(/^0/, '') : monthName(s.key)));
      svg.append(g);
    });
    svg.append(mk('line', { x1: 0, x2: W, y1: H, y2: H, class: 'b-axis' }));
    return el('div', { class: 'chart-scroll' }, svg);
  }

  /* ------------------------------ Bottom sheet ------------------------------ */
  /** Opens a modal bottom-sheet. Returns close(). */
  function openSheet(title, content) {
    const close = () => { overlay.remove(); document.body.classList.remove('no-scroll'); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'sheet-head' }, el('h2', { text: title }), el('button', { class: 'sheet-x', type: 'button', 'aria-label': 'Close', text: '✕', onclick: close })),
      content);
    const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, sheet);
    document.body.appendChild(overlay);
    document.body.classList.add('no-scroll');
    document.addEventListener('keydown', onKey);
    return close;
  }

  window.App = Object.assign({
    $, el, toast, flash, showFlash, setBusy, api, call, ApiError,
    loadSession, saveSession, requireLogin, logout,
    session: () => session, canView, canEdit, firstPage, guard, updateAccess, tr, translateDom, mountHeader, openChangePassword, mountNav, openSheet, barChart
  }, pure);
})();
