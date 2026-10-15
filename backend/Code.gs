/**
 * =====================================================================
 *  દુકાન હિસાબ — Shop daily accounts · Google Apps Script backend (Code.gs)
 *  API_VERSION 1.0-dukan   (built on the Finance engine, Gujarati labels)
 * =====================================================================
 *  SETUP (one time)
 *  1. New Google Sheet → Extensions → Apps Script → paste this whole file.
 *  2. Run  setupSheets  once → creates ALL tabs, the two accounts (રોકડ, બેંક), the default categories
 *     and the હિસાબ (analysis) tab.  Then edit USERNAME / NAME / PASSWORD in  createUser  and run it.
 *  3. Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone → Deploy.
 *  4. Copy the Web app URL → paste into API_URL in site/common.js.
 *  UPDATING: Deploy → Manage deployments → pencil → Version: New version → Deploy.
 *
 *  Tabs: વપરાશકર્તા | વ્યવહાર | ખાતા | કેટેગરી | હિસાબ
 *  વપરાશકર્તા has  Role (એડમિન / એડિટ / વ્યૂ)  and  Access (pages: આજ, હિસાબ, ખાતા, કેટેગરી).
 *    એડમિન = everything, Access ignored        એડિટ = may EDIT the pages listed in Access
 *    વ્યૂ = may only SEE the pages listed in Access       (blank Role = વ્યૂ, blank Access = no page)
 *  The script filters the data it sends by Access and refuses writes by role — hiding buttons is only cosmetic.
 *  Analysis is built by setupSheets (change FROM / TO in B1 / B2 → everything recalculates).
 *  Every data action needs a valid username + token. Passwords are salted hashes.
 * =====================================================================
 */

var SHEET_USERS = 'વપરાશકર્તા';
var SHEET_TXN   = 'વ્યવહાર';
var SHEET_ACC   = 'ખાતા';
var SHEET_CAT   = 'કેટેગરી';
var SHEET_ANA   = 'હિસાબ';

// Column headings stay English (the script finds columns by NAME). Values in the sheet are Gujarati.
var HEADERS = {};
HEADERS[SHEET_USERS] = ['Username', 'Name', 'Password', 'Status', 'Role', 'Access'];
HEADERS[SHEET_TXN]   = ['ID', 'Time', 'Type', 'Amount', 'Category', 'Account', 'To_Account', 'Notes'];
HEADERS[SHEET_ACC]   = ['ID', 'Name', 'Opening_Balance', 'Current_Balance', 'Icon', 'Note', 'Status'];
HEADERS[SHEET_CAT]   = ['ID', 'Name', 'Type', 'Icon', 'Budget', 'Default_Account', 'Note', 'Status'];

// Internal keys (used by the API and the app): Income = વેપાર · Expense = ખર્ચા · Investment = ઉપાડ · Transfer = ટ્રાન્સફર
var TYPES     = ['Income', 'Expense', 'Investment', 'Transfer'];
var CAT_TYPES = ['Income', 'Expense', 'Investment'];
var TYPE_SHEET = { Income: 'વેપાર', Expense: 'ખર્ચા', Investment: 'ઉપાડ', Transfer: 'ટ્રાન્સફર' };

var SESSION_DAYS     = 30;
var MAX_ATTEMPTS     = 5;
var LOCKOUT_SECONDS  = 900;
var MIN_PASSWORD_LEN = 6;
var MAX_PASSWORD_LEN = 64;
var TIME_ZONE        = 'Asia/Kolkata';
var TIME_FMT         = "yyyy-MM-dd'T'HH:mm";

var API_VERSION = '1.0-dukan';

// --------------------------- HTTP ENTRY -----------------------------

function doGet(e) {
  return json_({ success: true, version: API_VERSION, message: 'Dukan Hisab API is running. Send POST requests.' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new ApiError('bad_request', 'ખાલી વિનંતી.');
    var body;
    try { body = JSON.parse(e.postData.contents); }
    catch (x) { throw new ApiError('bad_request', 'અમાન્ય JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('bad_request', 'અમાન્ય વિનંતી.');

    switch (body.action) {
      case 'login':              return ok_(login_(body));
      case 'all_data':           return ok_(allData_(body));
      case 'change_password':    return ok_(withLock_(function () { return changePassword_(body); }));
      case 'save_transaction':   return ok_(withLock_(function () { return saveTransaction_(body); }));
      case 'delete_transaction': return ok_(withLock_(function () { return deleteTransaction_(body); }));
      case 'save_account':       return ok_(withLock_(function () { return saveAccount_(body); }));
      case 'save_category':      return ok_(withLock_(function () { return saveCategory_(body); }));
      default: throw new ApiError('bad_request', 'અજાણી વિનંતી.');
    }
  } catch (err) {
    if (err instanceof ApiError) return fail_(err.code, err.message);
    console.error(err && err.stack ? err.stack : err);
    return fail_('server_error', 'સર્વર ભૂલ. ફરી પ્રયત્ન કરો.');
  }
}

// ----------------------------- ACTIONS ------------------------------

function login_(body) {
  var username = str_(body.username, 60);
  var password = String(body.password == null ? '' : body.password);
  var invalid = new ApiError('invalid_credentials', 'ખોટું યુઝરનેમ અથવા પાસવર્ડ.');
  if (!username || !password) throw invalid;
  assertNotLocked_(username);

  var user = findUser_(username);
  if (!user || user.status !== 'Active' || !verifyPassword_(user.password, password)) {
    recordFailure_(username);
    throw invalid;
  }
  clearFailures_(username);

  if (user.password.indexOf('sha256$') !== 0) {   // upgrade plain-text password
    withLock_(function () {
      user.password = hashPassword_(password);
      user.t.sh.getRange(user.row, user.t.idx.Password + 1).setNumberFormat('@').setValue(user.password);
    });
  }
  var tk = makeToken_(user);
  return { token: tk.token, expires: tk.expires, user: { username: user.username, name: user.name, role: user.role, access: user.access } };
}

/** Everything the app needs, in one call — filtered by the user's Access:
 *   accounts   : full (balances, notes) with 'accounts' access; only name + icon with 'home'; none otherwise
 *   categories : name / icon / budget always (Home + Analysis need them); notes only with 'categories' access
 *   transactions: all with 'home'; with only 'analysis' → no notes / accounts / transfers; none otherwise */
function allData_(body) {
  var u = authenticate_(body);
  var m = mastersFor_(u);
  var txns = readTxns_();
  txns.forEach(function (t) { delete t._row; });
  txns.sort(function (a, b) { return a.time < b.time ? 1 : a.time > b.time ? -1 : 0; });
  if (!can_(u, 'home')) {
    txns = can_(u, 'analysis')
      ? txns.filter(function (t) { return t.type !== 'Transfer'; }).map(function (t) {
          return { id: t.id, time: t.time, type: t.type, amount: t.amount, category: t.category, account: '', to_account: '', note: '' };
        })
      : [];
  }
  m.transactions = txns;
  m.role = u.role;
  m.access = u.access;
  return m;
}

/** accounts + categories, trimmed to what this user may see (used by every response that carries them). */
function mastersFor_(u) {
  var m = masters_();
  if (!can_(u, 'accounts')) {
    m.accounts = can_(u, 'home')
      ? m.accounts.map(function (a) { return { id: a.id, name: a.name, icon: a.icon, status: a.status }; })
      : [];
  }
  if (!can_(u, 'categories')) {
    m.categories = m.categories.map(function (c) { return { id: c.id, name: c.name, type: c.type, icon: c.icon, budget: c.budget, default_account: c.default_account, status: c.status, note: '' }; });
  }
  return m;
}

// ------------------------- ROLES & PAGE ACCESS -----------------------

var PAGES = ['home', 'analysis', 'accounts', 'categories'];

function roleOf_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'owner' || s === 'admin' || s === 'એડમિન') return 'Owner';
  if (s === 'editor' || s === 'edit' || s === 'એડિટ') return 'Editor';
  return 'Viewer';                                   // anything else = read-only (વ્યૂ)
}
var PAGE_ALIASES = { home: 'home', today: 'home', aaj: 'home', 'આજ': 'home',
  analysis: 'analysis', hisab: 'analysis', 'હિસાબ': 'analysis',
  accounts: 'accounts', khata: 'accounts', 'ખાતા': 'accounts',
  categories: 'categories', category: 'categories', 'કેટેગરી': 'categories' };
function accessOf_(role, raw) {
  if (role === 'Owner') return PAGES.slice();
  var out = [];
  String(raw == null ? '' : raw).toLowerCase().split(/[,;\s]+/).forEach(function (w) {
    var p = PAGE_ALIASES[w];
    if (p && out.indexOf(p) < 0) out.push(p);
  });
  return out;
}
function can_(u, page) { return u.access.indexOf(page) >= 0; }
/** Owner always; Editor only for pages listed in Access; Viewer never. */
function requireEdit_(u, page) {
  if (u.role === 'Owner' || (u.role === 'Editor' && can_(u, page))) return u;
  throw new ApiError('forbidden', u.role === 'Viewer' ? 'ફક્ત જોવાની પરવાનગી છે — ફેરફાર ન થઈ શકે.' : 'આ વિભાગમાં ફેરફારની પરવાનગી નથી.');
}

function changePassword_(body) {
  var user = authenticate_(body);
  var oldPw = String(body.old_password == null ? '' : body.old_password);
  var newPw = String(body.new_password == null ? '' : body.new_password);
  if (!verifyPassword_(user.password, oldPw)) throw new ApiError('wrong_password', 'હાલનો પાસવર્ડ ખોટો છે.');
  if (newPw.length < MIN_PASSWORD_LEN || newPw.length > MAX_PASSWORD_LEN) {
    throw new ApiError('bad_request', 'નવો પાસવર્ડ ' + MIN_PASSWORD_LEN + '–' + MAX_PASSWORD_LEN + ' અક્ષરનો હોવો જોઈએ.');
  }
  user.password = hashPassword_(newPw);
  user.t.sh.getRange(user.row, user.t.idx.Password + 1).setNumberFormat('@').setValue(user.password);
  var tk = makeToken_(user);                         // old tokens die with the old password hash
  return { token: tk.token, expires: tk.expires };
}

function masters_() {
  return { accounts: accountsWithBalance_(), categories: readCategories_() };
}

function saveTransaction_(body) {
  var user = requireEdit_(authenticate_(body), 'home');
  var accs = readAccounts_(), cats = readCategories_();
  var t = table_(SHEET_TXN);
  var id = str_(body.id, 40);
  var rowIdx = -1;
  if (id) {
    t.rows.forEach(function (r, i) { if (String(r[t.idx.ID]) === id) rowIdx = i; });
    if (rowIdx < 0) throw new ApiError('not_found', 'વ્યવહાર મળ્યો નથી.');
  }
  var existing = rowIdx < 0 ? null : { account: String(t.rows[rowIdx][t.idx.Account]), to_account: String(t.rows[rowIdx][t.idx.To_Account]), category: String(t.rows[rowIdx][t.idx.Category]) };
  var c = cleanTxn_(body, accs, cats, existing);

  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  row[t.idx.ID]         = rowIdx < 0 ? newId_('T') : id;
  row[t.idx.Time]       = c.date;
  row[t.idx.Type]       = typeToSheet_(c.type);
  row[t.idx.Amount]     = c.amount;
  row[t.idx.Category]   = c.category;
  row[t.idx.Account]    = c.account;
  row[t.idx.To_Account] = c.to_account;
  row[t.idx.Notes]      = safeText_(c.note);

  var target = rowIdx < 0 ? Math.max(t.sh.getLastRow(), 1) + 1 : rowIdx + 2;
  t.sh.getRange(target, 1, 1, t.width).setValues([row]);
  var out = mastersFor_(user);
  out.saved_id = row[t.idx.ID];
  out.txn = { id: row[t.idx.ID], time: String(body.time), type: c.type, amount: c.amount, category: c.category,
              account: c.account, to_account: c.to_account, note: c.note };
  return out;
}

function deleteTransaction_(body) {
  var user = requireEdit_(authenticate_(body), 'home');
  var id = str_(body.id, 40);
  if (!id) throw new ApiError('bad_request', 'ID નથી.');
  var t = table_(SHEET_TXN), rowIdx = -1;
  t.rows.forEach(function (r, i) { if (String(r[t.idx.ID]) === id) rowIdx = i; });
  if (rowIdx < 0) throw new ApiError('not_found', 'વ્યવહાર મળ્યો નથી.');
  t.sh.deleteRow(rowIdx + 2);
  return mastersFor_(user);
}

function saveAccount_(body) {
  var user = requireEdit_(authenticate_(body), 'accounts');
  var t = table_(SHEET_ACC);
  var name = cleanName_(body.name);
  var opening = body.opening_balance === '' || body.opening_balance == null ? 0 : Number(body.opening_balance);
  if (!isFinite(opening) || Math.abs(opening) > 1e10) throw new ApiError('bad_request', 'અમાન્ય શરૂઆતની બાકી.');
  opening = Math.round(opening * 100) / 100;
  var icon = str_(body.icon, 8) || '🏦';
  var note = strMulti_(body.note, 300);
  var status = body.status === 'Inactive' ? 'Inactive' : 'Active';
  var id = str_(body.id, 40);

  var rowIdx = findRow_(t, id);
  t.rows.forEach(function (r, i) {
    if (i !== rowIdx && String(r[t.idx.Name]).toLowerCase() === name.toLowerCase()) {
      throw new ApiError('bad_request', 'આ નામનું ખાતું પહેલેથી છે.');
    }
  });

  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  var oldName = rowIdx < 0 ? '' : String(row[t.idx.Name]);
  row[t.idx.ID]              = rowIdx < 0 ? newId_('A') : id;
  row[t.idx.Name]            = name;
  row[t.idx.Opening_Balance] = opening;
  row[t.idx.Icon]            = icon;
  row[t.idx.Note]            = safeText_(note);
  row[t.idx.Status]          = statusToSheet_(status);
  var target = rowIdx < 0 ? Math.max(t.sh.getLastRow(), 1) + 1 : rowIdx + 2;
  row[t.idx.Current_Balance] = balanceFormula_(t, target);   // keeps the sheet's own balance live
  t.sh.getRange(target, 1, 1, t.width).setValues([row]);

  if (oldName && oldName !== name) { renameRefs_(['Account', 'To_Account'], oldName, name); renameDefaultAccount_(oldName, name); }
  return mastersFor_(user);
}

function saveCategory_(body) {
  var user = requireEdit_(authenticate_(body), 'categories');
  var t = table_(SHEET_CAT);
  var name = cleanName_(body.name);
  var type = String(body.type || '');
  if (CAT_TYPES.indexOf(type) < 0) throw new ApiError('bad_request', 'પ્રકાર વેપાર, ખર્ચા અથવા ઉપાડ હોવો જોઈએ.');
  var budget = body.budget === '' || body.budget == null ? 0 : Number(body.budget);
  if (!isFinite(budget) || budget < 0 || budget > 1e10) throw new ApiError('bad_request', 'અમાન્ય બજેટ.');
  budget = Math.round(budget * 100) / 100;
  var icon = str_(body.icon, 8) || '🏷️';
  var note = strMulti_(body.note, 500);
  var status = body.status === 'Inactive' ? 'Inactive' : 'Active';
  var defAcc = str_(body.default_account, 60);
  if (defAcc && !readAccounts_().some(function (a) { return a.name === defAcc; })) throw new ApiError('bad_request', 'સાચું ડિફોલ્ટ ખાતું પસંદ કરો.');
  var id = str_(body.id, 40);

  var rowIdx = findRow_(t, id);
  t.rows.forEach(function (r, i) {
    if (i !== rowIdx && String(r[t.idx.Name]).toLowerCase() === name.toLowerCase() && typeFromCell_(r[t.idx.Type]) === type) {
      throw new ApiError('bad_request', 'આ નામની કેટેગરી ' + typeLabel_(type) + ' માં પહેલેથી છે.');
    }
  });

  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  var oldName = rowIdx < 0 ? '' : String(row[t.idx.Name]);
  if (rowIdx >= 0 && typeFromCell_(row[t.idx.Type]) !== type) {
    throw new ApiError('bad_request', 'કેટેગરી બન્યા પછી તેનો પ્રકાર બદલી શકાતો નથી.');
  }
  row[t.idx.ID]     = rowIdx < 0 ? newId_('C') : id;
  row[t.idx.Name]   = name;
  row[t.idx.Type]   = typeToSheet_(type);
  row[t.idx.Icon]   = icon;
  row[t.idx.Budget] = budget;
  row[t.idx.Note]   = safeText_(note);
  row[t.idx.Status] = statusToSheet_(status);
  row[t.idx.Default_Account] = defAcc;
  var target = rowIdx < 0 ? Math.max(t.sh.getLastRow(), 1) + 1 : rowIdx + 2;
  t.sh.getRange(target, 1, 1, t.width).setValues([row]);

  if (oldName && oldName !== name) renameRefs_(['Category'], oldName, name);
  return mastersFor_(user);
}

// ------------------------------ DATA --------------------------------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new ApiError('server_error', 'ટેબ "' + name + '" નથી. setupSheets ચલાવો.');
  return sh;
}

/** Reads a tab: {sh, idx (header→col), rows (2D), width}. Columns are found by NAME. */
function table_(name) {
  var sh = sheet_(name);
  var need = HEADERS[name];
  var width = Math.max(sh.getLastColumn(), need.length);
  var head = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  var idx = {};
  head.forEach(function (h, i) { if (h) idx[h] = i; });
  need.forEach(function (h) {
    if (idx[h] === undefined) throw new ApiError('server_error', 'કોલમ "' + h + '" ' + name + ' માં નથી. setupSheets ચલાવો.');
  });
  var last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  return { sh: sh, idx: idx, rows: rows, width: width };
}

function blankRow_(t) {
  var r = [];
  for (var i = 0; i < t.width; i++) r.push('');
  return r;
}

function findRow_(t, id) {
  if (!id) return -1;
  var found = -1;
  t.rows.forEach(function (r, i) { if (String(r[t.idx.ID]) === id) found = i; });
  if (found < 0) throw new ApiError('not_found', 'રેકોર્ડ મળ્યો નથી.');
  return found;
}

function readAccounts_() {
  var t = table_(SHEET_ACC), out = [];
  t.rows.forEach(function (r) {
    var name = String(r[t.idx.Name] || '').trim();
    if (!name) return;
    out.push({
      id: String(r[t.idx.ID] || ''), name: name,
      opening_balance: Number(r[t.idx.Opening_Balance]) || 0,
      icon: String(r[t.idx.Icon] || '') || '🏦',
      note: unsafeText_(String(r[t.idx.Note] || '')),
      status: statusOf_(r[t.idx.Status])
    });
  });
  return out;
}

function readCategories_() {
  var t = table_(SHEET_CAT), out = [];
  t.rows.forEach(function (r) {
    var name = String(r[t.idx.Name] || '').trim();
    var type = typeFromCell_(r[t.idx.Type]);
    if (!name || CAT_TYPES.indexOf(type) < 0) return;
    out.push({
      id: String(r[t.idx.ID] || ''), name: name, type: type,
      icon: String(r[t.idx.Icon] || '') || '🏷️',
      budget: Number(r[t.idx.Budget]) || 0,
      default_account: String(r[t.idx.Default_Account] || '').trim(),
      note: unsafeText_(String(r[t.idx.Note] || '')),
      status: statusOf_(r[t.idx.Status])
    });
  });
  return out;
}

function readTxns_() {
  var t = table_(SHEET_TXN), out = [];
  t.rows.forEach(function (r, i) {
    var d = toDate_(r[t.idx.Time]);
    var type = typeFromCell_(r[t.idx.Type]);
    if (!d || TYPES.indexOf(type) < 0) return;
    out.push({
      id: String(r[t.idx.ID] || ''),
      time: Utilities.formatDate(d, TIME_ZONE, TIME_FMT),
      type: type,
      amount: Number(r[t.idx.Amount]) || 0,
      category: String(r[t.idx.Category] || ''),
      account: String(r[t.idx.Account] || ''),
      to_account: String(r[t.idx.To_Account] || ''),
      note: unsafeText_(String(r[t.idx.Notes] || '')),
      _row: i + 2
    });
  });
  return out;
}

/** opening balance + income − expense − investment ± transfers. */
function accountsWithBalance_() {
  var accs = readAccounts_(), delta = {};
  function add(name, v) { if (name) delta[name] = (delta[name] || 0) + v; }
  readTxns_().forEach(function (x) {
    if (x.type === 'Income') add(x.account, x.amount);
    else if (x.type === 'Transfer') { add(x.account, -x.amount); add(x.to_account, x.amount); }
    else add(x.account, -x.amount);   // Expense, Investment
  });
  accs.forEach(function (a) {
    a.balance = Math.round((a.opening_balance + (delta[a.name] || 0)) * 100) / 100;
  });
  return accs;
}

function renameDefaultAccount_(oldName, newName) {
  var c = table_(SHEET_CAT);
  if (!c.rows.length) return;
  var changed = false;
  var vals = c.rows.map(function (r) {
    if (String(r[c.idx.Default_Account]).trim() === oldName) { changed = true; return [newName]; }
    return [r[c.idx.Default_Account]];
  });
  if (changed) c.sh.getRange(2, c.idx.Default_Account + 1, vals.length, 1).setValues(vals);
}

function renameRefs_(cols, oldName, newName) {
  var t = table_(SHEET_TXN);
  if (!t.rows.length) return;
  cols.forEach(function (c) {
    var i = t.idx[c], changed = false;
    var vals = t.rows.map(function (r) {
      if (String(r[i]) === oldName) { changed = true; return [newName]; }
      return [r[i]];
    });
    if (changed) t.sh.getRange(2, i + 1, vals.length, 1).setValues(vals);
  });
}

// ------------------------ BALANCE FORMULAS --------------------------

function colLetter_(i) {
  var s = '';
  i = i + 1;
  while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/** Column letters of the Transactions tab by header name: {Time:'B', Type:'C', Amount:'D', …} */
function txnCols_() {
  var sh = sheet_(SHEET_TXN);
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), HEADERS[SHEET_TXN].length)).getValues()[0];
  var out = {};
  head.forEach(function (h, i) { if (String(h).trim()) out[String(h).trim()] = colLetter_(i); });
  HEADERS[SHEET_TXN].forEach(function (h) {
    if (!out[h]) throw new ApiError('server_error', 'કોલમ "' + h + '" ' + SHEET_TXN + ' માં નથી. setupSheets ચલાવો.');
  });
  return out;
}

/** The sheet's own live balance for account row r: opening + income − expense − investment − transfer-out + transfer-in. */
function balanceFormula_(at, r) {
  var c = txnCols_();
  function rng(n) { return "'" + SHEET_TXN + "'!$" + c[n] + ':$' + c[n]; }
  var opening = colLetter_(at.idx.Opening_Balance) + r, name = colLetter_(at.idx.Name) + r;
  function s(type, col) { return 'SUMIFS(' + rng('Amount') + ',' + rng('Type') + ',"' + type + '",' + rng(col) + ',' + name + ')'; }
  return '=' + opening + '+' + s(TYPE_SHEET.Income, 'Account') + '-' + s(TYPE_SHEET.Expense, 'Account') + '-' + s(TYPE_SHEET.Investment, 'Account') +
         '-' + s(TYPE_SHEET.Transfer, 'Account') + '+' + s(TYPE_SHEET.Transfer, 'To_Account');
}

/** (Re)writes the Current_Balance formula on every account row. Run by setupSheets; safe to run any time. */
function refreshBalanceFormulas_() {
  var a = table_(SHEET_ACC);
  if (!a.rows.length) return;
  var f = a.rows.map(function (r, i) {
    return [String(r[a.idx.Name]).trim() ? balanceFormula_(a, i + 2) : ''];
  });
  a.sh.getRange(2, a.idx.Current_Balance + 1, f.length, 1).setFormulas(f).setNumberFormat('#,##0.00');
}
function refreshBalanceFormulas() { refreshBalanceFormulas_(); }

// --------------------------- VALIDATION -----------------------------

function cleanTxn_(b, accs, cats, existing) {
  var type = String(b.type || '');
  if (TYPES.indexOf(type) < 0) throw new ApiError('bad_request', 'અમાન્ય પ્રકાર.');

  var amount = Number(b.amount);
  if (!isFinite(amount) || amount <= 0 || amount > 1e9) throw new ApiError('bad_request', 'સાચી રકમ લખો.');
  amount = Math.round(amount * 100) / 100;

  var time = String(b.time || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time)) throw new ApiError('bad_request', 'અમાન્ય તારીખ/સમય.');
  var date = Utilities.parseDate(time, TIME_ZONE, TIME_FMT);

  var accNames = accs.map(function (a) { return a.name; });
  var account = str_(b.account, 60), toAcc = str_(b.to_account, 60), category = str_(b.category, 60);
  if (accNames.indexOf(account) < 0) throw new ApiError('bad_request', 'સાચું ખાતું પસંદ કરો.');
  // Inactive accounts / categories can't be used for NEW entries. An old entry that already uses one may keep it.
  function assertActive(kind, name, item, same) {
    if (item && item.status === 'Inactive' && !same) throw new ApiError('bad_request', '"' + name + '" ' + kind + ' નિષ્ક્રિય છે.');
  }
  function accItem(n) { return accs.filter(function (a) { return a.name === n; })[0]; }
  assertActive('ખાતું', account, accItem(account), existing && existing.account === account);

  if (type === 'Transfer') {
    if (accNames.indexOf(toAcc) < 0) throw new ApiError('bad_request', 'સાચું "ક્યાં" ખાતું પસંદ કરો.');
    if (toAcc === account) throw new ApiError('bad_request', 'ક્યાંથી અને ક્યાં ખાતા અલગ હોવા જોઈએ.');
    assertActive('ખાતું', toAcc, accItem(toAcc), existing && existing.to_account === toAcc);
    category = '';
  } else {
    toAcc = '';
    var cat = cats.filter(function (c) { return c.name === category && c.type === type; })[0];
    if (!cat) throw new ApiError('bad_request', 'સાચી ' + typeLabel_(type) + ' કેટેગરી પસંદ કરો.');
    assertActive('કેટેગરી', category, cat, existing && existing.category === category);
  }
  return { type: type, amount: amount, date: date, account: account, to_account: toAcc,
           category: category, note: strMulti_(b.note, 300) };
}

function statusOf_(v) {
  var x = String(v == null ? '' : v).trim().toLowerCase();
  return x === 'inactive' || x === 'નિષ્ક્રિય' ? 'Inactive' : 'Active';       // blank = Active (accounts / categories)
}
function statusToSheet_(st) { return st === 'Inactive' ? 'નિષ્ક્રિય' : 'સક્રિય'; }
/** Users must be explicitly active (સક્રિય / Active); blank = not allowed to log in. */
function userStatus_(v) {
  var x = String(v == null ? '' : v).trim().toLowerCase();
  return x === 'active' || x === 'સક્રિય' ? 'Active' : 'Inactive';
}
/** Sheet value (Gujarati or English) → internal type key, '' if unknown. */
function typeFromCell_(v) {
  var x = String(v == null ? '' : v).trim(), k;
  for (k in TYPE_SHEET) if (TYPE_SHEET[k] === x || k.toLowerCase() === x.toLowerCase()) return k;
  return '';
}
function typeToSheet_(k) { return TYPE_SHEET[k] || k; }
function typeLabel_(k) { return TYPE_SHEET[k] || k; }

function cleanName_(v) {
  var n = str_(v, 40);
  if (!n) throw new ApiError('bad_request', 'નામ લખવું જરૂરી છે.');
  if (/^[=+\-@]/.test(n)) throw new ApiError('bad_request', 'નામ = + - @ થી શરૂ ન થઈ શકે.');
  return n;
}

function dateKey_(v) {
  var s = String(v == null ? '' : v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ApiError('bad_request', 'અમાન્ય તારીખ.');
  return s;
}

function toDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  var s = String(v == null ? '' : v).trim().replace(' ', 'T');
  var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
  if (!m) return null;
  try { return Utilities.parseDate(m[1] + 'T' + m[2], TIME_ZONE, TIME_FMT); } catch (e) { return null; }
}

function str_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}
function strMulti_(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
/** setValues() evaluates strings starting with = + - @ → prefix an apostrophe; stripped on read. */
function safeText_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }
function unsafeText_(s) { return /^'[=+\-@]/.test(s) ? s.slice(1) : s; }

function newId_(prefix) {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

// ------------------------- USERS / TOKENS ---------------------------

function findUser_(username) {
  var t = table_(SHEET_USERS), want = String(username).toLowerCase();
  // An old sheet without the Role column (before this version) had a single owner → keeps working until setupSheets is run.
  var legacy = t.idx.Role === undefined;
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (String(r[t.idx.Username]).trim().toLowerCase() === want) {
      var role = legacy ? 'Owner' : roleOf_(r[t.idx.Role]);
      return {
        t: t, row: i + 2,
        username: String(r[t.idx.Username]).trim(),
        name: String(r[t.idx.Name] || r[t.idx.Username]).trim(),
        password: String(r[t.idx.Password] || ''),
        status: userStatus_(r[t.idx.Status]),
        role: role,
        access: accessOf_(role, t.idx.Access === undefined ? '' : r[t.idx.Access])
      };
    }
  }
  return null;
}

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0'); }).join('');
}
function hashPassword_(plain) {
  var salt = Utilities.getUuid().replace(/-/g, '');
  return 'sha256$' + salt + '$' + sha256Hex_(salt + plain);
}
function verifyPassword_(stored, plain) {
  stored = String(stored);
  if (stored.indexOf('sha256$') === 0) {
    var p = stored.split('$');
    return p.length === 3 && safeEqual_(sha256Hex_(p[1] + plain), p[2]);
  }
  return stored !== '' && safeEqual_(stored, plain);
}
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length, n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function secret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}
function sign_(m) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(m, secret_()));
}
function makeToken_(user) {
  var expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return { token: expires + '.' + sign_(user.username + '.' + expires + '.' + user.password), expires: expires };
}
function authenticate_(body) {
  var expired = new ApiError('session_expired', 'સત્ર પૂરું થયું. ફરી લોગિન કરો.');
  var username = str_(body.username, 60), token = String(body.token || ''), dot = token.indexOf('.');
  if (!username || dot < 1) throw expired;
  var expires = Number(token.slice(0, dot));
  if (!isFinite(expires) || expires < Date.now()) throw expired;
  var user = findUser_(username);
  if (!user || user.status !== 'Active') throw expired;
  if (!safeEqual_(sign_(user.username + '.' + expires + '.' + user.password), token.slice(dot + 1))) throw expired;
  return user;
}

function assertNotLocked_(u) {
  if (Number(CacheService.getScriptCache().get('fail_' + u.toLowerCase()) || 0) >= MAX_ATTEMPTS) {
    throw new ApiError('too_many_attempts', 'ઘણા ખોટા પ્રયત્નો. ૧૫ મિનિટ પછી પ્રયત્ન કરો.');
  }
}
function recordFailure_(u) {
  var c = CacheService.getScriptCache(), k = 'fail_' + u.toLowerCase();
  c.put(k, String(Number(c.get(k) || 0) + 1), LOCKOUT_SECONDS);
}
function clearFailures_(u) { CacheService.getScriptCache().remove('fail_' + u.toLowerCase()); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function ok_(d) { d = d || {}; d.success = true; return json_(d); }
function fail_(code, message) { return json_({ success: false, error: code, message: message }); }

// ------------------------- ADMIN (run from editor) -------------------

/** Creates / completes all tabs, formats, defaults and the Analysis sheet. Safe to re-run. */
function setupSheets() {
  var ss = ss_();
  ss.setSpreadsheetTimeZone(TIME_ZONE);
  if (ss.getName().indexOf('Untitled') === 0) ss.rename('દુકાન હિસાબ');

  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var need = HEADERS[name];
    var have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    need.forEach(function (h) { if (have.indexOf(h) < 0) { sh.getRange(1, have.length + 1).setValue(h); have.push(h); } });
    sh.getRange(1, 1, 1, have.length).setFontWeight('bold').setBackground('#E8EAF6');
    sh.setFrozenRows(1);
  });
  var usersT = table_(SHEET_USERS);
  usersT.sh.getRange(2, usersT.idx.Role + 1, 50, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['એડમિન', 'એડિટ', 'વ્યૂ'], true).setAllowInvalid(false).build());
  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);

  var tx = table_(SHEET_TXN), n = 5000;
  tx.sh.getRange(2, tx.idx.Time + 1, n, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  tx.sh.getRange(2, tx.idx.Notes + 1, n, 1).setNumberFormat('@');
  tx.sh.getRange(2, tx.idx.Amount + 1, n, 1).setNumberFormat('#,##0.00');
  tx.sh.getRange(2, tx.idx.Type + 1, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(TYPES.map(typeToSheet_), true).setAllowInvalid(false).build());

  var ct = table_(SHEET_CAT);
  ct.sh.getRange(2, ct.idx.Type + 1, 500, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(CAT_TYPES.map(typeToSheet_), true).setAllowInvalid(false).build());
  ct.sh.getRange(2, ct.idx.Note + 1, 500, 1).setNumberFormat('@');
  var ac = table_(SHEET_ACC);
  ac.sh.getRange(2, ac.idx.Note + 1, 500, 1).setNumberFormat('@');
  var us = table_(SHEET_USERS);
  us.sh.getRange(2, us.idx.Password + 1, 50, 1).setNumberFormat('@');
  us.sh.getRange(2, us.idx.Status + 1, 50, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['સક્રિય', 'નિષ્ક્રિય'], true).build());

  [SHEET_ACC, SHEET_CAT].forEach(function (tab) {
    var st = table_(tab);
    st.sh.getRange(2, st.idx.Status + 1, 500, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['સક્રિય', 'નિષ્ક્રિય'], true).setAllowInvalid(false).build());
  });
  seedDefaults_();
  fillStatus_();
  fillMissingIds_();
  refreshBalanceFormulas_();
  setupAnalysis();
  SpreadsheetApp.flush();
}

/** Existing accounts / categories without a Status become Active (safe to run any time). */
function fillStatus_() {
  [SHEET_ACC, SHEET_CAT].forEach(function (tab) {
    var t = table_(tab);
    if (!t.rows.length) return;
    var changed = false;
    var vals = t.rows.map(function (r) {
      var hasData = String(r[t.idx.Name]).trim() !== '';
      if (hasData && !String(r[t.idx.Status]).trim()) { changed = true; return ['સક્રિય']; }
      return [r[t.idx.Status]];
    });
    if (changed) t.sh.getRange(2, t.idx.Status + 1, vals.length, 1).setValues(vals);
  });
}

function seedDefaults_() {
  var a = table_(SHEET_ACC);
  if (!a.rows.length) {
    var accs = [['રોકડ', '💵', 'ગલ્લાની રોકડ', 'A1'], ['બેંક', '🏦', 'બેંક ખાતું', 'A2']];
    a.sh.getRange(2, 1, accs.length, a.width).setValues(accs.map(function (d) {
      var r = blankRow_(a);
      r[a.idx.ID] = newId_('A') + d[3]; r[a.idx.Name] = d[0]; r[a.idx.Opening_Balance] = 0; r[a.idx.Icon] = d[1]; r[a.idx.Note] = d[2]; r[a.idx.Status] = 'સક્રિય';
      return r;
    }));
  }
  var c = table_(SHEET_CAT);
  if (!c.rows.length) {
    // [name, type, icon, default account]   (વેપાર: રોકડ → રોકડ ખાતું, ઓનલાઇન → બેંક)
    var defs = [
      ['રોકડ', 'Income', '💵', 'રોકડ'], ['ઓનલાઇન', 'Income', '📲', 'બેંક'],
      ['ચા-નાસ્તો', 'Expense', '☕', ''], ['કારીગર પગાર', 'Expense', '👷', ''], ['લાઇટ બિલ', 'Expense', '💡', ''],
      ['સ્ટેશનરી', 'Expense', '📎', ''], ['ભાડું', 'Expense', '🏠', ''], ['અન્ય', 'Expense', '🧾', ''],
      ['ઘર ખર્ચ', 'Investment', '🏡', ''], ['અન્ય', 'Investment', '🧾', '']
    ];
    c.sh.getRange(2, 1, defs.length, c.width).setValues(defs.map(function (d, i) {
      var r = blankRow_(c);
      r[c.idx.ID] = newId_('C') + i; r[c.idx.Name] = d[0]; r[c.idx.Type] = typeToSheet_(d[1]); r[c.idx.Icon] = d[2];
      r[c.idx.Budget] = 0; r[c.idx.Default_Account] = d[3]; r[c.idx.Status] = 'સક્રિય';
      return r;
    }));
  }
}

/** Gives an ID to rows pasted without one (needed for edit / delete in the app). */
function fillMissingIds() { fillMissingIds_(); }
function fillMissingIds_() {
  [[SHEET_TXN, 'T'], [SHEET_ACC, 'A'], [SHEET_CAT, 'C']].forEach(function (p) {
    var t = table_(p[0]);
    if (!t.rows.length) return;
    var changed = false, k = 0;
    var vals = t.rows.map(function (r) {
      var hasData = r.some(function (x, i) { return i !== t.idx.ID && String(x) !== ''; });
      if (hasData && !String(r[t.idx.ID])) { changed = true; return [newId_(p[1]) + (k++).toString(36)]; }
      return [r[t.idx.ID]];
    });
    if (changed) t.sh.getRange(2, t.idx.ID + 1, vals.length, 1).setValues(vals);
  });
}

/**
 * Builds the હિસાબ tab. Change FROM / TO (B1 / B2) → everything recalculates. Default = current month.
 *   A:B વેપાર · D:E ખર્ચા · G:H ઉપાડ (total + category-wise)   J:M date-wise: તારીખ | વેપાર | ખર્ચા | ઉપાડ
 *   O1: બચ્યું = વેપાર − ખર્ચા − ઉપાડ  (transfers are never counted)
 */
function setupAnalysis() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET_ANA) || ss.insertSheet(SHEET_ANA);
  sh.clear();
  var c = txnCols_();
  function rng(n) { return "'" + SHEET_TXN + "'!$" + c[n] + ':$' + c[n]; }

  sh.getRange('A1').setValue('તારીખથી'); sh.getRange('B1').setFormula('=DATE(YEAR(TODAY()),MONTH(TODAY()),1)');
  sh.getRange('A2').setValue('તારીખ સુધી'); sh.getRange('B2').setFormula('=EOMONTH(TODAY(),0)');
  sh.getRange('A1:A2').setFontWeight('bold');
  sh.getRange('B1:B2').setNumberFormat('yyyy-mm-dd').setBackground('#FFF8E1').setFontWeight('bold');
  sh.getRange('C1').setValue('← કોઈ પણ સમયગાળો જોવા આ બે તારીખ બદલો (તારીખ-વાઈઝ ટેબલ ૩૬૬ દિવસ સુધી)');

  var blocks = [['Income', 'A', 'B', '#2E7D32'], ['Expense', 'D', 'E', '#C62828'], ['Investment', 'G', 'H', '#1565C0']];
  blocks.forEach(function (b) {
    var type = TYPE_SHEET[b[0]], c1 = b[1], c2 = b[2];
    sh.getRange(c1 + '4').setValue(type + ' ઓવરવ્યૂ').setFontWeight('bold').setFontColor('#FFFFFF');
    sh.getRange(c1 + '4:' + c2 + '4').setBackground(b[3]);
    sh.getRange(c1 + '5').setValue('કુલ').setFontWeight('bold');
    sh.getRange(c2 + '5').setFormula(
      '=SUMIFS(' + rng('Amount') + ',' + rng('Type') + ',"' + type + '",' + rng('Time') + ',">="&$B$1,' + rng('Time') + ',"<"&($B$2+1))')
      .setNumberFormat('#,##0.00').setFontWeight('bold');
    var Q = "'";
    sh.getRange(c1 + '7').setFormula(
      '=IF($' + c2 + '$5=0,"માહિતી નથી",QUERY(' + Q + SHEET_TXN + Q + '!$B$2:$E,"select D, sum(C) where B=' + Q + type + Q +
      ' and A >= datetime ' + Q + '"&TEXT($B$1,"yyyy-MM-dd")&" 00:00:00' + Q + ' and A <= datetime ' + Q + '"&TEXT($B$2,"yyyy-MM-dd")&" 23:59:59' + Q +
      ' group by D order by sum(C) desc label D ' + Q + 'કેટેગરી' + Q + ', sum(C) ' + Q + 'રકમ' + Q + '",0))');
    sh.getRange(c2 + '7:' + c2 + '500').setNumberFormat('#,##0.00');
  });
  sh.getRange('J1').setValue('બચ્યું = વેપાર − ખર્ચા − ઉપાડ').setFontWeight('bold');
  sh.getRange('L1').setFormula('=B5-E5-H5').setNumberFormat('#,##0.00').setFontWeight('bold');

  sh.getRange('J4').setValue('તારીખ-વાઈઝ').setFontWeight('bold').setFontColor('#FFFFFF');
  sh.getRange('J4:M4').setBackground('#3F51B5');
  sh.getRange('J5:M5').setValues([['તારીખ', 'વેપાર', 'ખર્ચા', 'ઉપાડ']]).setFontWeight('bold').setBackground('#E8EAF6');
  var rows = [];
  for (var r = 6; r <= 371; r++) {
    var row = ['=IF($B$1+' + (r - 6) + '<=$B$2,$B$1+' + (r - 6) + ',"")'];
    ['Income', 'Expense', 'Investment'].forEach(function (k) {
      row.push('=IF($J' + r + '="","",SUMIFS(' + rng('Amount') + ',' + rng('Type') + ',"' + TYPE_SHEET[k] + '",' + rng('Time') + ',">="&$J' + r + ',' + rng('Time') + ',"<"&($J' + r + '+1)))');
    });
    rows.push(row);
  }
  sh.getRange(6, 10, rows.length, 4).setFormulas(rows);
  sh.getRange('J6:J371').setNumberFormat('yyyy-mm-dd ddd');
  sh.getRange('K6:M371').setNumberFormat('#,##0.00;-#,##0.00;"-"');

  sh.setColumnWidth(1, 160); sh.setColumnWidth(4, 160); sh.setColumnWidth(7, 160); sh.setColumnWidth(10, 130);
  sh.setColumnWidth(3, 30);  sh.setColumnWidth(6, 30);  sh.setColumnWidth(9, 30);
}

/** Edit the constants, then run once: adds a login (or resets that user's password / role / access). */
function createUser() {
  var ADMIN_USERNAME = 'admin';
  var ADMIN_NAME     = 'એડમિન';
  var ADMIN_PASSWORD = 'ChangeMe123';
  var USER_ROLE      = 'એડમિન';                           // એડમિન · એડિટ · વ્યૂ
  var USER_ACCESS    = 'આજ, હિસાબ, ખાતા, કેટેગરી';        // pages (ignored for એડમિન)

  if (ADMIN_PASSWORD.length < 6) throw new Error('પાસવર્ડ ઓછામાં ઓછા ૬ અક્ષરનો રાખો.');
  if (['એડમિન', 'એડિટ', 'વ્યૂ'].indexOf(USER_ROLE) < 0) throw new Error('Role એડમિન, એડિટ અથવા વ્યૂ હોવો જોઈએ.');
  var existing = findUser_(ADMIN_USERNAME);
  var hash = hashPassword_(ADMIN_PASSWORD);
  if (existing) {
    var t = existing.t;
    t.sh.getRange(existing.row, t.idx.Password + 1).setNumberFormat('@').setValue(hash);
    t.sh.getRange(existing.row, t.idx.Status + 1).setValue('સક્રિય');
    t.sh.getRange(existing.row, t.idx.Role + 1).setValue(USER_ROLE);
    t.sh.getRange(existing.row, t.idx.Access + 1).setValue(USER_ACCESS);
    Logger.log('અપડેટ: ' + ADMIN_USERNAME + ' (' + USER_ROLE + ')');
  } else {
    var u = table_(SHEET_USERS), row = blankRow_(u);
    row[u.idx.Username] = ADMIN_USERNAME; row[u.idx.Name] = ADMIN_NAME; row[u.idx.Password] = hash; row[u.idx.Status] = 'સક્રિય';
    row[u.idx.Role] = USER_ROLE; row[u.idx.Access] = USER_ACCESS;
    u.sh.getRange(Math.max(u.sh.getLastRow(), 1) + 1, 1, 1, u.width).setNumberFormat('@').setValues([row]);
    Logger.log('નવો યુઝર: ' + ADMIN_USERNAME + ' (' + USER_ROLE + ')');
  }
}
