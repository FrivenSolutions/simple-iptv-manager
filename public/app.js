// Simple IPTV Manager web UI: plain DOM, hash routing, no build step.

// ---------------------------------------------------------------- helpers --

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected', 'indeterminate'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

// Like replaceChildren, but skips null/false instead of rendering them as text.
function fill(el, ...kids) {
  el.replaceChildren();
  return append(el, kids);
}

const $app = document.getElementById('app');
let cleanups = [];

class ApiError extends Error {}

async function api(method, path, body, raw = false) {
  const res = await fetch(path, {
    method,
    headers: raw ? { 'x-requested-with': 'fetch' } : { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && !path.startsWith('/api/login')) {
    route();
    throw new ApiError('Session expired');
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  }
}

// "7:30 PM" today, "Sat 7:30 PM" on another day.
function whenLocal(ts) {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round(Date.now() / 1000 - ts);
  const f = (n, u) => `${n} ${u}${n === 1 ? '' : 's'}`;
  const abs = Math.abs(s);
  const txt = abs < 60 ? f(abs, 'second') : abs < 3600 ? f(Math.round(abs / 60), 'minute')
    : abs < 86400 ? f(Math.round(abs / 3600), 'hour') : f(Math.round(abs / 86400), 'day');
  return s >= 0 ? `${txt} ago` : `in ${txt}`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Plain-HTTP homelab pages have no clipboard API; fall back to a hidden textarea.
    const ta = h('textarea', { class: 'offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

function copyField(label, value) {
  return h('div', { class: 'copy-field' },
    h('label', null, label),
    h('div', { class: 'row' },
      h('input', { value, readonly: true, onfocus: (e) => e.target.select() }),
      h('button', { class: 'btn', onclick: () => copy(value) }, 'Copy')));
}

function modal(title, body, actions = [], onClose = null) {
  const close = () => {
    if (!bg.isConnected) return;
    bg.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const bg = h('div', { class: 'modal-bg', onmousedown: (e) => e.target === bg && close() },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-actions' }, actions) : null));
  document.body.append(bg);
  document.addEventListener('keydown', onKey);
  bg.querySelector('input, select, textarea')?.focus();
  return close;
}

function confirmBox(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let answer = false;
    const close = modal('Are you sure?', h('p', null, message), [
      h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: () => { answer = true; close(); } }, okLabel),
    ], () => resolve(answer));
  });
}

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

/** A name as players see it, with the provider's name struck through after it when they differ. */
function shownName(x) {
  const shown = x.custom_name || x.clean_name || x.name;
  return shown === x.name ? shown : [shown, ' ', h('s', { class: 'old-name', title: 'The provider\'s name' }, x.name)];
}

/**
 * A card whose heading folds it away; the browser remembers which are folded. note() says what's
 * inside while it is folded, e.g. "3 rules".
 */
function foldCard(key, title, note, ...body) {
  const store = `iptvm.fold.${key}`;
  let folded = false;
  try {
    folded = localStorage.getItem(store) === '1';
  } catch {}
  const inner = h('div', { class: 'fold-body' }, ...body);
  const arrow = h('span', { class: 'fold-arrow' });
  const summary = h('span', { class: 'meta' });
  const head = h('button', {
    type: 'button',
    class: 'fold-head',
    onclick: () => {
      folded = !folded;
      try {
        localStorage.setItem(store, folded ? '1' : '0');
      } catch {}
      draw();
    },
  }, arrow, h('h2', null, title), summary);
  const draw = () => {
    inner.hidden = folded;
    arrow.textContent = folded ? '▸' : '▾';
    head.setAttribute('aria-expanded', String(!folded));
    summary.textContent = folded ? note() : '';
  };
  draw();
  return h('section', { class: 'card' }, head, inner);
}

const ruleCount = (rules) => `${rules.length} rule${rules.length === 1 ? '' : 's'}`;

function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, text);
}

function statusBadge(src) {
  if (src.job === 'running') return badge('Refreshing…', 'info');
  if (src.job === 'queued') return badge('Queued', 'info');
  if (!src.enabled) return badge('Disabled', 'muted');
  if (src.last_status === 'ok') return badge('OK', 'ok');
  if (src.last_status === 'warning') return badge('Warning', 'warn');
  if (src.last_status === 'error') return badge('Error', 'error');
  return badge('Not refreshed', 'muted');
}

// Each navigation bumps routeSeq; timers from an older view stop themselves.
let routeSeq = 0;

function poll(fn, ms) {
  const seq = routeSeq;
  let busy = false;
  const tick = async () => {
    if (document.hidden || busy || document.querySelector('.modal-bg')) return;
    busy = true;
    try {
      await fn();
    } catch {
      // Transient; the next tick retries.
    } finally {
      busy = false;
    }
  };
  // Paused while the tab is hidden; caught up as soon as it is shown again.
  const onShow = () => { if (seq === routeSeq && !document.hidden) tick(); };
  document.addEventListener('visibilitychange', onShow);
  const t = setInterval(() => {
    if (seq !== routeSeq) {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
      return;
    }
    tick();
  }, ms);
}

/**
 * Keep a container's children in step with a list without re-rendering unchanged items:
 * only items whose data (or `extra` signature) changed are rebuilt, so polling never
 * flashes the page or disturbs focus and scroll.
 */
function syncList(container, items, keyOf, render, extra = () => '') {
  const prev = container._keyed || new Map();
  const next = new Map();
  const nodes = items.map((it) => {
    const key = keyOf(it);
    const sig = JSON.stringify(it) + extra(it);
    const old = prev.get(key);
    const node = old && old.sig === sig ? old.node : render(it);
    next.set(key, { sig, node });
    return node;
  });
  nodes.forEach((n, i) => {
    if (container.children[i] !== n) container.insertBefore(n, container.children[i] || null);
  });
  while (container.children.length > nodes.length) container.lastElementChild.remove();
  container._keyed = next;
}

// "x minutes ago" labels drift, so let rows re-render once a minute.
const minuteTick = () => String(Math.floor(Date.now() / 60000));

// Why a channel is in or out (besides its category), as shown in lists and search hits.
const CH_REASONS = {
  manual: 'picked by hand', rule: 'by rule', nomatch: 'no include rule matched', empty: 'empty event',
  guide: 'nothing on now', unlisted: 'nothing listed soon',
};

const OP_LABELS = {
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  not_starts_with: 'does not start with',
  ends_with: 'ends with',
  not_ends_with: 'does not end with',
  equals: 'equals',
  not_equals: 'does not equal',
  regex: 'matches regex',
};

// Same decision logic as src/filters.js, so rule edits preview before saving.
function testRule(rule, name) {
  const n = String(name || '').toLowerCase();
  const v = String(rule.value || '').toLowerCase();
  switch (rule.op) {
    case 'contains': return n.includes(v);
    case 'not_contains': return !n.includes(v);
    case 'starts_with': return n.startsWith(v);
    case 'not_starts_with': return !n.startsWith(v);
    case 'ends_with': return n.endsWith(v);
    case 'not_ends_with': return !n.endsWith(v);
    case 'equals': return n === v;
    case 'not_equals': return n !== v;
    case 'regex': try { return new RegExp(rule.value, 'i').test(name); } catch { return false; }
    default: return false;
  }
}

/**
 * Include and Exclude boxes for a rule list, with drag-and-drop (by the ⠿ handle) plus
 * ↑/↓/⇄ buttons for touch and keyboard. `rules` is edited in place and kept includes-first.
 * Order is only for organizing: a match in any include counts, and any exclude match wins.
 *   fields(rule)      the controls between the handle and the buttons
 *   commit()          after a move, reorder or removal
 *   onAdd(rule)       after "+ Add" (the new rule has no value yet)
 *   newRule(action)   the rule "+ Add" creates
 */
function ruleGroups({ rules, subject, fields, commit, onAdd, newRule, off = false }) {
  const regroup = () => {
    const inc = rules.filter((r) => r.action === 'include');
    const exc = rules.filter((r) => r.action !== 'include');
    rules.splice(0, rules.length, ...inc, ...exc);
  };
  regroup();
  let dragging = null;

  const moveTo = (rule, action, before) => {
    rules.splice(rules.indexOf(rule), 1);
    rule.action = action;
    const end = action === 'include' ? rules.filter((r) => r.action === 'include').length : rules.length;
    rules.splice(before ? rules.indexOf(before) : end, 0, rule);
    regroup();
    commit();
  };
  const neighbor = (rule, step) => {
    for (let i = rules.indexOf(rule) + step; i >= 0 && i < rules.length; i += step) {
      if (rules[i].action === rule.action) return i;
    }
    return -1;
  };
  const swap = (rule, step) => {
    const i = rules.indexOf(rule);
    const j = neighbor(rule, step);
    if (j < 0) return;
    [rules[i], rules[j]] = [rules[j], rules[i]];
    commit();
  };
  const clearMarks = () => document.querySelectorAll('.drop-before, .drop-target').forEach((el) => el.classList.remove('drop-before', 'drop-target'));

  const row = (r) => {
    const other = r.action === 'include' ? 'exclude' : 'include';
    const el = h('div', {
      class: 'rule-row',
      ondragstart: (e) => {
        dragging = r;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
      },
      ondragend: () => {
        dragging = null;
        el.draggable = false;
        el.classList.remove('dragging');
        clearMarks();
      },
      ondragover: (e) => {
        if (!dragging || dragging === r) return;
        e.preventDefault();
        e.stopPropagation();
        clearMarks();
        el.classList.add('drop-before');
      },
      ondrop: (e) => {
        if (!dragging || dragging === r) return;
        e.preventDefault();
        e.stopPropagation();
        moveTo(dragging, r.action, r);
      },
    },
    h('span', {
      class: `drag-handle ${off ? 'disabled' : ''}`,
      title: off ? '' : 'Drag to reorder, or into the other box to switch',
      // Only the handle starts a drag, so text in the inputs can still be selected.
      onmousedown: () => { if (!off) el.draggable = true; },
      onmouseup: () => { el.draggable = false; },
    }, '⠿'),
    fields(r),
    h('span', { class: 'rule-buttons' },
      h('button', { class: 'icon-btn', disabled: off || neighbor(r, -1) < 0, title: 'Move up', onclick: () => swap(r, -1) }, '↑'),
      h('button', { class: 'icon-btn', disabled: off || neighbor(r, 1) < 0, title: 'Move down', onclick: () => swap(r, 1) }, '↓'),
      h('button', { class: 'icon-btn', disabled: off, title: `Move to ${other === 'include' ? 'Include' : 'Exclude'}`, onclick: () => moveTo(r, other, null) }, '⇄'),
      h('button', { class: 'icon-btn', disabled: off, title: 'Remove rule', onclick: () => { rules.splice(rules.indexOf(r), 1); commit(); } }, '✕')));
    if (r === ruleGroups.focus) {
      ruleGroups.focus = null;
      setTimeout(() => el.querySelector('input')?.focus());
    }
    return el;
  };

  const group = (action) => {
    const list = rules.filter((r) => r.action === action);
    const box = h('div', {
      class: `rule-group ${action}`,
      ondragover: (e) => {
        if (!dragging) return;
        e.preventDefault();
        clearMarks();
        box.classList.add('drop-target');
      },
      ondrop: (e) => {
        if (!dragging) return;
        e.preventDefault();
        moveTo(dragging, action, null);
      },
    },
    h('div', { class: 'rule-group-head' },
      h('b', null, action === 'include' ? 'Include' : 'Exclude'),
      h('span', { class: 'meta' }, action === 'include'
        ? ` ${subject} matching any of these`
        : ` ${subject} matching any of these. Exclusions always win.`)),
    list.map(row),
    list.length ? null : h('p', { class: 'meta rule-empty' }, `No ${action} rules${off ? '' : '. Add one, or drag a rule here.'}`),
    h('button', {
      class: 'btn small',
      disabled: off,
      onclick: () => {
        const r = newRule(action);
        rules.push(r);
        regroup();
        ruleGroups.focus = r;
        onAdd(r);
      },
    }, `+ Add ${action} rule`));
    return box;
  };

  return h('div', { class: 'rule-groups' }, group('include'), group('exclude'));
}

function categoryState(cat, rules, override, includeAll) {
  if (override) return { included: override === 'include', reason: 'manual' };
  const applicable = rules.filter((r) => r.value !== '' && (r.source_id == null || r.source_id === cat.source_id));
  const exclude = applicable.find((r) => r.action === 'exclude' && testRule(r, cat.name));
  if (exclude) return { included: false, reason: 'rule', rule: exclude };
  const includes = applicable.filter((r) => r.action === 'include');
  if (!includes.length) return { included: !!includeAll, reason: 'default' };
  const hit = includes.find((r) => testRule(r, cat.name));
  return hit ? { included: true, reason: 'rule', rule: hit } : { included: false, reason: 'nomatch' };
}

// ------------------------------------------------------------------ shell --

let shell = null; // { header, main, links } while logged in

function ensureShell(view) {
  if (!shell || !shell.header.isConnected) {
    const links = [['dashboard', 'Dashboard'], ['sources', 'Sources'], ['outputs', 'Outputs'], ['watch', 'Watch'], ['settings', 'Settings']]
      .map(([v, label]) => h('a', { href: `#/${v}`, 'data-view': v }, label));
    const header = h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: '/favicon.svg', alt: '' }), 'Simple IPTV Manager'),
      h('nav', null, links),
      h('a', { class: 'update-badge', href: '#/settings', hidden: true }, 'Update available'),
      h('button', { class: 'btn ghost', onclick: async () => { await api('POST', '/api/logout'); route(); } }, 'Log out'));
    const main = h('main', { class: 'content' });
    fill($app, header, main);
    shell = { header, main, links };
  }
  for (const a of shell.links) a.classList.toggle('active', a.dataset.view === view);
}

// Views render into a detached <main> and are swapped in only when complete,
// so navigating never shows a blank page in between.
// The page last shown: a new page starts at the top, a redraw of the same one keeps its place.
let shownHash = null;

async function route() {
  const seq = ++routeSeq;
  for (const c of cleanups.splice(0)) c();
  document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
  let session;
  try {
    session = await fetch('/api/session').then((r) => r.json());
  } catch {
    shell = null;
    fill($app, h('div', { class: 'center-card' }, h('p', null, 'Cannot reach the server.')));
    return;
  }
  if (seq !== routeSeq) return;
  if (session.setup_required || !session.authenticated) {
    shell = null;
    return renderAuth(session.setup_required);
  }

  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = parts[0] || 'dashboard';
  const main = h('main', { class: 'content' });
  try {
    if (view === 'sources' && parts[1]) await sourceDetail(main, Number(parts[1]));
    else if (view === 'sources') await sourcesView(main);
    else if (view === 'outputs' && parts[1]) await outputEditor(main, Number(parts[1]));
    else if (view === 'outputs') await outputsView(main);
    else if (view === 'watch') await watchView(main, Number(parts[1]) || null, Number(parts[2]) || null);
    else if (view === 'settings') await settingsView(main);
    else await dashboard(main);
  } catch (e) {
    if (e instanceof ApiError && e.message === 'Session expired') return;
    fill(main, h('div', { class: 'card error-card' }, h('h2', null, 'Something went wrong'), h('p', null, e.message)));
  }
  if (seq !== routeSeq) return;
  ensureShell(view);
  shell.main.replaceWith(main);
  shell.main = main;
  if (location.hash !== shownHash) window.scrollTo(0, 0);
  shownHash = location.hash;
  refreshUpdateBadge();
}

function renderAuth(setup) {
  const pw = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 8 : null });
  const pw2 = setup ? h('input', { type: 'password', autocomplete: 'new-password', required: true }) : null;
  // Asked for after the password, when two-factor sign-in is on.
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', class: 'code-input', maxlength: 9 });
  const codeField = field('Code from your authenticator app', code, 'Or one of your recovery codes.');
  codeField.hidden = true;
  const err = h('p', { class: 'form-error' });
  const form = h('form', {
    class: 'center-card card',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (setup && pw.value !== pw2.value) return (err.textContent = 'Passwords do not match');
      try {
        const r = await api('POST', setup ? '/api/setup' : '/api/login', { password: pw.value, code: codeField.hidden ? undefined : code.value });
        if (r?.two_factor_required) {
          codeField.hidden = false;
          code.focus();
          return;
        }
        route();
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  },
  h('div', { class: 'brand big' }, h('img', { src: '/favicon.svg', alt: '' }), 'Simple IPTV Manager'),
  setup ? h('p', null, 'Welcome! Choose an admin password to protect this dashboard.') : null,
  field(setup ? 'New password' : 'Password', pw, setup ? 'At least 8 characters.' : null),
  setup ? field('Repeat password', pw2) : null,
  setup ? null : codeField,
  err,
  h('button', { class: 'btn primary wide', type: 'submit' }, setup ? 'Create password' : 'Log in'));
  fill($app, form);
  pw.focus();
}

// -------------------------------------------------------------- dashboard --

async function dashboard(main) {
  const srcGrid = h('div', { class: 'grid' });
  const outGrid = h('div', { class: 'grid' });
  const getStarted = h('div', { class: 'card empty' },
    h('h2', null, 'Get started'),
    h('ol', { class: 'steps' },
      h('li', null, 'Add a source: an M3U playlist URL or your Xtream Codes login.'),
      h('li', null, 'Create an output and choose which categories to keep, using rules or by picking them by hand.'),
      h('li', null, 'Point your IPTV app at the output\'s M3U + EPG URLs or its Xtream Codes login.')),
    h('a', { class: 'btn primary', href: '#/sources' }, 'Add a source'));
  const noOutputs = h('div', { class: 'card empty' }, h('p', null, 'No outputs yet.'), h('a', { class: 'btn primary', href: '#/outputs' }, 'Create an output'));
  const srcSection = h('section', null, h('h2', null, 'Sources'), srcGrid);
  const outSection = h('section', null, h('h2', null, 'Outputs'), outGrid, noOutputs);

  const alertBox = h('div', { class: 'alerts' });
  // Who is watching what: proxied streams from start to stop (Watching now), and what redirected
  // ones started (Recently started: the player talks to the provider after that). Refreshed on its
  // own, every 2 seconds, apart from the rest of the dashboard.
  const watchList = h('div', { class: 'watch-list' });
  const watchCount = h('span', { class: 'meta' });
  const watchEmpty = h('p', { class: 'meta pad' }, 'Nobody is watching through a Proxy output right now.');
  const startedList = h('div', { class: 'watch-list' });
  const startedSection = h('div', { class: 'started' },
    h('div', { class: 'section-head' }, h('h3', null, 'Recently started'),
      h('span', { class: 'meta' }, 'through Redirect or Direct outputs: only the start is seen; dropped after an hour or when that device starts something else')),
    h('div', { class: 'card flush' }, startedList));
  const watchSection = h('section', null,
    h('div', { class: 'section-head' }, h('h2', null, 'Watching now'), watchCount),
    h('div', { class: 'card flush' }, watchList, watchEmpty),
    startedSection,
    h('p', { class: 'hint' }, 'Only outputs set to Proxy show each stream from start to stop. Direct M3U playlists never reach this server.'));
  const updateViewers = async () => {
    const viewers = await api('GET', '/api/viewers');
    const watching = viewers.filter((v) => v.mode === 'proxy');
    const started = viewers.filter((v) => v.mode !== 'proxy');
    watchEmpty.hidden = watching.length > 0;
    const transcoding = watching.filter((v) => v.transcode).length;
    watchCount.textContent = watching.length
      ? `${watching.length} stream${watching.length === 1 ? '' : 's'}${transcoding ? ` · ${transcoding} transcoding` : ''}` : '';
    syncList(watchList, watching, (v) => v.key, watchRow, minuteTick);
    startedSection.hidden = !started.length;
    syncList(startedList, started, (v) => v.key, watchRow, minuteTick);
  };
  let alertSig = '';
  const update = async () => {
    const [sources, outputs, alerts] = await Promise.all([api('GET', '/api/sources'), api('GET', '/api/outputs'), api('GET', '/api/alerts')]);
    watchSection.hidden = !sources.length;
    // Only redraw the alert strip when it changed, so polling never makes it flicker.
    const sig = JSON.stringify(alerts);
    if (sig !== alertSig) {
      alertSig = sig;
      fill(alertBox, alerts.map((a) => h('div', { class: `alert ${a.level}` },
        h('b', null, a.title), ' ', h('span', null, a.message), ' ',
        a.source_id ? h('a', { href: `#/sources/${a.source_id}` }, 'Open source') : null)));
    }
    getStarted.hidden = sources.length > 0;
    srcSection.hidden = outSection.hidden = !sources.length;
    noOutputs.hidden = outputs.length > 0;
    syncList(srcGrid, sources, (s) => s.id, sourceCard, minuteTick);
    syncList(outGrid, outputs, (o) => o.id, outputCard);
  };
  await Promise.all([update(), updateViewers()]);
  fill(main, h('div', { class: 'page-head' }, h('h1', null, 'Dashboard')), alertBox, getStarted, watchSection, srcSection, outSection);
  poll(update, 3000);
  poll(updateViewers, 2000);
}

function sourceCard(s) {
  const st = s.stats || {};
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, h('a', { href: `#/sources/${s.id}` }, s.name)), statusBadge(s)),
    h('div', { class: 'meta' }, TYPE_LABELS[s.type], ' · refreshed ', ago(s.last_refresh_at)),
    h('div', { class: 'stats' },
      stat(s.counts.channels, 'channels'), stat(s.counts.categories, 'categories'),
      stat(s.counts.channels ? `${Math.round((s.counts.epg_matched / s.counts.channels) * 100)}%` : '–', 'EPG matched')),
    st.newCategories ? h('p', { class: 'note' }, `${st.newCategories} new categor${st.newCategories === 1 ? 'y' : 'ies'} in the last refresh`) : null,
    s.last_error ? h('p', { class: s.last_status === 'error' ? 'form-error' : 'note warn' }, s.last_error) : null);
}

const KIND_LABELS = { live: 'Live', movie: 'Movie', episode: 'Episode' };

// Where a proxied stream is struggling, if anywhere: the provider pausing or silent now, this
// viewer's device or network falling behind, or (light copies) the encoder falling behind.
function healthLine(x) {
  if (!x) return null;
  const parts = [];
  if (x.silent_s) parts.push(h('b', { class: 'warn-text' }, `provider silent for ${x.silent_s} s`));
  if (x.provider_pauses) parts.push(`provider paused ${x.provider_pauses}× (longest ${x.longest_pause_s} s)`);
  if (x.encoder_behind_mb) parts.push(h('b', { class: 'warn-text' }, `encoder ${x.encoder_behind_mb} MB behind`));
  if (x.behind_mb) parts.push(h('b', { class: 'warn-text' }, `viewer ${x.behind_mb} MB behind`));
  // How this provider delivers, not a problem by itself: shown plainly, or after the warnings.
  const rhythm = x.burst_s ? `provider sends in ~${x.burst_s} s bursts` : null;
  if (!parts.length && !rhythm) return null;
  return h('div', {
    class: 'meta watch-health',
    title: 'Bursts: the provider sends the stream a few seconds at a time (usually built from HLS segments); a player with a bigger buffer rides that out. Provider pauses: gaps well past that usual rhythm (its side). Viewer behind: this device or its network is not taking the stream as fast as it comes. Encoder behind: ffmpeg cannot keep up (too many light streams for this server?).',
  }, parts.length ? ['⚠ ', parts.map((p, i) => [i ? ' · ' : '', p]), rhythm ? ` · ${rhythm}` : ''] : rhythm);
}

// One stream on the dashboard: who (and which device), what, where from, since when.
function watchRow(v) {
  return h('div', { class: `watch-row ${v.ending ? 'ending' : ''}` },
    h('div', { class: 'watch-who' },
      h('b', { title: v.username && v.username !== v.who ? `Username: ${v.username}` : '' }, v.who),
      h('span', { class: 'meta' }, v.ip)),
    h('div', { class: 'watch-what' },
      badge(KIND_LABELS[v.kind] || v.kind, 'muted'), ' ', h('span', { class: 'strong' }, v.what),
      v.transcode ? [' ', h('span', { class: 'badge info', title: `A 720p light copy for multi-view, made by ffmpeg with ${v.transcode === 'vaapi' ? 'Intel Quick Sync (GPU)' : 'the CPU'}` },
        `Transcoding · ${v.transcode === 'vaapi' ? 'Quick Sync' : 'software'}`)] : null,
      v.program ? h('div', { class: 'watch-program', title: `On now: ${v.program}` }, `▸ ${v.program}`) : null,
      h('div', { class: 'meta' },
        h('a', { href: `#/outputs/${v.output_id}` }, v.output), v.source ? ` · ${v.source}` : '',
        ` · ${v.mode === 'redirect' ? 'started' : 'since'} ${ago(v.started)}`),
      healthLine(v.health)),
    v.mode === 'redirect' ? badge('start only', 'warn') : v.ending ? badge('stopping', 'muted') : badge('watching', 'ok'));
}

function outputCard(o) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, h('a', { href: `#/outputs/${o.id}` }, o.name)),
      h('span', { class: 'row' }, o.paused ? badge('paused', 'warn') : null, badge(o.stream_mode, 'muted'))),
    h('div', { class: 'stats' }, stat(o.channel_count, 'channels'), stat(o.category_count, 'categories')),
    copyField('M3U playlist', o.urls.m3u),
    copyField('XMLTV guide', o.urls.epg));
}

const TYPE_LABELS = { m3u: 'M3U', xc: 'Xtream Codes', hdhr: 'HDHomeRun' };

// "12,345 movies · 678 series"
function vodCounts(s) {
  return `${s.counts.movies.toLocaleString()} movies · ${s.counts.series.toLocaleString()} series`;
}

// "1 of 2 streams in use" (proxy outputs only), or null when nothing is playing and there's no limit.
function streamsText(s) {
  const { open = 0, limit = 0 } = s.streams || {};
  if (!open) return null;
  return `${open}${limit ? ` of ${limit}` : ''} stream${(limit || open) === 1 ? '' : 's'} in use`;
}

function stat(v, label) {
  return h('div', { class: 'stat' }, h('b', null, v ?? 0), h('span', null, label));
}

// ---------------------------------------------------------------- sources --

async function sourcesView(main) {
  const tbody = h('tbody');
  const table = h('div', { class: 'card flush' }, h('table', { class: 'table stack' },
    h('thead', null, h('tr', null, ['Source', 'Status', 'Channels', 'Categories', 'EPG matched', 'Last refresh', ''].map((t) => h('th', null, t)))),
    tbody));
  const empty = h('div', { class: 'card empty' }, h('p', null, 'No sources yet. Add an M3U playlist or an Xtream Codes account.'));
  const update = async () => {
    const sources = await api('GET', '/api/sources');
    table.hidden = !sources.length;
    empty.hidden = sources.length > 0;
    syncList(tbody, sources, (s) => s.id, (s) => sourceRow(s, update), minuteTick);
  };
  await update();
  fill(main,
    h('div', { class: 'page-head' }, h('h1', null, 'Sources'), h('button', { class: 'btn primary', onclick: () => sourceForm(null, update) }, '+ Add source')),
    table, empty);
  poll(update, 3000);
}

function sourceRow(s, update) {
  return h('tr', null,
    h('td', { class: 'wide' }, h('a', { href: `#/sources/${s.id}`, class: 'strong' }, s.name), h('div', { class: 'meta' }, TYPE_LABELS[s.type])),
    h('td', { class: 'wide' }, statusBadge(s), s.last_error ? h('div', { class: 'meta clip', title: s.last_error }, s.last_error) : null,
      streamsText(s) ? h('div', { class: 'meta' }, streamsText(s)) : null),
    h('td', { class: 'num', 'data-label': 'Channels' }, s.counts.channels,
      s.counts.movies || s.counts.series ? h('div', { class: 'meta' }, vodCounts(s)) : null),
    h('td', { class: 'num', 'data-label': 'Categories' }, s.counts.categories),
    h('td', { class: 'num', 'data-label': 'Guide matched' }, s.counts.epg_matched),
    h('td', { class: 'wide', 'data-label': 'Last refresh' }, ago(s.last_refresh_at), h('div', { class: 'meta' }, s.next_refresh_at ? `next ${ago(s.next_refresh_at)}` : 'manual only')),
    h('td', { class: 'actions' },
      h('button', { class: 'btn', disabled: !!s.job, onclick: () => attempt(() => api('POST', `/api/sources/${s.id}/refresh`), 'Refresh started').then(update) }, 'Refresh'),
      h('button', { class: 'btn', onclick: () => sourceForm(s, update) }, 'Edit'),
      h('button', {
        class: 'btn danger-text',
        onclick: async () => {
          if (await confirmBox(`Delete "${s.name}" and all of its channels? Outputs using it will lose those channels.`)) {
            await attempt(() => api('DELETE', `/api/sources/${s.id}`), 'Source deleted');
            update();
          }
        },
      }, 'Delete')));
}

function sourceForm(src, onSaved = route) {
  const isNew = !src;
  let type = src?.type || 'm3u';
  const v = (x) => x ?? '';
  const f = {
    name: h('input', { value: v(src?.name), placeholder: 'My provider', required: true }),
    url: h('input', { value: src?.url?.startsWith('upload:') ? '' : v(src?.url), placeholder: 'http://provider/get.php?username=…&type=m3u_plus' }),
    file: h('input', { type: 'file', accept: '.m3u,.m3u8,.gz,text/plain' }),
    epg_urls: h('textarea', { rows: 3, placeholder: 'One URL per line (optional)' }),
    epg_file: h('input', { type: 'file', accept: '.xml,.gz,text/xml' }),
    xc_host: h('input', { value: v(src?.xc_host), placeholder: 'http://provider.example:8080' }),
    xc_username: h('input', { value: v(src?.xc_username), autocomplete: 'off' }),
    xc_password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: src?.has_password ? '(unchanged)' : '' }),
    xc_stream_ext: h('select', null, h('option', { value: 'ts', selected: src?.xc_stream_ext !== 'm3u8' }, 'MPEG-TS (.ts)'), h('option', { value: 'm3u8', selected: src?.xc_stream_ext === 'm3u8' }, 'HLS (.m3u8)')),
    hdhr_host: h('input', { value: v(src?.hdhr_host), placeholder: 'e.g. 192.168.1.100' }),
    user_agent: h('input', { value: v(src?.user_agent), placeholder: 'VLC/3.0.21 LibVLC/3.0.21 (default)' }),
    hours: h('input', { type: 'number', min: 0, step: 0.5, value: src ? src.refresh_minutes / 60 : 12 }),
    content: h('select', null,
      h('option', { value: 'live', selected: !src || src.live_only }, 'Live TV only'),
      h('option', { value: 'vod', selected: !!src && !src.live_only }, 'Live TV, movies and series')),
    vod_hours: h('input', { type: 'number', min: 0, step: 1, value: src ? src.vod_refresh_minutes / 60 : 24 }),
    enabled: h('input', { type: 'checkbox', checked: src ? src.enabled : true }),
    max_streams: h('input', {
      type: 'number', min: 0, value: src?.max_streams ?? '',
      placeholder: src?.streams?.auto ? `Automatic: ${src.streams.auto}` : 'Automatic',
    }),
  };
  f.epg_urls.value = v(src?.epg_urls);

  const m3uPart = h('div', null,
    field('Playlist URL', f.url, src?.url?.startsWith('upload:') ? 'Currently using an uploaded file. Enter a URL to switch back.' : 'Or upload a file below.'),
    field('…or upload a playlist file', f.file));
  const xcPart = h('div', null,
    field('Server URL', f.xc_host, 'The address your provider gave you, including the port.'),
    h('div', { class: 'two' }, field('Username', f.xc_username), field('Password', f.xc_password)),
    field('Stream format', f.xc_stream_ext));
  const hdhrPart = h('div', null,
    field('HDHomeRun address', f.hdhr_host,
      'The tuner\'s IP address on your network, e.g. 192.168.1.100. Give it a DHCP reservation so it doesn\'t change. "hdhomerun.local" usually does not work from inside Docker.'),
    h('p', { class: 'hint' },
      'Channels come from the box\'s lineup, so run a channel scan on it first. The guide comes from SiliconDust\'s guide service using the box\'s own authorization; no account needed.'));
  const typeSwitch = isNew ? h('div', { class: 'segmented' },
    [['m3u', 'M3U playlist'], ['xc', 'Xtream Codes'], ['hdhr', 'HDHomeRun']].map(([t, label]) => h('button', {
      type: 'button',
      class: type === t ? 'on' : '',
      onclick: (e) => {
        type = t;
        e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target));
        sync();
      },
    }, label))) : null;
  const contentPart = field('Content', f.content,
    'Movies and series reach players through an output\'s Xtream Codes login, once the output includes them. Large catalogs take a minute to load.');
  const vodHoursPart = field('Refresh movies & series every (hours)', f.vod_hours,
    'Catalogs are large and change slowly. 0 = only when you click Refresh.');
  const epgHint = h('p', { class: 'hint' });
  const sync = () => {
    m3uPart.hidden = type !== 'm3u';
    xcPart.hidden = type !== 'xc';
    hdhrPart.hidden = type !== 'hdhr';
    contentPart.hidden = type === 'hdhr';
    vodHoursPart.hidden = type !== 'xc';
    epgHint.textContent = {
      xc: 'The provider\'s own guide (xmltv.php) is used automatically. Add extra XMLTV URLs here to fill gaps.',
      hdhr: 'The HDHomeRun guide is fetched automatically. Add extra XMLTV URLs here to fill gaps.',
      m3u: 'Leave empty to use the guide named in the playlist header (url-tvg). Otherwise list XMLTV URLs (plain or .gz).',
    }[type];
  };
  sync();

  const body = h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
    typeSwitch,
    field('Name', f.name),
    m3uPart, xcPart, hdhrPart, contentPart,
    h('details', { open: !!src?.epg_urls },
      h('summary', null, 'Guide (EPG)'),
      epgHint,
      field('Extra EPG URLs', f.epg_urls),
      field('…or upload an XMLTV file', f.epg_file)),
    h('details', null,
      h('summary', null, 'Advanced'),
      field('Refresh every (hours)', f.hours, '0 = only when you click Refresh.'),
      vodHoursPart,
      field('User agent', f.user_agent, 'Sent to the provider for playlists, guides and proxied streams.'),
      field('Streams at once', f.max_streams,
        'For outputs set to Proxy: how many channels from this source can play at the same time. People watching the same channel share one ' +
        'stream. Blank uses the Xtream Codes account\'s connection limit or the HDHomeRun\'s tuner count; 0 means no limit. ' +
        'Direct and Redirect outputs can\'t be limited: players connect to the provider themselves.'),
      h('label', { class: 'check' }, f.enabled, ' Enabled')),
    h('button', { type: 'submit', hidden: true }));

  const save = async () => {
    const payload = {
      name: f.name.value, type, url: f.url.value || (src?.url?.startsWith('upload:') ? src.url : ''),
      epg_urls: f.epg_urls.value, xc_host: f.xc_host.value, xc_username: f.xc_username.value, xc_password: f.xc_password.value,
      xc_stream_ext: f.xc_stream_ext.value, hdhr_host: f.hdhr_host.value, user_agent: f.user_agent.value,
      refresh_minutes: Math.round(Number(f.hours.value || 0) * 60), live_only: f.content.value === 'live', enabled: f.enabled.checked,
      vod_refresh_minutes: Math.round(Number(f.vod_hours.value || 0) * 60),
      max_streams: f.max_streams.value,
    };
    if (type === 'm3u' && !payload.url && !f.file.files[0]) return toast('Enter a playlist URL or choose a file', 'error');
    const saved = await attempt(() => (isNew ? api('POST', '/api/sources', payload) : api('PUT', `/api/sources/${src.id}`, payload)));
    if (f.file.files[0]) await attempt(() => api('POST', `/api/sources/${saved.id}/upload?kind=m3u`, f.file.files[0], true));
    if (f.epg_file.files[0]) await attempt(() => api('POST', `/api/sources/${saved.id}/upload?kind=epg`, f.epg_file.files[0], true));
    close();
    toast(isNew ? 'Source added; first refresh started' : 'Source saved');
    onSaved();
  };
  const close = modal(isNew ? 'Add source' : `Edit ${src.name}`, body, [
    h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: save }, isNew ? 'Add and refresh' : 'Save'),
  ]);
}

async function sourceDetail(main, id) {
  let src = await api('GET', `/api/sources/${id}`);
  let cats = await api('GET', `/api/sources/${id}/categories`);
  const state = { category: null, q: '', epg: '', offset: 0 };
  const list = h('div', { class: 'card flush' });
  const catList = h('div', { class: 'cat-list' });
  const catSearch = h('input', { type: 'search', placeholder: 'Filter categories', oninput: () => drawCats() });

  const drawCats = () => {
    const q = catSearch.value.toLowerCase();
    fill(catList, 
      h('button', { class: `cat-item ${state.category == null ? 'on' : ''}`, onclick: () => pick(null) }, h('span', null, 'All channels'), h('span', { class: 'count' }, src.counts.channels)),
      cats.filter((c) => !q || (c.custom_name || c.name).toLowerCase().includes(q)).map((c) =>
        h('button', { class: `cat-item ${state.category === c.id ? 'on' : ''}`, onclick: () => pick(c.id), title: c.name },
          h('span', null, c.custom_name || c.name, c.is_new ? badge('new', 'info') : null, jellyfinBadges(c)),
          h('span', { class: 'count' }, c.channel_count))));
  };
  const pick = (cid) => {
    state.category = cid;
    state.offset = 0;
    drawCats();
    load();
  };

  const load = async () => {
    const qs = new URLSearchParams({ limit: 100, offset: state.offset });
    if (state.category) qs.set('category_id', state.category);
    if (state.q) qs.set('q', state.q);
    if (state.epg) qs.set('epg', state.epg);
    const data = await api('GET', `/api/sources/${id}/channels?${qs}`);
    const cat = cats.find((c) => c.id === state.category);
    fill(list, 
      cat ? h('div', { class: 'list-head' }, h('b', null, cat.custom_name || cat.name),
        cat.custom_name ? h('span', { class: 'meta' }, ` (provider name: ${cat.name})`) : null,
        jellyfinBadges(cat),
        h('button', { class: 'btn small', onclick: () => editCategory(cat, () => { drawCats(); load(); }) }, 'Edit group')) : null,
      h('table', { class: 'table stack ch-table' },
        h('thead', null, h('tr', null, ['', 'Channel', 'Category', 'tvg-id', 'Guide', ''].map((t) => h('th', null, t)))),
        h('tbody', null, data.items.map((ch) => h('tr', null,
          h('td', { class: 'logo-cell' }, (ch.custom_logo || ch.logo) ? h('img', { src: ch.custom_logo || ch.logo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null),
          h('td', null, h('span', { class: 'strong' }, ch.custom_name || ch.name), ch.custom_name ? h('div', { class: 'meta' }, ch.name) : null),
          h('td', { class: 'meta', 'data-label': 'Category' }, ch.category),
          h('td', { class: 'mono tvg' }, ch.tvg_id || '–'),
          h('td', { 'data-label': 'Guide' }, epgBadge(ch), ch.epg_id ? h('div', { class: 'meta mono' }, ch.custom_epg_id || ch.epg_id) : null),
          h('td', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => editChannel(src, ch, load) }, 'Edit')))))),
      data.items.length ? null : h('p', { class: 'empty pad' }, 'No channels match.'),
      h('div', { class: 'pager' },
        h('span', { class: 'meta' }, data.total ? `${state.offset + 1}–${state.offset + data.items.length} of ${data.total}` : ''),
        h('button', { class: 'btn small', disabled: state.offset === 0, onclick: () => { state.offset -= 100; load(); } }, '‹ Prev'),
        h('button', { class: 'btn small', disabled: state.offset + 100 >= data.total, onclick: () => { state.offset += 100; load(); } }, 'Next ›')));
  };

  let t;
  const search = h('input', { type: 'search', placeholder: 'Search channels or tvg-id', oninput: (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; state.offset = 0; load(); }, 250); } });
  const epgFilter = h('select', { onchange: (e) => { state.epg = e.target.value; state.offset = 0; load(); } },
    h('option', { value: '' }, 'All guide states'), h('option', { value: 'matched' }, 'Has guide'), h('option', { value: 'unmatched' }, 'No guide'));

  // Header, stats and error banner are redrawn in place; lists only reload after a refresh finishes.
  const head = h('div', { class: 'page-head' });
  const statsBox = h('div');
  let headSig = '';
  const drawHead = () => {
    const sig = JSON.stringify(src) + minuteTick();
    if (sig === headSig) return;
    headSig = sig;
    const st = src.stats || {};
    fill(head,
      h('div', null, h('a', { href: '#/sources', class: 'crumb' }, '‹ Sources'), h('h1', null, src.name)),
      h('div', { class: 'row' }, statusBadge(src),
        h('button', { class: 'btn', onclick: () => sourceForm(src, refreshSource) }, 'Edit source'),
        h('button', { class: 'btn primary', disabled: !!src.job, onclick: () => attempt(() => api('POST', `/api/sources/${id}/refresh`), 'Refresh started').then(refreshSource) }, 'Refresh now')));
    fill(statsBox,
      h('div', { class: 'stats wide card' },
        stat(src.counts.channels, 'channels'), stat(src.counts.categories, 'categories'),
        stat(src.counts.epg_matched, 'with guide'),
        src.counts.movies || src.counts.series ? stat(src.counts.movies.toLocaleString(), 'movies') : null,
        src.counts.movies || src.counts.series ? stat(src.counts.series.toLocaleString(), 'series') : null,
        !src.live_only && src.vod_refreshed_at ? stat(ago(src.vod_refreshed_at), 'movies & series loaded') : null,
        stat(st.epg?.programmes ?? '–', 'programs'),
        stat(ago(src.last_refresh_at), 'last refresh'),
        src.account_info?.exp_date ? stat(new Date(Number(src.account_info.exp_date) * 1000).toLocaleDateString(), 'account expires') : null,
        src.account_info?.max_connections ? stat(src.account_info.max_connections, 'max connections') : null,
        src.account_info?.model ? stat(src.account_info.model, 'model') : null,
        src.account_info?.tuners ? stat(src.account_info.tuners, 'tuners') : null,
        src.streams?.limit || src.streams?.open
          ? stat(`${src.streams.open}${src.streams.limit ? ` of ${src.streams.limit}` : ''}`, 'streams in use') : null,
        st.epg?.hdhr ? h('div', { class: 'stat' }, h('span', null, `Guide: ${st.epg.hdhr}`)) : null),
      src.last_error ? h('div', { class: `card ${src.last_status === 'error' ? 'error-card' : 'warn-card'}` }, src.last_error) : null,
      src.streams?.refused ? h('p', { class: 'note warn', title: 'Proxied streams only. The log has every refusal.' },
        `Last stream the provider turned down: ${src.streams.refused.what}, ${src.streams.refused.reason.replace(/^the provider /, '')} (${ago(src.streams.refused.at)}).`) : null);
  };
  const refreshSource = async () => {
    const wasBusy = !!src.job;
    src = await api('GET', `/api/sources/${id}`);
    drawHead();
    if (wasBusy && !src.job) {
      cats = await api('GET', `/api/sources/${id}/categories`);
      drawCats();
      await load();
    }
  };

  drawHead();
  fill(main, head, statsBox,
    h('div', { class: 'split' },
      h('aside', { class: 'card flush side' }, h('div', { class: 'pad' }, catSearch), catList),
      h('div', null, h('div', { class: 'toolbar' }, search, epgFilter), list)));
  drawCats();
  await load();
  poll(refreshSource, 3000);
}

const JELLYFIN_CATEGORIES = [
  ['Movie', 'Movies'],
  ['Sports', 'Sports'],
  ['News', 'News'],
  ['Kids', 'Kids'],
];

function jellyfinBadges(cat) {
  return (cat.jellyfin || []).map((j) => badge(`Jellyfin: ${j}`, 'jf'));
}

/** Group-level settings shared by every channel in it: display name and Jellyfin guide categories. */
// vod: a movie or series category, which has a display name but no guide (so no Jellyfin tags).
function editCategory(cat, onSaved, { vod = false } = {}) {
  const name = h('input', { value: cat.custom_name || '', placeholder: cat.name });
  const boxes = JELLYFIN_CATEGORIES.map(([value, label]) => {
    const box = h('input', { type: 'checkbox', value, checked: (cat.jellyfin || []).includes(value) });
    return h('label', { class: 'check' }, box, ` ${label}`);
  });
  const close = modal(`${vod ? 'Rename category' : 'Edit group'}: ${cat.custom_name || cat.name}`, h('div', { class: 'form' },
    field('Display name in outputs', name, 'Leave empty to use the provider\'s name. Filter rules still match the provider\'s name.'),
    vod ? null : h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Jellyfin category'),
      h('span', { class: 'hint' },
        `Tags every program on all ${cat.channel_count ?? ''} channels in this group, so Jellyfin lists them under Movies, Sports, News or Kids. `,
        'This only applies to channels that have guide data.'),
      h('div', { class: 'row' }, boxes))), [
    h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        const jellyfin = boxes.map((l) => l.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
        const r = await attempt(() => api('PUT', `/api/categories/${cat.id}`, vod ? { custom_name: name.value } : { custom_name: name.value, jellyfin }),
          vod ? 'Category renamed' : 'Group saved');
        cat.custom_name = r.custom_name;
        cat.jellyfin = r.jellyfin;
        close();
        onSaved?.();
      },
    }, 'Save'),
  ]);
}

// A movie's or series' own display name, in every output.
function renameTitle(t, onSaved) {
  const name = h('input', { value: t.custom_name || '', placeholder: t.name });
  const close = modal(`Rename: ${t.custom_name || t.name}`, h('div', { class: 'form' },
    field('Display name', name, 'Leave empty to use the provider\'s name. It wins over name cleanup, in every output.')), [
    h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        await attempt(() => api('PUT', `/api/vod/${t.id}`, { custom_name: name.value }), 'Renamed');
        close();
        onSaved?.();
      },
    }, 'Save'),
  ]);
}

function epgBadge(ch) {
  if (!ch.epg_id) return badge('none', 'muted');
  return badge({ 'tvg-id': 'by tvg-id', name: 'by name', manual: 'manual' }[ch.epg_match] || ch.epg_match, ch.epg_match === 'manual' ? 'info' : 'ok');
}

function editChannel(src, ch, reload) {
  const f = {
    name: h('input', { value: ch.custom_name || '', placeholder: ch.name }),
    logo: h('input', { value: ch.custom_logo || '', placeholder: ch.logo || 'https://…/logo.png' }),
    chno: h('input', { value: ch.custom_chno || '', placeholder: ch.chno || '' }),
    epg: h('input', { value: ch.custom_epg_id || '', placeholder: ch.epg_id ? `${ch.epg_id} (automatic)` : 'Search the guide below' }),
  };
  const results = h('div', { class: 'epg-results' });
  let t;
  const search = h('input', {
    type: 'search',
    placeholder: `Search ${src.name}'s guide by name or id`,
    oninput: (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const rows = await api('GET', `/api/sources/${src.id}/epg-channels?q=${encodeURIComponent(e.target.value)}`);
        fill(results, ...rows.map((r) => h('button', {
          type: 'button',
          class: 'epg-hit',
          onclick: () => { f.epg.value = r.id; },
        }, h('span', { class: 'mono' }, r.id), h('span', { class: 'meta' }, r.names.join(' · ')))),
        rows.length ? '' : h('p', { class: 'meta' }, 'No matches.'));
      }, 250);
    },
  });
  const close = modal(`Edit ${ch.custom_name || ch.name}`, h('div', { class: 'form' },
    h('p', { class: 'hint' }, 'Blank fields keep the provider\'s values. Edits apply to every output and survive refreshes.'),
    field('Display name', f.name),
    field('Logo URL', f.logo),
    field('Channel number', f.chno, 'Ignored by outputs that renumber channels.'),
    field('Guide channel id', f.epg, `Current: ${ch.epg_id ? `${ch.epg_id} (${ch.epg_match})` : 'no guide'}. Leave empty for automatic matching.`),
    search, results), [
    h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        await attempt(() => api('PUT', `/api/channels/${ch.id}`, {
          custom_name: f.name.value, custom_logo: f.logo.value, custom_chno: f.chno.value, custom_epg_id: f.epg.value,
        }), 'Channel saved');
        close();
        reload();
      },
    }, 'Save'),
  ]);
}

// ---------------------------------------------------------------- outputs --

async function outputsView(main) {
  const outputs = await api('GET', '/api/outputs');
  fill(main, 
    h('div', { class: 'page-head' }, h('h1', null, 'Outputs'), h('button', { class: 'btn primary', onclick: newOutput }, '+ New output')),
    h('p', { class: 'lead' }, 'Each output is its own trimmed playlist and guide with its own URLs, so you can publish a different lineup for each room, person or app.'),
    outputs.length ? h('div', { class: 'grid' }, outputs.map(outputCard))
      : h('div', { class: 'card empty' }, h('p', null, 'No outputs yet.')));
}

function newOutput() {
  const name = h('input', { placeholder: 'Living room', required: true });
  const close = modal('New output', h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); create(); } },
    field('Name', name, 'All current sources are attached; you can change that next.')), [
    h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: () => create() }, 'Create'),
  ]);
  const create = async () => {
    const o = await attempt(() => api('POST', '/api/outputs', { name: name.value || 'New output' }));
    close();
    location.hash = `#/outputs/${o.id}`;
  };
}

// On narrow screens the output page shows one column at a time; which one is remembered while
// moving between outputs.
let outputPane = 'main';

// "Hide excluded" on the output page's category lists (categories only): remembered in this browser.
let hideExcluded = (() => {
  try {
    return localStorage.getItem('iptvm.hideExcluded') === '1';
  } catch {
    return false;
  }
})();

async function outputEditor(main, id) {
  let o = await api('GET', `/api/outputs/${id}`);
  let cats = await api('GET', `/api/outputs/${id}/categories`);
  const settings = await api('GET', '/api/settings');
  const lightStatus = await api('GET', '/api/light');
  const draft = {
    name: o.name,
    stream_mode: o.stream_mode,
    number_start: o.number_start ?? '',
    epg_days: o.epg_days,
    include_all: o.include_all,
    include_all_movie: o.include_all_movie,
    include_all_series: o.include_all_series,
    xc_enabled: o.xc_enabled,
    xc_username: o.xc_username || '',
    xc_password: o.xc_password || '',
    sources: o.sources.map((s) => ({ ...s })),
    // Category rules per kind: live TV here, movies and series in vod_rules.
    rules: o.rules.filter((r) => r.kind === 'live').map((r) => ({ ...r })),
    vod_rules: { movie: o.rules.filter((r) => r.kind === 'movie').map((r) => ({ ...r })), series: o.rules.filter((r) => r.kind === 'series').map((r) => ({ ...r })) },
    vod_enabled: o.vod_enabled,
    light_enabled: o.light_enabled,
    convert_mode: o.convert_mode || 'off',
    name_rules: o.name_rules.map((r) => ({ ...r })),
  };
  let dirty = false;
  let redrawVod = () => {};
  // hits: channels matching the search (from the server), per category, for hitsQ.
  const view = { q: '', show: 'all', open: new Set(), hits: new Map(), hitsQ: '', hitTotal: 0 };
  const saveBar = h('div', { class: 'savebar', hidden: true },
    h('span', null, 'Unsaved changes. The category list below already shows their effect.'),
    h('button', { class: 'btn', onclick: () => route() }, 'Discard'),
    h('button', { class: 'btn primary', onclick: () => save() }, 'Save changes'));
  const markDirty = () => {
    dirty = true;
    saveBar.hidden = false;
    drawCats();
    redrawVod();
  };
  const onLeave = (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onLeave);
  cleanups.push(() => window.removeEventListener('beforeunload', onLeave));

  const sourceName = (sid) => o.sources.find((s) => s.id === sid)?.name || `#${sid}`;
  // One switch for all three category lists (Live TV, Movies, Series). Inside an expanded category,
  // a switch of its own hides that category's excluded channels or titles.
  const hideBoxes = [];
  const setHideExcluded = (on) => {
    hideExcluded = on;
    try {
      localStorage.setItem('iptvm.hideExcluded', on ? '1' : '0');
    } catch {}
    for (const b of hideBoxes) b.checked = on;
    drawCats();
    redrawVod();
  };
  const hideToggle = () => {
    const box = h('input', { type: 'checkbox', checked: hideExcluded, onchange: (e) => setHideExcluded(e.target.checked) });
    hideBoxes.push(box);
    return h('label', { class: 'check hide-excluded', title: 'Show only the categories that are in the output' },
      box, ' Hide excluded');
  };
  const attachedIds = () => draft.sources.filter((s) => s.attached).map((s) => s.id);
  // Text around the names of a source's categories in this output ("UK | News"), set from its
  // row under Sources or its heading in a category list, and saved with the output.
  const affixed = (src, name) => [src.cat_prefix.trim(), name, src.cat_suffix.trim()].filter(Boolean).join(' ');
  const affixNote = (src) => (src.cat_prefix.trim() || src.cat_suffix.trim() ? ` · shown as ${affixed(src, '…')}` : '');
  const editAffix = (src) => {
    const sample = cats.find((c) => c.source_id === src.id);
    const name = sample ? sample.custom_name || sample.name : 'News';
    const pre = h('input', { value: src.cat_prefix, maxlength: 40, placeholder: 'e.g. UK |' });
    const suf = h('input', { value: src.cat_suffix, maxlength: 40, placeholder: 'e.g. [Provider A]' });
    const example = h('span', { class: 'hint' });
    const show = () => { example.textContent = `Example: ${affixed({ cat_prefix: pre.value, cat_suffix: suf.value }, name)}`; };
    pre.oninput = show;
    suf.oninput = show;
    show();
    const close = modal(`Category names: ${src.name}`, h('div', { class: 'form' },
      h('p', { class: 'hint' }, `Added before and after the name of every ${src.name} category in this output (live TV, movies and series), with a space between. Filter rules still match the provider's names.`),
      h('div', { class: 'two' }, field('Prefix', pre), field('Suffix', suf)),
      example), [
      h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          src.cat_prefix = pre.value.trim();
          src.cat_suffix = suf.value.trim();
          close();
          markDirty();
          drawSources();
          drawCats();
          redrawVod();
        },
      }, 'Done'),
    ]);
  };
  // Category rows, under a heading per provider when the output has more than one source, even if
  // only one of them has rows here (say, the only one with movies). Rows come in source order, so
  // each provider's categories are together.
  const withGroups = (rows, render) => {
    const counts = new Map();
    for (const c of rows) counts.set(c.source_id, (counts.get(c.source_id) || 0) + 1);
    if (attachedIds().length < 2) return rows.map(render);
    const out = [];
    let last = null;
    for (const c of rows) {
      if (c.source_id !== last) {
        last = c.source_id;
        const n = counts.get(c.source_id);
        const src = draft.sources.find((x) => x.id === c.source_id);
        out.push(h('div', { class: 'cat-group' },
          h('span', null, h('b', null, sourceName(c.source_id)), h('span', { class: 'meta' }, ` · ${n} categor${n === 1 ? 'y' : 'ies'}${src ? affixNote(src) : ''}`)),
          src ? h('button', { class: 'icon-btn', title: 'Category name prefix and suffix', onclick: () => editAffix(src) }, '✎') : null));
      }
      out.push(render(c));
    }
    return out;
  };

  // --- settings
  const inp = (key, props = {}) => h('input', { ...props, value: draft[key], oninput: (e) => { draft[key] = props.type === 'checkbox' ? e.target.checked : e.target.value; markDirty(); } });
  const modeInfo = {
    direct: 'The playlist holds the provider\'s own stream URLs. Nothing passes through this server. For Xtream Codes clients, this behaves like Redirect.',
    redirect: 'The playlist points at this server, which answers with a redirect to the provider. It uses no bandwidth, and URLs stay stable if the provider changes them.',
    proxy: 'This server relays the video. Provider credentials never reach the client, but every stream uses this server\'s bandwidth.',
  };
  const modeHint = h('span', { class: 'hint' }, modeInfo[draft.stream_mode]);
  const mode = h('select', { onchange: (e) => { draft.stream_mode = e.target.value; modeHint.textContent = modeInfo[draft.stream_mode]; markDirty(); } },
    ['direct', 'redirect', 'proxy'].map((m) => h('option', { value: m, selected: draft.stream_mode === m }, m[0].toUpperCase() + m.slice(1))));
  const xcBox = h('div', { class: 'two' }, field('XC username', inp('xc_username', { autocomplete: 'off' })), field('XC password', inp('xc_password', { autocomplete: 'off' })));
  xcBox.hidden = !draft.xc_enabled;
  const xcToggle = h('input', { type: 'checkbox', checked: draft.xc_enabled, onchange: (e) => { draft.xc_enabled = e.target.checked; xcBox.hidden = !e.target.checked; if (e.target.checked && !draft.xc_username) { draft.xc_username = o.name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'user'; draft.xc_password = Math.random().toString(36).slice(2, 10); xcBox.querySelectorAll('input')[0].value = draft.xc_username; xcBox.querySelectorAll('input')[1].value = draft.xc_password; } markDirty(); } });

  const settingsCard = h('section', { class: 'card' },
    h('h2', null, 'Settings'),
    h('div', { class: 'form' },
      field('Name', inp('name')),
      field('Stream delivery', mode, null), modeHint,
      h('div', { class: 'two' },
        field('Renumber channels from', inp('number_start', { type: 'number', min: 0, placeholder: 'Keep provider numbers' })),
        field('Guide days', inp('epg_days', { type: 'number', min: 1, max: 14 }))),
      h('label', { class: 'check' }, xcToggle, ' Also publish as an Xtream Codes login'),
      xcBox,
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: draft.vod_enabled, onchange: (e) => { draft.vod_enabled = e.target.checked; markDirty(); } }),
        ' Include movies & series'),
      h('span', { class: 'hint' }, 'Players see them through the Xtream Codes login. Pick them on the Movies and Series tabs.'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: draft.light_enabled, onchange: (e) => { draft.light_enabled = e.target.checked; markDirty(); } }),
        ' Light copies for multi-view (TileIPTV)'),
      h('span', { class: 'hint' },
        'Adds a tileiptv-light link to each channel in the M3U playlist: a 720p copy this server makes with ffmpeg while it is watched. Other players ignore it. ',
        lightStatus.ffmpeg ? 'Encoder and limits are under ' : null,
        lightStatus.ffmpeg ? h('a', { href: '#/settings' }, 'Settings') : h('b', { class: 'warn-text' }, 'ffmpeg is not installed on this server, so the links won\'t play yet (see Settings).'),
        lightStatus.ffmpeg ? '.' : null),
      field('Convert for playback', h('select', { onchange: (e) => { draft.convert_mode = e.target.value; markDirty(); } },
        [['off', 'Off: streams as the provider sends them'],
          ['needed', 'Only channels that need it (MPEG-2 video, Dolby or MPEG sound)'],
          ['always', 'Always: every channel']].map(([v, l]) => h('option', { value: v, selected: draft.convert_mode === v }, l))),
      [
        'Channels in codecs that don\'t play everywhere go out as H.264 video with AAC sound, made once on this server (ffmpeg): ready for browsers, phones and recorders such as Tvheadend or Jellyfin, with nothing to transcode later. ',
        'Other channels pass through unchanged. This output\'s streams then go through this server, as with Proxy. ',
        lightStatus.ffmpeg ? null : h('b', { class: 'warn-text' }, 'ffmpeg is not installed on this server, so nothing is converted yet.'),
      ])));

  // --- sources
  const sourcesBox = h('div', { class: 'source-list' });
  const drawSources = () => {
    fill(sourcesBox, ...draft.sources.map((s, i) => h('div', { class: 'source-row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.attached, onchange: (e) => { s.attached = e.target.checked; markDirty(); drawSources(); } }), ' ', s.name, ' ',
        h('span', { class: 'meta' }, TYPE_LABELS[s.type], s.attached ? affixNote(s) : '')),
      h('span', { class: 'row' },
        s.attached ? h('button', { class: 'icon-btn', title: 'Category name prefix and suffix', onclick: () => editAffix(s) }, '✎') : null,
        h('button', { class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => { [draft.sources[i - 1], draft.sources[i]] = [draft.sources[i], draft.sources[i - 1]]; drawSources(); markDirty(); } }, '↑'),
        h('button', { class: 'icon-btn', title: 'Move down', disabled: i === draft.sources.length - 1, onclick: () => { [draft.sources[i + 1], draft.sources[i]] = [draft.sources[i], draft.sources[i + 1]]; drawSources(); markDirty(); } }, '↓')))),
    draft.sources.length ? '' : h('p', { class: 'meta' }, 'No sources exist yet.'));
  };
  drawSources();
  const sourcesCard = h('section', { class: 'card' }, h('h2', null, 'Sources'), h('p', { class: 'hint' }, 'Channels are listed in this source order. Save to load categories from newly attached sources. ✎ adds a prefix or suffix to a source\'s category names.'), sourcesBox);

  // --- rules: one editor per kind of category (live TV, movies, series)
  const rulesEditor = (list, placeholder) => {
    const box = h('div', { class: 'rules' });
    const draw = () => {
      fill(box, ruleGroups({
        rules: list(),
        subject: 'categories',
        newRule: (action) => ({ action, op: action === 'include' ? 'starts_with' : 'contains', value: '', source_id: null }),
        commit: () => { draw(); markDirty(); },
        onAdd: () => draw(),
        fields: (r) => [
          h('span', { class: 'meta' }, 'from'),
          h('select', { onchange: (e) => { r.source_id = e.target.value ? Number(e.target.value) : null; markDirty(); } },
            h('option', { value: '' }, 'any source'),
            draft.sources.filter((src) => src.attached || src.id === r.source_id).map((src) => h('option', { value: src.id, selected: r.source_id === src.id }, src.name))),
          h('span', { class: 'meta' }, 'whose name'),
          h('select', { onchange: (e) => { r.op = e.target.value; markDirty(); } },
            Object.entries(OP_LABELS).map(([k, l]) => h('option', { value: k, selected: r.op === k }, l))),
          h('input', { value: r.value, placeholder, oninput: (e) => { r.value = e.target.value; markDirty(); } }),
        ],
      }));
    };
    draw();
    return { box, draw };
  };
  const liveRules = rulesEditor(() => draft.rules, 'e.g. US|');
  const rulesBox = liveRules.box;
  const includeAll = h('input', { type: 'checkbox', checked: draft.include_all, onchange: (e) => { draft.include_all = e.target.checked; markDirty(); } });
  const rulesCard = foldCard('rules', 'Filter rules', () => ruleCount(draft.rules),
    h('p', { class: 'hint' }, 'Rules run against the provider\'s category names on every refresh, so new categories that match are added automatically. ',
      'A category is kept when it matches any Include rule and no Exclude rule. Picking a category by hand below always wins. ',
      'Drag rules (⠿) to arrange them; the order is only for your own organization.'),
    rulesBox,
    h('label', { class: 'check' }, includeAll, ' When a source has no Include rules, include all of its categories'));

  // --- name cleanup (an advanced option; hidden otherwise)
  const NAME_PRESETS = [
    ['Country prefix', 'Removes "US| ", "UK: " or "CA - " at the start of a name',
      { scope: 'channel', find: '^\\|?[A-Z]{2,3}\\s*[|:\\-]\\s*', replace: '' }],
    ['Quality tags', 'Removes HD, FHD, UHD, 4K, HEVC, [SD], ᴴᴰ and similar',
      { scope: 'channel', find: '\\s*(?:[\\[(](?:UHD|FHD|HD|SD|4K|HEVC)[\\])]|\\b(?:UHD|FHD|HD|4K|HEVC|H\\.?26[45]|\\d{2,3}FPS)\\b|ᵁᴴᴰ|ᶠᴴᴰ|ᴴᴰ|ᴿᴬᵂ|⁶⁰ᶠᵖˢ|ˢᴰ)', replace: '' }],
  ];
  const namesBox = h('div', { class: 'name-rules' });
  const namePreview = h('div', { class: 'name-preview' });
  let previewTimer = null;
  let previewSeq = 0;
  const previewNames = () => {
    clearTimeout(previewTimer);
    const rules = draft.name_rules.filter((r) => r.find !== '');
    if (!rules.length) {
      fill(namePreview, h('span', { class: 'meta' }, 'No rules. Names are used as the provider sends them.'));
      return;
    }
    previewTimer = setTimeout(async () => {
      const seq = ++previewSeq;
      let r;
      try {
        r = await api('POST', `/api/outputs/${id}/name-preview`, { rules });
      } catch (e) {
        if (seq === previewSeq) fill(namePreview, h('span', { class: 'error-text' }, e.message));
        return;
      }
      if (seq !== previewSeq) return;
      const part = (label, t) => (t.total ? `${t.changed} of ${t.total} ${label}` : null);
      const counts = [part('channel names', r.channels), part('category names', r.categories)].filter(Boolean).join(' and ');
      const vodCounts = r.vod ? [part('movie & series titles', r.vod.titles), part('movie & series categories', r.vod.categories)].filter(Boolean).join(' and ') : '';
      const all = [counts, vodCounts].filter(Boolean).join('; ');
      const sample = ([a, b]) => h('div', { class: 'name-sample' }, h('span', { class: 'before' }, a), h('span', { class: 'meta' }, '→'), h('b', null, b));
      fill(namePreview,
        h('span', { class: 'meta' }, all ? `Changes ${all} in this output${dirty ? ' (after saving)' : ''}.` : 'No categories are in this output yet.'),
        [...r.categories.samples.slice(0, 3), ...r.channels.samples].slice(0, r.vod ? 5 : 8).map(sample),
        r.vod ? [...r.vod.categories.samples.slice(0, 2), ...r.vod.titles.samples].slice(0, 4).map(sample) : null);
    }, 300);
  };
  const changedNames = () => {
    markDirty();
    previewNames();
  };
  const drawNames = () => {
    const move = (i, d) => {
      [draft.name_rules[i], draft.name_rules[i + d]] = [draft.name_rules[i + d], draft.name_rules[i]];
      drawNames();
      changedNames();
    };
    const add = (rule) => {
      draft.name_rules.push({ ...rule });
      drawNames();
      changedNames();
      if (!rule.find) namesBox.querySelectorAll('.name-rule')[draft.name_rules.length - 1]?.querySelector('input')?.focus();
    };
    fill(namesBox,
      draft.name_rules.map((r, i) => h('div', { class: 'name-rule' },
        h('span', { class: 'name-targets' },
          draft.vod_enabled || (r.media || 'live') !== 'live'
            ? h('select', { title: 'Where this rule applies', onchange: (e) => { r.media = e.target.value; changedNames(); } },
              [['live', 'Live TV'], ['vod', 'Movies & series'], ['all', 'Everywhere']].map(([v, l]) => h('option', { value: v, selected: (r.media || 'live') === v }, l)))
            : null,
          h('select', { onchange: (e) => { r.scope = e.target.value; changedNames(); } },
            [['channel', draft.vod_enabled ? 'Names & titles' : 'Channel names'], ['category', 'Category names'], ['both', 'Both']]
              .map(([v, l]) => h('option', { value: v, selected: r.scope === v }, l)))),
        h('input', { class: 'mono', value: r.find, placeholder: 'Find (pattern)', spellcheck: 'false', oninput: (e) => { r.find = e.target.value; changedNames(); } }),
        h('span', { class: 'meta' }, '→'),
        h('input', { value: r.replace, placeholder: 'Replace with (empty removes)', oninput: (e) => { r.replace = e.target.value; changedNames(); } }),
        h('span', { class: 'row' },
          h('button', { class: 'icon-btn', title: 'Move up (rules run top to bottom)', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          h('button', { class: 'icon-btn', title: 'Move down', disabled: i === draft.name_rules.length - 1, onclick: () => move(i, 1) }, '↓'),
          h('button', { class: 'icon-btn', title: 'Remove', onclick: () => { draft.name_rules.splice(i, 1); drawNames(); changedNames(); } }, '✕')))),
      h('div', { class: 'row' },
        NAME_PRESETS.map(([label, title, rule]) => h('button', {
          class: 'btn small', title, disabled: draft.name_rules.some((r) => r.find === rule.find), onclick: () => add({ ...rule, media: draft.vod_enabled ? 'all' : 'live' }),
        }, `+ ${label}`)),
        h('button', { class: 'btn small', onclick: () => add({ scope: 'channel', media: draft.vod_enabled ? 'all' : 'live', find: '', replace: '' }) }, '+ Custom rule')));
  };
  const nameCount = o.name_rules.length;
  const namesCard = settings.advanced
    ? foldCard('names', 'Name cleanup', () => ruleCount(draft.name_rules),
      h('p', { class: 'hint' },
        'Tidy the names players show, like "US: Daily News ᴴᴰ" into "Daily News". Each rule\'s pattern is a regular expression (case-sensitive) ',
        'and every match is replaced; rules run top to bottom, then leftover spaces are tidied. Names you set by hand are never changed. ',
        'With movies & series on, each rule also says where it applies: live TV, movies & series, or everywhere.'),
      namesBox, namePreview)
    : nameCount
      ? h('p', { class: 'hint quiet-line' },
        `${nameCount} name cleanup rule${nameCount === 1 ? '' : 's'} tid${nameCount === 1 ? 'ies' : 'y'} the names in this output. To see or change them, turn on "Show advanced options" in `,
        h('a', { href: '#/settings' }, 'Settings'), '.')
      : null;
  if (settings.advanced) {
    drawNames();
    previewNames();
  }

  // --- categories
  const catBox = h('div', { class: 'cat-table' });
  const summary = h('span', { class: 'meta' });
  const evalCat = (c) => {
    const attached = attachedIds().includes(c.source_id);
    if (!attached) return { included: false, reason: 'detached' };
    return categoryState(c, draft.rules, c.override, draft.include_all);
  };
  const reasonText = (st) => {
    if (st.reason === 'manual') return 'picked by hand';
    if (st.reason === 'detached') return 'source not attached';
    if (st.reason === 'rule' && st.rule) return `${st.rule.action}: ${OP_LABELS[st.rule.op]} "${st.rule.value}"`;
    if (st.reason === 'nomatch') return 'no include rule matched';
    return st.included ? 'included by default' : 'not selected';
  };
  const visible = () => {
    const q = view.q.toLowerCase();
    return cats.filter((c) => {
      const st = evalCat(c);
      if (q && !(c.custom_name || c.name).toLowerCase().includes(q) && !c.name.toLowerCase().includes(q) && !channelHits(c).length) return false;
      if (hideExcluded && !st.included) return false;
      if (view.show === 'included') return st.included;
      if (view.show === 'excluded') return !st.included;
      if (view.show === 'new') return c.is_new;
      if (view.show === 'manual') return !!c.override;
      return true;
    });
  };
  const setOverride = async (ids, state) => {
    await attempt(() => api('PUT', `/api/outputs/${id}/categories`, { ids, state }));
    for (const c of cats) if (ids.includes(c.id)) c.override = state;
    drawCats();
    refreshCounts();
  };
  const drawCats = () => {
    const rows = visible();
    let inc = 0;
    let chans = 0;
    for (const c of cats) {
      const st = evalCat(c);
      if (st.included) {
        inc++;
        chans += c.channel_count;
      }
    }
    summary.textContent = `${inc} of ${cats.length} categories · about ${chans} channels${dirty ? ' (preview)' : ''}`;
    const LIMIT = 500;
    fill(catBox, 
      ...withGroups(rows.slice(0, LIMIT), (c) => {
        const st = evalCat(c);
        const seg = (label, val, cls) => h('button', { class: `${c.override === val ? 'on' : ''} ${cls}`, title: val ? `Always ${val}` : 'Follow the rules', onclick: () => setOverride([c.id], val) }, label);
        const row = h('div', { class: `cat-row ${st.included ? 'in' : 'out'}` },
          h('button', { class: 'expander', title: 'Show channels', onclick: () => { view.open.has(c.id) ? view.open.delete(c.id) : view.open.add(c.id); drawCats(); } }, view.open.has(c.id) ? '▾' : '▸'),
          h('span', { class: 'dot' }),
          h('span', { class: 'cat-name' }, shownName(c), c.is_new ? badge('new', 'info') : null, jellyfinBadges(c),
            c.channel_rules?.length ? badge(`${c.channel_rules.length} channel rule${c.channel_rules.length === 1 ? '' : 's'}`, 'info') : null,
            c.hide_empty ? badge('hides empty events', 'info') : null,
            c.hide_by_guide ? badge(c.hide_unlisted ? 'hides by guide + unlisted' : 'hides by guide', 'info') : null,
            h('span', { class: 'meta' }, ` · ${c.channel_count} ch · ${reasonText(st)}`),
            hitLine(c)),
          h('button', { class: 'icon-btn', title: 'Edit group (display name, Jellyfin category)', onclick: () => editCategory(c, drawCats) }, '✎'),
          h('span', { class: 'segmented small' }, seg('Auto', null, ''), seg('Include', 'include', 'inc'), seg('Exclude', 'exclude', 'exc')));
        if (!view.open.has(c.id)) return row;
        return h('div', null, row, channelPanel(c));
      }),
      rows.length > LIMIT ? h('p', { class: 'meta pad' }, `Showing the first ${LIMIT} of ${rows.length}. Use the search box to narrow the list.`) : null,
      rows.length ? null : h('p', { class: 'meta pad' }, 'No categories to show.'));
    fill(hitNote, view.hitTotal > 200 && view.hitsQ === view.q.trim().toLowerCase()
      ? `Showing channel matches for the first 200 of ${view.hitTotal} channels. Type more to narrow it down.` : '');
    for (const p of panels.values()) markHits(p.el);
  };

  // --- find a channel: matches across every category of this output, with their state
  const hitNote = h('p', { class: 'meta' });
  const channelHits = (c) => (view.hitsQ && view.hitsQ === view.q.trim().toLowerCase() && view.hits.get(c.id)) || [];
  const hitLine = (c) => {
    const hits = channelHits(c);
    if (!hits.length) return null;
    const MAX = 6;
    const open = () => {
      view.open.add(c.id);
      view.scrollTo = c.id;
      drawCats();
      scrollToHit(c.id);
    };
    return h('span', { class: 'ch-hits' },
      hits.slice(0, MAX).map((m) => h('button', {
        class: `hit-chip ${m.included ? 'in' : 'out'}`,
        title: `${m.included ? 'In the output' : 'Not in the output'}${m.reason === 'category' && !m.included ? ' (category not included)' : CH_REASONS[m.reason] ? ` (${CH_REASONS[m.reason]})` : ''}${dirty ? ', as saved' : ''}. Click to show it.`,
        onclick: open,
      }, m.included ? '✓ ' : '✕ ', m.custom_name || m.name,
        !m.included && CH_REASONS[m.reason] ? h('span', { class: 'meta' }, ` · ${CH_REASONS[m.reason]}`) : null)),
      hits.length > MAX ? h('button', { class: 'link', onclick: open }, `+${hits.length - MAX} more`) : null);
  };
  // Once the category's channels are on screen (right away, or after its panel loads).
  const scrollToHit = (catId) => {
    const row = view.scrollTo === catId && panels.get(catId)?.el.querySelector('.ch-row.hit, .ch-row');
    if (!row) return;
    view.scrollTo = null;
    row.scrollIntoView({ block: 'center' });
  };
  const markHits = (el) => {
    const q = view.q.trim().toLowerCase();
    for (const row of el.querySelectorAll('.ch-row')) row.classList.toggle('hit', q.length >= 2 && (row.dataset.name || '').toLowerCase().includes(q));
  };
  let searchTimer = null;
  let searchSeq = 0;
  const searchChannels = () => {
    clearTimeout(searchTimer);
    const q = view.q.trim().toLowerCase();
    if (q.length < 2) {
      view.hits = new Map();
      view.hitsQ = '';
      view.hitTotal = 0;
      return;
    }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const r = await api('GET', `/api/outputs/${id}/search?q=${encodeURIComponent(q)}`).catch(() => null);
      if (!r || seq !== searchSeq) return;
      const hits = new Map();
      for (const m of r.matches) (hits.get(m.category_id) || hits.set(m.category_id, []).get(m.category_id)).push(m);
      Object.assign(view, { hits, hitsQ: q, hitTotal: r.total });
      drawCats();
    }, 250);
  };
  // Expanded category: its channel rules plus the channel list. Panels are kept per
  // category and reused across redraws, reloading only when the category's state changes.
  const panels = new Map();
  const channelPanel = (c) => {
    const key = `${c.override}|${c.included}`;
    let p = panels.get(c.id);
    if (!p) {
      p = { el: h('div', { class: 'ch-panel' }, h('p', { class: 'meta' }, 'Loading…')), key, rules: [] };
      panels.set(c.id, p);
      loadPanel(c, p);
    } else if (p.key !== key) {
      p.key = key;
      loadPanel(c, p);
    }
    return p.el;
  };

  const loadPanel = async (c, p) => {
    const data = await api('GET', `/api/outputs/${id}/channels?category_id=${c.id}`);
    p.rules = data.rules.map((r) => ({ ...r }));
    renderPanel(c, p, data);
  };

  const renderPanel = (c, p, data) => {
    p.rerender = () => renderPanel(c, p, data);
    const saveRules = async () => {
      await attempt(() => api('PUT', `/api/outputs/${id}/categories/${c.id}/channel-rules`, { rules: p.rules }));
      c.channel_rules = p.rules.filter((r) => r.value !== '');
      await loadPanel(c, p);
      refreshCounts();
      drawCats();
    };
    const setChannels = async (ids, state) => {
      if (!ids.length) return;
      await attempt(() => api('PUT', `/api/outputs/${id}/channels`, { ids, state }));
      await loadPanel(c, p);
      refreshCounts();
    };
    const chans = data.channels;
    // Channel rules and picks only mean something once the category is in the output;
    // until then everything is shown but locked.
    const off = !data.category_included;

    // Live feedback: how many channels a rule's text matches, even before it is saved.
    const matchText = (r) => (r.value ? `matches ${chans.filter((ch) => testRule(r, ch.name)).length} of ${chans.length}` : '');
    const ruleBox = ruleGroups({
      rules: p.rules,
      subject: 'channels',
      off,
      newRule: (action) => ({ action, op: 'contains', value: '' }),
      commit: saveRules,
      // A new rule has no value yet, so it is shown but only saved once text is entered.
      onAdd: () => renderPanel(c, p, data),
      fields: (r) => {
        const count = h('span', { class: 'meta match-count' }, matchText(r));
        return [
          h('span', { class: 'meta' }, 'name'),
          h('select', { disabled: off, onchange: (e) => { r.op = e.target.value; count.textContent = matchText(r); if (r.value) saveRules(); } },
            Object.entries(OP_LABELS).map(([k, l]) => h('option', { value: k, selected: r.op === k }, l))),
          h('input', {
            value: r.value,
            disabled: off,
            placeholder: 'e.g. backup',
            oninput: (e) => { count.textContent = matchText({ ...r, value: e.target.value }); },
            onchange: (e) => { r.value = e.target.value; saveRules(); },
            onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
          }),
          count,
        ];
      },
    });

    const included = chans.filter((ch) => ch.included).length;
    const overridden = chans.filter((ch) => ch.override).map((ch) => ch.id);
    const reason = (ch) => CH_REASONS[ch.reason] || '';
    const emptyCount = chans.filter((ch) => ch.is_empty_event).length;
    const guideCount = chans.filter((ch) => ch.is_guide_placeholder).length;
    const unlistedCount = chans.filter((ch) => ch.is_unlisted).length;
    const setOption = async (key, on) => {
      await attempt(() => api('PUT', `/api/outputs/${id}/categories/${c.id}/options`, { [key]: on }));
      c[key] = on;
      await loadPanel(c, p);
      refreshCounts();
      drawCats();
    };

    p.el.classList.toggle('locked', off);
    fill(p.el,
      off ? h('div', { class: 'ch-warning' },
        h('span', null, h('b', null, 'This category is not in the output. '),
          'Include it to pick channels or use channel rules.',
          overridden.length ? ` Your ${overridden.length} earlier hand pick${overridden.length === 1 ? ' comes' : 's come'} back when you do.` : ''),
        h('button', { class: 'btn small primary', onclick: () => setOverride([c.id], 'include') }, 'Include category')) : null,
      h('div', { class: 'ch-option' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', disabled: off, checked: data.hide_empty, onchange: (e) => setOption('hide_empty', e.target.checked) }),
          h('b', null, ' Hide empty event channels'),
          h('span', { class: 'meta' }, ` · by name · ${emptyCount} of ${chans.length} look empty right now`)),
        h('span', { class: 'hint' },
          'Hides placeholders named like "Event 03:" or "Live 12 NO EVENT" until the provider names the event. ',
          h('a', { href: '#/settings' }, 'Edit the patterns'),
          '. Names update when the source refreshes, so give event sources a short refresh interval.'),
        h('label', { class: 'check second' },
          h('input', { type: 'checkbox', disabled: off, checked: data.hide_by_guide, onchange: (e) => setOption('hide_by_guide', e.target.checked) }),
          h('b', null, ' Hide channels by guide'),
          h('span', { class: 'meta' }, ` · by what's on now · ${guideCount} of ${chans.length} show a placeholder now`)),
        h('span', { class: 'hint' },
          'Hides a channel while the program on now is titled like "No Game Today" or "Off Air", and shows it again when a real listing starts. ',
          h('a', { href: '#/settings' }, 'Edit the patterns'),
          '. Players only notice when they reload the playlist.'),
        h('label', { class: 'check sub' },
          h('input', { type: 'checkbox', disabled: off || !data.hide_by_guide, checked: data.hide_unlisted, onchange: (e) => setOption('hide_unlisted', e.target.checked) }),
          ' Also hide channels with nothing listed in the next ',
          h('input', {
            type: 'number', class: 'hours-input', min: 1, max: 168, value: data.unlisted_hours, disabled: off || !data.hide_by_guide,
            title: 'Hours to look ahead (1 to 168)',
            onchange: (e) => setOption('unlisted_hours', Math.min(168, Math.max(1, Math.round(Number(e.target.value)) || 24))),
          }),
          ' hours',
          h('span', { class: 'meta' }, ` · ${unlistedCount} of ${chans.length}`)),
        h('span', { class: 'hint sub' },
          'For event channels whose guide stays empty until a game is scheduled. A channel stays while anything is airing or starts ',
          'within that many hours, so players that reload the playlist only now and then still get it in time; it goes when its ',
          'guide is empty for the whole stretch. Channels without any guide id are never hidden, and if this source\'s guide has ',
          'nothing airing now on any channel (it ran out or failed to refresh), nothing is hidden this way.'),
        data.hide_unlisted && !data.guide_current
          ? h('span', { class: 'hint sub warn-text' }, 'This source\'s guide has nothing airing now on any channel, so no channels are being hidden as "nothing listed". Check the source\'s guide refresh.')
          : null),
      h('div', { class: 'ch-rules' },
        h('div', { class: 'ch-rules-head' },
          h('b', null, 'Channel rules'),
          h('span', { class: 'hint' }, 'Filter channels inside this category by name. Channels the provider adds later are sorted by these rules too.')),
        ruleBox),
      h('div', { class: 'ch-toolbar' },
        h('span', { class: 'meta' }, `${included} of ${chans.length} channels included`),
        h('label', { class: 'check hide-excluded', title: 'Show only the channels of this category that are in the output' },
          h('input', { type: 'checkbox', checked: !!p.hideOut, onchange: (e) => { p.hideOut = e.target.checked; renderPanel(c, p, data); } }),
          ' Hide excluded'),
        h('span', { class: 'row' },
          h('button', { class: 'btn small', disabled: off, title: 'Include every channel in this category by hand', onclick: () => setChannels(chans.map((ch) => ch.id), 'include') }, 'Select all'),
          h('button', { class: 'btn small', disabled: off, title: 'Exclude every channel in this category by hand', onclick: () => setChannels(chans.map((ch) => ch.id), 'exclude') }, 'Deselect all'),
          h('button', { class: 'btn small', disabled: off || !overridden.length, title: 'Clear hand picks so the category and channel rules decide', onclick: () => setChannels(overridden, null) }, 'Reset to rules'))),
      h('div', { class: 'ch-box' },
        // Two lines per channel: the name gets the full width; details go underneath.
        chans.filter((ch) => !p.hideOut || ch.included).map((ch) => {
          const name = ch.custom_name || ch.clean_name || ch.name;
          const why = !off && ch.reason !== 'category' ? reason(ch) : '';
          const now = ch.now_title ? h('span', { class: `now-title ${ch.is_guide_placeholder ? 'placeholder' : ''}`, title: `On now: ${ch.now_title}` }, `▸ ${ch.now_title}`)
            : ch.next ? h('span', { class: 'now-title', title: `Next: ${ch.next.title}, ${whenLocal(ch.next.start)}` }, `next ${whenLocal(ch.next.start)}: ${ch.next.title}`)
            : ch.is_unlisted ? h('span', { class: 'now-title placeholder', title: `Nothing in the guide for the next ${data.unlisted_hours} hours` }, `▸ nothing in the next ${data.unlisted_hours} h`) : null;
          return h('label', { class: `ch-row ${ch.override && !off ? 'overridden' : ''} ${ch.included ? '' : 'out'}`, 'data-name': `${ch.name}\n${ch.custom_name || ''}`, title: off ? 'Include the category first' : [name, why].filter(Boolean).join('\n') },
            h('input', { type: 'checkbox', disabled: off, checked: ch.included, onchange: (e) => setChannels([ch.id], e.target.checked ? 'include' : 'exclude') }),
            h('span', { class: 'ch-name' }, shownName(ch)),
            now || why || (ch.override && !off)
              ? h('span', { class: 'ch-details' },
                why ? h('span', { class: 'ch-why' }, why) : null,
                now,
                ch.override && !off ? h('button', { class: 'link', onclick: (e) => { e.preventDefault(); setChannels([ch.id], null); } }, 'reset') : null)
              : null);
        }),
        chans.length ? null : h('p', { class: 'meta' }, 'No channels.'),
        chans.length && p.hideOut && !chans.some((ch) => ch.included) ? h('p', { class: 'meta' }, 'Every channel here is excluded (Hide excluded is on).') : null));
    markHits(p.el);
    scrollToHit(c.id);
  };

  const catSearch = h('input', { type: 'search', placeholder: 'Search categories and channels', oninput: (e) => { view.q = e.target.value; searchChannels(); drawCats(); } });
  const show = h('select', { onchange: (e) => { view.show = e.target.value; drawCats(); } },
    [['all', 'All'], ['included', 'Included'], ['excluded', 'Excluded'], ['new', 'New'], ['manual', 'Picked by hand']].map(([v, l]) => h('option', { value: v }, l)));
  const bulk = (state) => () => setOverride(visible().map((c) => c.id), state);
  const catsCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Categories'), summary),
    h('div', { class: 'toolbar' }, catSearch, show, hideToggle(),
      h('span', { class: 'row' },
        h('button', { class: 'btn small', onclick: bulk('include') }, 'Include shown'),
        h('button', { class: 'btn small', onclick: bulk('exclude') }, 'Exclude shown'),
        h('button', { class: 'btn small', onclick: bulk(null) }, 'Reset shown to Auto'))),
    hitNote,
    catBox);

  // --- urls
  const urlsCard = h('section', { class: 'card' });
  const drawUrls = () => {
    fill(urlsCard, 
      h('div', { class: 'card-head' }, h('h2', null, 'Connect your apps'), h('span', { class: 'meta' }, `${o.channel_count} channels live`)),
      copyField('M3U playlist', o.urls.m3u),
      copyField('XMLTV guide', o.urls.epg),
      copyField('XMLTV guide (gzip)', o.urls.epg_gz),
      o.xc_enabled ? h('div', { class: 'xc-box' },
        h('h3', null, 'Xtream Codes login'),
        copyField('Server', o.urls.xc_server), h('div', { class: 'two' }, copyField('Username', o.xc_username), copyField('Password', o.xc_password))) : null,
      o.xc_enabled ? loginsBox() : null,
      // Three rows: look, keep up to date, then the ones that affect people using it.
      h('div', { class: 'xc-box' }, h('h3', null, 'Manage output'),
        o.paused ? h('div', { class: 'ch-warning manage-note' },
          h('span', null, h('b', null, 'Paused. '), 'Its URLs and every login are switched off until you resume it.')) : null,
        h('div', { class: 'manage-rows' },
          h('div', { class: 'row' },
            h('a', { class: 'btn small', href: o.urls.m3u, target: '_blank', rel: 'noopener' }, 'Open playlist'),
            h('a', { class: 'btn small', href: o.urls.epg, target: '_blank', rel: 'noopener' }, 'Open guide')),
          h('div', { class: 'row' },
            h('button', {
              class: 'btn small',
              title: 'Reload every source this output uses, movies and series included',
              onclick: async () => {
                const r = await attempt(() => api('POST', `/api/outputs/${id}/refresh`));
                toast(r.sources ? `Refreshing ${r.sources} source${r.sources === 1 ? '' : 's'}` : 'This output has no sources to refresh');
              },
            }, 'Refresh sources'),
            h('button', {
              class: 'btn small',
              title: 'A copy with the same sources, rules, picks and settings, and its own URLs',
              onclick: async () => {
                if (dirty) return toast('Save or discard your changes first; the copy is made from the saved output.', 'error');
                const copy = await attempt(() => api('POST', `/api/outputs/${id}/clone`),
                  o.xc_enabled ? 'Output duplicated. Its Xtream Codes login is off until you give it a username.' : 'Output duplicated');
                location.hash = `#/outputs/${copy.id}`;
              },
            }, 'Duplicate')),
          h('div', { class: 'row' },
            h('button', {
              class: `btn small ${o.paused ? 'primary' : ''}`,
              title: o.paused ? 'Switch its URLs and logins back on' : 'Switch off its URLs and every login for now, without deleting anything',
              onclick: async () => {
                if (!o.paused && !(await confirmBox(`Pause "${o.name}"? Players using its URLs or any of its logins stop working until you resume it.`, 'Pause'))) return;
                o = { ...o, ...(await attempt(() => api('POST', `/api/outputs/${id}/pause`, { paused: !o.paused }), o.paused ? 'Output resumed' : 'Output paused')) };
                drawUrls();
                drawTitle();
              },
            }, o.paused ? 'Resume output' : 'Pause output'),
            h('button', {
              class: 'btn small danger-text',
              onclick: async () => {
                if (!(await confirmBox('Make new URLs for this output? Apps using the current URLs will stop working until you update them.', 'Regenerate'))) return;
                o = await attempt(() => api('POST', `/api/outputs/${id}/token`), 'New URLs created');
                drawUrls();
              },
            }, 'Regenerate URLs'),
            h('button', {
              class: 'btn small danger-text',
              onclick: async () => {
                if (!(await confirmBox(`Delete the output "${o.name}"? Its URLs will stop working.`))) return;
                await attempt(() => api('DELETE', `/api/outputs/${id}`), 'Output deleted');
                dirty = false;
                location.hash = '#/outputs';
              },
            }, 'Delete output')))));
  };
  // Other people's logins to this output: each with its own username and password, paused or
  // removed on its own. Saved right away (not with the output's Save).
  // Logins shown expanded (collapsed by default), kept across redraws.
  const openLogins = new Set();
  const loginsBox = () => {
    const logins = o.xc_logins || [];
    const randomPassword = () => Math.random().toString(36).slice(2, 10);
    const reload = async () => {
      o = { ...o, ...(await api('GET', `/api/outputs/${id}`)) };
      drawUrls();
    };
    const playlistUrl = (l) => `${o.urls.xc_server}/get.php?username=${encodeURIComponent(l.username)}&password=${encodeURIComponent(l.password)}&type=m3u_plus&output=ts`;
    const guideUrl = (l) => `${o.urls.xc_server}/xmltv.php?username=${encodeURIComponent(l.username)}&password=${encodeURIComponent(l.password)}`;
    const addForm = () => {
      const name = h('input', { placeholder: 'Who is it for? e.g. Mom' });
      const user = h('input', { placeholder: 'Username', autocomplete: 'off' });
      const pass = h('input', { value: randomPassword(), autocomplete: 'off' });
      name.addEventListener('input', () => {
        if (!user.dataset.touched) user.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '');
      });
      user.addEventListener('input', () => { user.dataset.touched = '1'; });
      const close = modal('Add a login', h('div', { class: 'form' },
        h('p', { class: 'hint' }, 'Someone else can then use this output in their own player, with their own username and password. Remove it any time without affecting anyone else.'),
        field('Name', name), h('div', { class: 'two' }, field('Username', user), field('Password', pass))), [
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const added = await attempt(() => api('POST', `/api/outputs/${id}/logins`, { name: name.value, username: user.value, password: pass.value }), 'Login added');
            openLogins.add(added.id);
            close();
            reload();
          },
        }, 'Add login'),
      ]);
      name.focus();
    };
    return h('div', { class: 'xc-box' },
      h('div', { class: 'card-head' }, h('h3', null, 'Other logins'), h('button', { class: 'btn small', onclick: addForm }, '+ Add login')),
      logins.length ? null : h('p', { class: 'hint' }, 'Share this output with someone by giving them a login of their own. Removing it later leaves every other login working.'),
      logins.map((l) => h('div', { class: `login-row ${l.enabled ? '' : 'off'}` },
        h('div', { class: 'login-head' },
          h('button', {
            class: 'expander login-toggle', title: openLogins.has(l.id) ? 'Hide details' : 'Show username, password and URLs',
            onclick: () => { openLogins.has(l.id) ? openLogins.delete(l.id) : openLogins.add(l.id); drawUrls(); },
          }, openLogins.has(l.id) ? '▾' : '▸', h('b', null, ` ${l.name || l.username}`)),
          h('span', { class: 'meta' }, l.last_used_at ? ` · used ${ago(l.last_used_at)}` : ' · not used yet'),
          h('span', { class: 'row' },
            h('label', { class: 'check', title: 'Switch this login off without removing it' },
              h('input', {
                type: 'checkbox', checked: l.enabled,
                onchange: (e) => attempt(() => api('PUT', `/api/outputs/${id}/logins/${l.id}`, { enabled: e.target.checked }),
                  e.target.checked ? 'Login on' : 'Login paused').then(reload),
              }), ' On'),
            h('button', {
              class: 'btn small danger-text',
              onclick: async () => {
                if (!(await confirmBox(`Remove the login "${l.name || l.username}"? Players using it stop working; other logins are not affected.`, 'Remove'))) return;
                await attempt(() => api('DELETE', `/api/outputs/${id}/logins/${l.id}`), 'Login removed');
                reload();
              },
            }, 'Remove'))),
        openLogins.has(l.id) ? h('div', { class: 'login-body' },
          h('div', { class: 'two' }, copyField('Username', l.username), copyField('Password', l.password)),
          copyField('M3U playlist', playlistUrl(l)),
          copyField('XMLTV guide', guideUrl(l))) : null)));
  };

  const refreshCounts = async () => {
    o = { ...o, ...(await api('GET', `/api/outputs/${id}`)) };
    drawUrls();
  };
  drawUrls();

  const save = async () => {
    const payload = {
      name: draft.name,
      stream_mode: draft.stream_mode,
      number_start: draft.number_start === '' ? null : Number(draft.number_start),
      epg_days: Number(draft.epg_days) || 7,
      include_all: draft.include_all,
      include_all_movie: draft.include_all_movie,
      include_all_series: draft.include_all_series,
      xc_enabled: draft.xc_enabled,
      xc_username: draft.xc_username,
      xc_password: draft.xc_password,
      source_ids: attachedIds(),
      source_affixes: Object.fromEntries(draft.sources.map((s) => [s.id, { cat_prefix: s.cat_prefix, cat_suffix: s.cat_suffix }])),
      rules: [
        ...draft.rules.map((r) => ({ ...r, kind: 'live' })),
        ...draft.vod_rules.movie.map((r) => ({ ...r, kind: 'movie' })),
        ...draft.vod_rules.series.map((r) => ({ ...r, kind: 'series' })),
      ].filter((r) => r.value !== ''),
      vod_enabled: draft.vod_enabled,
      light_enabled: draft.light_enabled,
      convert_mode: draft.convert_mode,
      // Only sent when shown, so an output's rules are never touched with advanced options off.
      name_rules: settings.advanced ? draft.name_rules.filter((r) => r.find !== '') : undefined,
    };
    o = await attempt(() => api('PUT', `/api/outputs/${id}`, payload), 'Output saved');
    cats = await api('GET', `/api/outputs/${id}/categories`);
    draft.rules = o.rules.filter((r) => r.kind === 'live').map((r) => ({ ...r }));
    for (const kind of ['movie', 'series']) draft.vod_rules[kind] = o.rules.filter((r) => r.kind === kind).map((r) => ({ ...r }));
    draft.name_rules = o.name_rules.map((r) => ({ ...r }));
    dirty = false;
    saveBar.hidden = true;
    drawTitle();
    liveRules.draw();
    if (settings.advanced) {
      drawNames();
      previewNames();
    }
    drawCats();
    drawUrls();
    // Newly attached sources bring their own movie and series categories.
    for (const p of Object.values(vodPanes)) {
      p.rules.draw();
      if (p.loaded) p.load();
    }
    redrawVod();
  };

  // --- movies & series: one tab each, with their own rules and categories
  const VOD_LABELS = {
    movie: { title: 'Movie', one: 'movie', plural: 'movies', tab: 'Movies' },
    series: { title: 'Series', one: 'series', plural: 'series', tab: 'Series' },
  };
  const vodPane = (kind) => {
    const L = VOD_LABELS[kind];
    // hits: titles matching the search (from the server), per category, for hitsQ.
    const state = { cats: null, q: '', show: 'all', open: new Set(), hits: new Map(), hitsQ: '', hitTotal: 0 };
    const titleHits = (c) => (state.hitsQ && state.hitsQ === state.q.trim().toLowerCase() && state.hits.get(c.id)) || [];
    let searchTimer = null;
    let searchSeq = 0;
    const searchTitles = () => {
      clearTimeout(searchTimer);
      const q = state.q.trim().toLowerCase();
      if (q.length < 2) {
        Object.assign(state, { hits: new Map(), hitsQ: '', hitTotal: 0 });
        return;
      }
      searchTimer = setTimeout(async () => {
        const seq = ++searchSeq;
        const r = await api('GET', `/api/outputs/${id}/search?kind=${kind}&q=${encodeURIComponent(q)}`).catch(() => null);
        if (!r || seq !== searchSeq) return;
        const hits = new Map();
        for (const m of r.matches) (hits.get(m.category_id) || hits.set(m.category_id, []).get(m.category_id)).push(m);
        Object.assign(state, { hits, hitsQ: q, hitTotal: r.total });
        draw();
      }, 250);
    };
    // Chips under a category for its matching titles; a click opens it filtered to the search.
    const hitLine = (c) => {
      const hits = titleHits(c);
      if (!hits.length) return null;
      const MAX = 6;
      const open = () => {
        state.open.add(c.id);
        const p = titlePanels.get(c.id);
        if (p) {
          p.q = state.q.trim();
          p.rerender?.();
        }
        draw();
      };
      return h('span', { class: 'ch-hits' },
        hits.slice(0, MAX).map((m) => h('button', {
          class: `hit-chip ${m.included ? 'in' : 'out'}`,
          title: `${m.included ? 'In the output' : m.reason === 'manual' ? 'Picked out by hand' : 'Its category is not in the output'}${dirty ? ', as saved' : ''}. Click to show it.`,
          onclick: open,
        }, m.included ? '✓ ' : '✕ ', m.custom_name || m.name)),
        hits.length > MAX ? h('button', { class: 'link', onclick: open }, `+${hits.length - MAX} more`) : null);
    };
    const hitNote = h('p', { class: 'meta' });
    const titlePanels = new Map();
    const rules = rulesEditor(() => draft.vod_rules[kind], 'e.g. EN|');
    const list = h('div', { class: 'cat-table' });
    const summary = h('span', { class: 'meta' });
    const notice = h('div');
    const evalVod = (c) => (attachedIds().includes(c.source_id)
      ? categoryState(c, draft.vod_rules[kind], c.override, draft[`include_all_${kind}`])
      : { included: false, reason: 'detached' });
    const visible = () => {
      const q = state.q.toLowerCase();
      return (state.cats || []).filter((c) => {
        const st = evalVod(c);
        if (q && !(c.custom_name || c.name).toLowerCase().includes(q) && !c.name.toLowerCase().includes(q) && !titleHits(c).length) return false;
        if (hideExcluded && !st.included) return false;
        if (state.show === 'included') return st.included;
        if (state.show === 'excluded') return !st.included;
        if (state.show === 'new') return c.is_new;
        if (state.show === 'manual') return !!c.override;
        return true;
      });
    };
    const setOverride = async (ids, value) => {
      await attempt(() => api('PUT', `/api/outputs/${id}/categories`, { ids, state: value }));
      for (const c of state.cats) if (ids.includes(c.id)) c.override = value;
      draw();
    };
    // Inside a category: its titles, each picked in or out by hand, and renamed if wanted. Panels
    // are kept per category and reloaded when the category's own state changes.
    const titlesPanel = (c) => {
      const key = `${c.override}|${c.included}`;
      let p = titlePanels.get(c.id);
      if (!p) {
        // Opened from a search hit: start filtered to the search.
        p = { el: h('div', { class: 'ch-panel' }, h('p', { class: 'meta' }, 'Loading…')), key, q: titleHits(c).length ? state.q.trim() : '' };
        titlePanels.set(c.id, p);
        loadTitles(c, p);
      } else if (p.key !== key) {
        p.key = key;
        loadTitles(c, p);
      }
      return p.el;
    };
    const loadTitles = async (c, p) => {
      renderTitles(c, p, await api('GET', `/api/outputs/${id}/titles?category_id=${c.id}`));
    };
    const renderTitles = (c, p, data) => {
      p.rerender = () => renderTitles(c, p, data);
      const off = !data.category_included;
      const set = async (body) => {
        await attempt(() => api('PUT', `/api/outputs/${id}/titles`, body));
        await loadTitles(c, p);
        await load(); // the category's count of titles that are in
      };
      const inCount = data.titles.filter((t) => t.included).length;
      const picked = data.titles.filter((t) => t.override).map((t) => t.id);
      const box = h('div', { class: 'ch-box' });
      const drawBox = () => {
        const q = p.q.toLowerCase();
        const list = data.titles.filter((t) => (!p.hideOut || t.included)
          && (!q || (t.custom_name || t.name).toLowerCase().includes(q) || t.name.toLowerCase().includes(q)));
        const LIMIT = 500;
        fill(box,
          list.slice(0, LIMIT).map((t) => h('label', {
            class: `ch-row title-row ${t.override && !off ? 'overridden' : ''} ${t.included ? '' : 'out'}`,
            title: off ? 'Include the category first' : [t.custom_name || t.name, t.override ? 'picked by hand' : ''].filter(Boolean).join('\n'),
          },
          h('input', { type: 'checkbox', disabled: off, checked: t.included, onchange: (e) => set({ ids: [t.id], state: e.target.checked ? 'include' : 'exclude' }) }),
          h('span', { class: 'ch-name' }, shownName(t)),
          h('button', { class: 'icon-btn rename', title: 'Rename (in every output)', onclick: (e) => { e.preventDefault(); renameTitle(t, () => loadTitles(c, p)); } }, '✎'),
          t.override && !off
            ? h('span', { class: 'ch-details' },
              t.override && !off ? h('button', { class: 'link', onclick: (e) => { e.preventDefault(); set({ ids: [t.id], state: null }); } }, 'reset') : null)
            : null)),
          list.length > LIMIT ? h('p', { class: 'meta' }, `Showing the first ${LIMIT} of ${list.length}. Type in the filter to narrow it down.`) : null,
          list.length ? null : h('p', { class: 'meta' }, !data.titles.length ? 'No titles.' : p.hideOut && !q ? 'Every title here is excluded (Hide excluded is on).' : 'No titles match.'));
      };
      drawBox();
      p.el.classList.toggle('locked', off);
      fill(p.el,
        off ? h('div', { class: 'ch-warning' },
          h('span', null, h('b', null, 'This category is not in the output. '),
            `Include it to pick ${L.plural}.`,
            picked.length ? ` Your ${picked.length} earlier hand pick${picked.length === 1 ? ' comes' : 's come'} back when you do.` : ''),
          h('button', { class: 'btn small primary', onclick: () => setOverride([c.id], 'include') }, 'Include category')) : null,
        h('div', { class: 'ch-toolbar' },
          h('span', { class: 'meta' }, `${inCount.toLocaleString()} of ${data.total.toLocaleString()} ${data.total === 1 ? L.one : L.plural} included`),
          h('label', { class: 'check hide-excluded', title: `Show only the ${L.plural} of this category that are in the output` },
            h('input', { type: 'checkbox', checked: !!p.hideOut, onchange: (e) => { p.hideOut = e.target.checked; drawBox(); } }),
            ' Hide excluded'),
          data.titles.length > 20 || p.q
            ? h('input', { type: 'search', class: 'title-filter', placeholder: `Filter ${L.plural}`, value: p.q, oninput: (e) => { p.q = e.target.value; drawBox(); } })
            : null,
          h('span', { class: 'row' },
            h('button', { class: 'btn small', disabled: off, title: `Include every ${L.one} in this category by hand`, onclick: () => set({ category_id: c.id, state: 'include' }) }, 'Select all'),
            h('button', { class: 'btn small', disabled: off, title: `Exclude every ${L.one} in this category by hand`, onclick: () => set({ category_id: c.id, state: 'exclude' }) }, 'Deselect all'),
            h('button', { class: 'btn small', disabled: off || !picked.length, title: 'Clear hand picks, so the whole category is in', onclick: () => set({ ids: picked, state: null }) }, 'Reset to rules'))),
        data.truncated ? h('p', { class: 'meta' }, `This category is very large; the first ${data.titles.length.toLocaleString()} titles are listed.`) : null,
        box);
    };
    const draw = () => {
      fill(notice,
        draft.xc_enabled ? null : h('div', { class: 'ch-warning' },
          h('span', null, h('b', null, 'Players get movies and series through the Xtream Codes login. '), 'Turn it on under Settings.')));
      if (!state.cats) {
        fill(list, h('p', { class: 'meta pad' }, 'Loading…'));
        return;
      }
      if (!state.cats.length) {
        summary.textContent = '';
        fill(list, h('p', { class: 'meta pad' },
          `None of this output's sources has ${L.plural}. Edit a source and set its content to "Live TV, movies and series".`));
        return;
      }
      let inc = 0;
      let titles = 0;
      for (const c of state.cats) {
        if (evalVod(c).included) {
          inc++;
          titles += c.channel_count - (c.excluded_count || 0);
        }
      }
      summary.textContent = `${inc} of ${state.cats.length} categories · ${titles.toLocaleString()} ${titles === 1 ? L.one : L.plural}${dirty ? ' (preview)' : ''}`;
      const rows = visible();
      const LIMIT = 500;
      fill(list,
        ...withGroups(rows.slice(0, LIMIT), (c) => {
          const st = evalVod(c);
          const seg = (label, val, cls) => h('button', { class: `${c.override === val ? 'on' : ''} ${cls}`, title: val ? `Always ${val}` : 'Follow the rules', onclick: () => setOverride([c.id], val) }, label);
          const row = h('div', { class: `cat-row ${st.included ? 'in' : 'out'}` },
            h('button', { class: 'expander', title: `Show the ${L.plural}`, onclick: () => { state.open.has(c.id) ? state.open.delete(c.id) : state.open.add(c.id); draw(); } }, state.open.has(c.id) ? '▾' : '▸'),
            h('span', { class: 'dot' }),
            h('span', { class: 'cat-name' }, shownName(c), c.is_new ? badge('new', 'info') : null,
              h('span', { class: 'meta' }, ` · ${c.excluded_count ? `${(c.channel_count - c.excluded_count).toLocaleString()} of ` : ''}${c.channel_count.toLocaleString()} ${c.channel_count === 1 ? L.one : L.plural} · ${reasonText(st)}`),
              hitLine(c)),
            h('button', { class: 'icon-btn', title: 'Rename (the name players see)', onclick: () => editCategory(c, draw, { vod: true }) }, '✎'),
            h('span', { class: 'segmented small' }, seg('Auto', null, ''), seg('Include', 'include', 'inc'), seg('Exclude', 'exclude', 'exc')));
          return state.open.has(c.id) ? h('div', null, row, titlesPanel(c)) : row;
        }),
        rows.length > LIMIT ? h('p', { class: 'meta pad' }, `Showing the first ${LIMIT} of ${rows.length}. Use the search box to narrow the list.`) : null,
        rows.length ? null : h('p', { class: 'meta pad' }, 'No categories to show.'));
      fill(hitNote, state.hitTotal > 200 && state.hitsQ === state.q.trim().toLowerCase()
        ? `Showing title matches for the first 200 of ${state.hitTotal.toLocaleString()} ${L.plural}. Type more to narrow it down.` : '');
    };
    const load = async () => {
      state.cats = await api('GET', `/api/outputs/${id}/categories?kind=${kind}`);
      draw();
    };
    const bulk = (value) => () => setOverride(visible().map((c) => c.id), value);
    const el = h('div', { hidden: true },
      notice,
      foldCard(`rules-${kind}`, `${L.title} rules`, () => ruleCount(draft.vod_rules[kind]),
        h('p', { class: 'hint' },
          `Rules run against the provider's ${L.title.toLowerCase()} category names on every refresh, so new categories that match are added automatically. `,
          'A category is kept when it matches any Include rule and no Exclude rule. Picking a category by hand below always wins.'),
        rules.box,
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: draft[`include_all_${kind}`], onchange: (e) => { draft[`include_all_${kind}`] = e.target.checked; markDirty(); } }),
          ` When a source has no Include rules, include all of its ${L.title.toLowerCase()} categories`)),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, `${L.title} categories`), summary),
        h('div', { class: 'toolbar' },
          h('input', { type: 'search', placeholder: 'Search categories and titles', oninput: (e) => { state.q = e.target.value; searchTitles(); draw(); } }),
          h('select', { onchange: (e) => { state.show = e.target.value; draw(); } },
            [['all', 'All'], ['included', 'Included'], ['excluded', 'Excluded'], ['new', 'New'], ['manual', 'Picked by hand']].map(([v, l]) => h('option', { value: v }, l))),
          hideToggle(),
          h('span', { class: 'row' },
            h('button', { class: 'btn small', onclick: bulk('include') }, 'Include shown'),
            h('button', { class: 'btn small', onclick: bulk('exclude') }, 'Exclude shown'),
            h('button', { class: 'btn small', onclick: bulk(null) }, 'Reset shown to Auto'))),
        hitNote,
        list));
    return { el, draw, load, rules, get loaded() { return !!state.cats; } };
  };
  const vodPanes = { movie: vodPane('movie'), series: vodPane('series') };
  const livePane = h('div', null, rulesCard, namesCard, catsCard);
  const tabsBar = h('div', { class: 'tabs' });
  let tab = 'live';
  const drawTabs = () => {
    if (!draft.vod_enabled) tab = 'live';
    tabsBar.hidden = !draft.vod_enabled;
    fill(tabsBar, [['live', 'Live TV'], ['movie', 'Movies'], ['series', 'Series']].map(([k, label]) =>
      h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; drawTabs(); } }, label)));
    livePane.hidden = tab !== 'live';
    for (const [k, p] of Object.entries(vodPanes)) {
      p.el.hidden = tab !== k;
      if (tab === k && !p.loaded) p.load();
    }
    // Moving it would take the focus from a rule being typed in, so only when it isn't in place.
    if (namesCard) {
      const [pane, before] = tab === 'live' ? [livePane, catsCard] : [vodPanes[tab].el, vodPanes[tab].el.lastElementChild];
      if (namesCard.parentElement !== pane || namesCard.nextElementSibling !== before) pane.insertBefore(namesCard, before);
    }
  };
  let namesFor = draft.vod_enabled;
  redrawVod = () => {
    // Switching movies & series on or off changes the rule rows (redrawn only then: typing
    // in a rule also lands here, and a redraw would take its focus away).
    if (settings.advanced && namesFor !== draft.vod_enabled) {
      namesFor = draft.vod_enabled;
      drawNames();
    }
    drawTabs();
    for (const p of Object.values(vodPanes)) if (p.loaded) p.draw();
  };
  drawTabs();

  // One column at a time when the page is narrow (the switch is hidden otherwise).
  const editorEl = h('div', { class: `editor show-${outputPane}` },
    h('div', { class: 'editor-main' }, tabsBar, livePane, vodPanes.movie.el, vodPanes.series.el),
    h('div', { class: 'editor-side' }, urlsCard, settingsCard, sourcesCard));
  const paneSwitch = h('div', { class: 'segmented pane-switch' });
  const drawPaneSwitch = () => {
    editorEl.className = `editor show-${outputPane}`;
    fill(paneSwitch, [['main', 'Lineup'], ['side', 'Connect & settings']].map(([k, label]) =>
      h('button', { class: outputPane === k ? 'on' : '', onclick: () => { outputPane = k; drawPaneSwitch(); window.scrollTo(0, 0); } }, label)));
  };
  drawPaneSwitch();

  const title = h('h1');
  const drawTitle = () => fill(title, o.name, o.paused ? badge('paused', 'warn') : null);
  drawTitle();
  fill(main, 
    h('div', { class: 'page-head' }, h('div', null, h('a', { href: '#/outputs', class: 'crumb' }, '‹ Outputs'), title)),
    paneSwitch,
    editorEl,
    saveBar);
  drawCats();
}

// ----------------------------------------------------------------- watch --

// Player libraries, loaded on first use (only this page needs them).
function loadScript(src, global) {
  if (window[global]) return Promise.resolve(window[global]);
  return new Promise((resolve, reject) => {
    const s = h('script', { src });
    s.onload = () => (window[global] ? resolve(window[global]) : reject(new Error('The player did not load')));
    s.onerror = () => reject(new Error('The player could not be loaded'));
    document.head.append(s);
  });
}

const CODEC_HINT = 'Browsers play H.264 or H.265 video with AAC audio. Channels in MPEG-2 video or with Dolby (AC-3) audio, '
  + 'common on HDHomeRun, are converted on the server when it has ffmpeg; otherwise use Copy link and a player app such as VLC.';

async function watchView(main, outputId, channelId) {
  const outputs = await api('GET', '/api/outputs');
  if (!outputs.length) {
    fill(main, h('div', { class: 'page-head' }, h('h1', null, 'Watch')),
      h('div', { class: 'card empty' }, h('p', null, 'Create an output first; its channels play here.'), h('a', { class: 'btn primary', href: '#/outputs' }, 'Outputs')));
    return;
  }
  let remembered = null;
  try {
    remembered = Number(localStorage.getItem('iptvm.watchOutput')) || null;
  } catch {}
  let oid = [outputId, remembered, outputs[0].id].find((x) => x && outputs.some((o) => o.id === x));
  let lineup = { channels: [] };
  let current = null;
  // Channels the browser couldn't decode: they play as a copy converted on the server from now on.
  const convertIds = new Set();
  let player = null;
  let q = '';

  const video = h('video', { class: 'watch-video', controls: true, playsinline: true, preload: 'none' });
  const stage = h('div', { class: 'watch-stage' }, video);
  const nowLine = h('div', { class: 'watch-now' }, h('span', { class: 'meta' }, 'Pick a channel to start watching.'));
  const message = h('div', { class: 'watch-message', hidden: true });
  const list = h('div', { class: 'watch-list-body' });

  const showMessage = (text, kind = 'error') => {
    message.className = `watch-message ${kind}`;
    fill(message, ...[].concat(text));
    message.hidden = !text;
  };
  // Keeping it playing: the provider may drop the connection, or the stream may skip (a gap the
  // player won't cross). While the viewer wants it playing (not paused or stopped by them), a
  // watchdog nudges over gaps and reconnects when the picture stops.
  let wantPlaying = false;
  let ownPauseUntil = 0; // pauses we cause (switching, reconnecting) aren't the viewer's
  let progressAt = 0;
  let lastTime = 0;
  let retries = 0;
  let lastRetry = 0;
  let retryNote = false;
  const reconnect = (why) => {
    if (!current || !wantPlaying || Date.now() - lastRetry < 5000) return;
    if (retries >= 10) {
      wantPlaying = false;
      return showMessage([h('b', null, 'The stream keeps dropping. '), `Last time ${why}. Try again later, or another channel.`]);
    }
    lastRetry = Date.now();
    retries++;
    play(current, why);
  };
  video.addEventListener('play', () => { wantPlaying = true; });
  video.addEventListener('pause', () => { if (Date.now() > ownPauseUntil && !video.ended) wantPlaying = false; });
  video.addEventListener('ended', () => reconnect('the stream ended'));
  const watchdog = setInterval(() => {
    if (!current || !wantPlaying) return;
    const now = Date.now();
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      progressAt = now;
      if (retryNote) {
        retryNote = false;
        showMessage(null);
      }
      if (now - lastRetry > 60_000) retries = 0;
      return;
    }
    if (now - progressAt < 6000) return;
    // Stuck. Data further on (after a gap)? Jump to it. Otherwise get a fresh connection.
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) > video.currentTime + 0.05) {
        video.currentTime = video.buffered.start(i) + 0.05;
        progressAt = now;
        return;
      }
    }
    reconnect('the picture stopped');
  }, 1000);
  cleanups.push(() => clearInterval(watchdog));

  const stop = () => {
    ownPauseUntil = Date.now() + 1000;
    if (player) {
      try {
        player.destroy();
      } catch {}
      player = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
  cleanups.push(stop);

  // Why a stream failed, from the server's answer where there is one.
  const explain = async (url) => {
    try {
      const r = await fetch(url, { method: 'GET', headers: { range: 'bytes=0-0' } });
      if (r.status === 503) return (await r.text()) || 'All streams for this source are in use.';
      if (r.status === 404) return 'This channel is no longer in the output.';
      if (!r.ok) return `The provider did not send the stream (HTTP ${r.status}).`;
      r.body?.cancel().catch(() => {});
    } catch {}
    return null;
  };
  // kind: 'media' (the browser can't decode it), 'network' (the stream didn't arrive), or other.
  // The player's own words go underneath, to tell what happened.
  const failed = async (url, kind, detail) => {
    const why = kind === 'media' ? null : await explain(url);
    const more = detail ? h('div', { class: 'meta' }, `Details: ${detail}`) : null;
    if (why) return showMessage([why, more]);
    if (kind === 'media') return showMessage([h('b', null, 'This browser can\'t decode this channel. '), CODEC_HINT, more]);
    if (kind === 'network') return showMessage([h('b', null, 'The stream stopped arriving. '), 'Try again, or check the source on the Sources page.', more]);
    showMessage([h('b', null, 'Playback failed. '), 'If it keeps happening, the details below say why.', more]);
  };

  // The browser can't decode this channel: switch to the server's converted copy (once).
  const convertInstead = (ch) => {
    if (convertIds.has(ch.id) || !window.MediaSource) return false;
    convertIds.add(ch.id);
    play(ch);
    return true;
  };

  // retry: why this is a reconnect (keeps a small note up until the picture moves again).
  const play = async (ch, retry = null) => {
    stop();
    if (!retry || current !== ch) retries = 0;
    current = ch;
    const convert = convertIds.has(ch.id);
    wantPlaying = true;
    lastTime = 0;
    // Time to start before the watchdog looks (ffmpeg needs a little longer).
    progressAt = Date.now() + (convert ? 10_000 : 6000);
    retryNote = !!retry || convert;
    showMessage(retry ? `Reconnecting (${retry})…`
      : convert ? 'Converting on the server: this channel\'s video or sound isn\'t one the browser plays…' : null, 'warn');
    try {
      history.replaceState(null, '', `#/watch/${oid}/${ch.id}`);
    } catch {}
    fill(nowLine, h('b', null, ch.chno ? `${ch.chno} · ${ch.name}` : ch.name), ch.now ? h('span', { class: 'meta' }, ` · on now: ${ch.now}`) : null);
    drawList();
    // A full address: the player's background worker can't resolve relative ones.
    const base = `${location.origin}/api/outputs/${oid}/watch/${ch.id}`;
    // The browser's own HLS player only where the libraries can't run (iPhone: no Media Source).
    const nativeHls = !window.MediaSource && !!video.canPlayType('application/vnd.apple.mpegurl');
    try {
      if (nativeHls && ch.hls_available && !convert) {
        // Safari and iPhone: their own HLS player.
        video.src = `${base}?format=m3u8`;
        video.onerror = () => {
          const code = video.error?.code;
          if (code === 1) return; // aborted (switching channels)
          // 3: couldn't decode; 4: format not supported (or the address failed, which explain() tells apart).
          failed(video.src, code === 2 ? 'network' : code === 3 ? 'media' : 'other', [`MediaError ${code}`, video.error?.message].filter(Boolean).join(': '));
        };
      } else if (ch.format === 'm3u8' && !convert) {
        const Hls = await loadScript('/vendor/hls.js', 'Hls');
        if (current !== ch) return;
        if (!Hls.isSupported()) throw new Error('This browser cannot play HLS streams.');
        // Smooth over live-edge latency: IPTV arrives in bursts, and chasing the edge skips.
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false, liveSyncDurationCount: 4, maxBufferLength: 30 });
        hls.on(Hls.Events.ERROR, (e, d) => {
          if (!d.fatal) return;
          const kind = d.type === Hls.ErrorTypes.MEDIA_ERROR ? 'media' : d.type === Hls.ErrorTypes.NETWORK_ERROR ? 'network' : 'other';
          if (kind === 'network' && retries < 3) return reconnect('the connection dropped');
          if (kind === 'media' && convertInstead(ch)) return;
          failed(`${base}?format=m3u8`, kind, [d.type, d.details, d.reason].filter(Boolean).join(': '));
        });
        hls.loadSource(`${base}?format=m3u8`);
        hls.attachMedia(video);
        player = { destroy: () => hls.destroy() };
      } else {
        const mpegts = await loadScript('/vendor/mpegts.js', 'mpegts');
        if (current !== ch) return;
        if (!mpegts.getFeatureList().mseLivePlayback) throw new Error('This browser cannot play live MPEG-TS streams.');
        const url = convert ? `${base}?convert=1` : `${base}?format=ts`;
        const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url },
          {
            // Decode off the page's thread, and keep a buffer instead of chasing the live edge:
            // streams arrive in bursts, and chasing them skips and stalls.
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 512 * 1024,
            lazyLoad: false,
            liveBufferLatencyChasing: false,
            autoCleanupSourceBuffer: true,
          });
        p.on(mpegts.Events.ERROR, (type, detail, info) => {
          const kind = type === mpegts.ErrorTypes.MEDIA_ERROR ? 'media' : type === mpegts.ErrorTypes.NETWORK_ERROR ? 'network' : 'other';
          if (kind === 'network' && retries < 3) return reconnect('the connection dropped');
          if (kind === 'media' && convertInstead(ch)) return;
          failed(url, kind, [type, detail, info?.msg].filter(Boolean).join(': '));
        });
        p.attachMediaElement(video);
        p.load();
        player = { destroy: () => { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } };
      }
      await video.play().catch(() => {});
    } catch (e) {
      showMessage([h('b', null, e.message), ' Try another browser, or a player app such as VLC or TiviMate.']);
    }
  };

  const step = (d) => {
    const shown = filtered();
    if (!shown.length) return;
    const i = current ? shown.findIndex((c) => c.id === current.id) : -1;
    play(shown[(i + d + shown.length) % shown.length]);
  };
  const fullscreen = () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (stage.requestFullscreen) return stage.requestFullscreen().catch(() => {});
    if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  };
  video.addEventListener('dblclick', fullscreen);

  const filtered = () => {
    const t = q.trim().toLowerCase();
    return lineup.channels.filter((c) => !t || c.name.toLowerCase().includes(t) || (c.group || '').toLowerCase().includes(t) || (c.now || '').toLowerCase().includes(t));
  };
  const drawList = () => {
    const rows = filtered();
    const out = [];
    let group = null;
    for (const c of rows) {
      if (c.group !== group) {
        group = c.group;
        out.push(h('div', { class: 'watch-group' }, group || 'Other'));
      }
      out.push(h('button', { class: `watch-ch ${current?.id === c.id ? 'on' : ''}`, onclick: () => play(c) },
        c.logo ? h('img', { src: c.logo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'watch-logo' }),
        h('span', { class: 'watch-ch-text' },
          h('span', { class: 'watch-ch-name' }, c.chno ? h('span', { class: 'meta' }, `${c.chno} `) : null, c.name),
          c.now ? h('span', { class: 'meta watch-ch-now' }, c.now) : null)));
    }
    fill(list, ...out, rows.length ? null : h('p', { class: 'meta pad' }, lineup.channels.length ? 'No channels match.' : 'This output has no channels.'));
  };

  const loadOutput = async () => {
    stop();
    current = null;
    showMessage(null);
    fill(nowLine, h('span', { class: 'meta' }, 'Pick a channel to start watching.'));
    try {
      localStorage.setItem('iptvm.watchOutput', String(oid));
    } catch {}
    lineup = await api('GET', `/api/outputs/${oid}/lineup`);
    if (window.MediaSource) for (const c of lineup.channels) if (c.codecs?.convert) convertIds.add(c.id);
    drawList();
    if (lineup.paused) showMessage('This output is paused; resume it under Manage output to watch.', 'warn');
  };

  const select = h('select', { class: 'watch-output', title: 'Output', onchange: async (e) => { oid = Number(e.target.value); try { history.replaceState(null, '', `#/watch/${oid}`); } catch {} await loadOutput(); } },
    outputs.map((o) => h('option', { value: o.id, selected: o.id === oid }, o.name)));
  const search = h('input', { type: 'search', placeholder: 'Search channels or what\'s on', oninput: (e) => { q = e.target.value; drawList(); } });

  await loadOutput();
  // Wide screens: the page takes the whole window, the player all the height (see .watch-page).
  main.classList.add('watch-page');
  fill(main,
    h('div', { class: 'page-head' }, h('h1', null, 'Watch'), select),
    h('div', { class: 'watch' },
      h('section', { class: 'card watch-player' },
        stage,
        h('div', { class: 'watch-bar' },
          nowLine,
          h('span', { class: 'row' },
            h('button', { class: 'btn small', title: 'Previous channel', onclick: () => step(-1) }, '‹ Prev'),
            h('button', { class: 'btn small', title: 'Next channel', onclick: () => step(1) }, 'Next ›'),
            h('button', { class: 'btn small', title: 'Full screen (or double-click the picture)', onclick: fullscreen }, 'Full screen'),
            h('button', {
              class: 'btn small',
              title: 'Copy this channel\'s stream link, to play it in VLC or another player app',
              onclick: () => (current ? copy(`${lineup.stream_base}${current.id}.ts`) : toast('Pick a channel first')),
            }, 'Copy link'),
            h('button', { class: 'btn small', onclick: () => { wantPlaying = false; stop(); current = null; drawList(); fill(nowLine, h('span', { class: 'meta' }, 'Stopped.')); } }, 'Stop'))),
        message),
      h('section', { class: 'card flush watch-channels' }, h('div', { class: 'pad' }, search), list)));
  const start = channelId && lineup.channels.find((c) => c.id === channelId);
  if (start) play(start);
}

// --------------------------------------------------------------- settings --

async function settingsView(main) {
  const s = await api('GET', '/api/settings');
  const baseInput = h('input', { value: s.base_url, placeholder: s.detected_base_url });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  fill(main, 
    h('div', { class: 'page-head' }, h('h1', null, 'Settings')),
    h('section', { class: 'card narrow' },
      h('h2', null, 'Public address'),
      h('form', { class: 'form', onsubmit: async (e) => { e.preventDefault(); await attempt(() => api('PUT', '/api/settings', { base_url: baseInput.value }), 'Saved'); } },
        field('Base URL for published links', baseInput,
          `Used in playlist and stream URLs. Leave empty to use the address you browse with (currently ${s.detected_base_url}). Set it if apps reach this server by another name, or through a reverse proxy.`),
        h('button', { class: 'btn primary' }, 'Save'))),
    h('section', { class: 'card narrow' },
      h('h2', null, 'Admin password'),
      h('form', {
        class: 'form',
        onsubmit: async (e) => {
          e.preventDefault();
          await attempt(() => api('POST', '/api/password', { current: cur.value, next: next.value }), 'Password changed; other sessions were signed out');
          cur.value = next.value = '';
        },
      }, field('Current password', cur), field('New password', next, 'At least 8 characters.'), h('button', { class: 'btn primary' }, 'Change password')),
      h('div', { class: 'row sign-out-others' },
        h('button', {
          class: 'btn small',
          onclick: () => attempt(() => api('POST', '/api/sessions/revoke'), 'Other browsers and devices were signed out'),
        }, 'Sign out other devices'),
        h('span', { class: 'hint' }, 'Signs out every browser except this one, e.g. after using a shared or lost computer.'))),
    twoFactorCard(await api('GET', '/api/2fa')),
    updatesCard(await api('GET', '/api/updates')),
    alertsCard(s),
    widgetCard(s, (await api('GET', '/api/widget-key')).key),
    lightCard(s, await api('GET', '/api/light')),
    emptyEventCard(s),
    guidePatternsCard(s),
    backupCard(),
    advancedCard(s));
}

/**
 * Light streams: the 720p copies multi-view players (TileIPTV) switch side windows to. Shows
 * whether ffmpeg is there and which encoder runs, the light copies being made now, the encoder
 * choice and how many may run at once, and a short test encode.
 */
function lightCard(s, st) {
  const card = h('section', { class: 'card narrow' });
  const ENCODER_LABELS = { vaapi: 'Intel Quick Sync (VAAPI)', software: 'software (CPU)' };
  const encoder = h('select', null,
    [['auto', 'Auto: Intel Quick Sync when the GPU is reachable, else software'], ['vaapi', 'Intel Quick Sync (VAAPI)'], ['software', 'Software (CPU, about 1–2 cores per stream)']]
      .map(([v, l]) => h('option', { value: v, selected: s.light_encoder === v }, l)));
  const max = h('input', { type: 'number', min: 1, max: 16, value: s.light_max });
  const result = h('p', { class: 'hint' });
  const statusLine = () => (!st.ffmpeg
    ? h('p', { class: 'hint' }, h('b', { class: 'warn-text' }, 'ffmpeg is not installed on this server. '),
      'The Docker image includes it. On a Proxmox or other Debian install, run: ', h('code', null, 'apt install --no-install-recommends ffmpeg'), ', then reload this page (no restart needed).')
    : h('p', { class: 'hint' }, `ffmpeg ${st.ffmpeg} · encoding with ${ENCODER_LABELS[st.encoder] || st.encoder}`,
      st.setting === 'auto' && st.encoder === 'software' ? (st.device ? ' (the GPU is there but did not pass a test encode)' : ' (no GPU passed to this server)') : '',
      st.active.length ? ` · now making ${st.active.map((a) => `${a.channel} (${a.viewers})`).join(', ')}` : ' · none running now'));
  const draw = () => fill(card,
    h('h2', null, 'Light streams'),
    h('p', { class: 'hint' },
      'A 720p copy of a channel at up to 30 fps, made with ffmpeg only while it is watched. Multi-view players such as TileIPTV ',
      'switch side windows to it when a TV can\'t play several full channels at once. Turn it on for an output on its page.'),
    statusLine(),
    h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        await attempt(() => api('PUT', '/api/settings', { light_encoder: encoder.value, light_max: Number(max.value) }), 'Saved');
        st = await api('GET', '/api/light');
        draw();
      },
    },
    field('Encoder', encoder),
    field('At most at once', max, 'Each one is an ffmpeg and a connection to the provider (shared with anyone watching the same channel in full). Over this, players are told to keep the full stream.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary' }, 'Save'),
      h('button', {
        type: 'button',
        class: 'btn',
        disabled: !st.ffmpeg,
        onclick: async (e) => {
          e.target.disabled = true;
          fill(result, 'Encoding a few seconds of 1080p60…');
          try {
            const t = await api('POST', '/api/light/test', { encoder: encoder.value });
            fill(result, t.ok
              ? [h('b', null, 'Works. '), `${ENCODER_LABELS[t.encoder].replace(/^./, (c) => c.toUpperCase())}${t.speed ? ` at ${t.speed}× real time: roughly ${Math.max(1, Math.floor(t.speed))} light stream${Math.floor(t.speed) > 1 ? 's' : ''} at once.` : '.'}`]
              : [h('b', { class: 'warn-text' }, `${ENCODER_LABELS[t.encoder] || 'The encoder'} failed: `), t.error]);
          } finally {
            e.target.disabled = false;
          }
        },
      }, 'Test encoder'))),
    result);
  draw();
  return card;
}

/** Where to push alerts (a source that keeps failing, an expiring account, a guide that ran out). */
function alertsCard(s) {
  const type = h('select', null,
    [['', 'Off (dashboard only)'], ['ntfy', 'ntfy'], ['webhook', 'Webhook (JSON)']]
      .map(([v, l]) => h('option', { value: v, selected: s.notify_type === v }, l)));
  const url = h('input', { value: s.notify_url, placeholder: 'https://ntfy.sh/your-private-topic' });
  const sync = () => {
    url.parentElement.hidden = !type.value;
    url.placeholder = type.value === 'webhook' ? 'https://example.com/hooks/iptv' : 'https://ntfy.sh/your-private-topic';
  };
  type.addEventListener('change', sync);
  const save = () => attempt(() => api('PUT', '/api/settings', { notify_type: type.value, notify_url: url.value }), 'Saved');
  const card = h('section', { class: 'card narrow' },
    h('h2', null, 'Alerts'),
    h('p', { class: 'hint' },
      'Problems show on the dashboard: a source whose last 3 refreshes failed, an account expiring within 14 days, ',
      'or a guide with nothing airing on any channel. They can also be pushed to your phone with ntfy, or to a webhook: ',
      'once when a problem starts and once when it is resolved.'),
    h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
      field('Send alerts to', type),
      field('Address', url, 'For ntfy, a topic URL such as https://ntfy.sh/a-long-random-name (anyone who knows it can read it), or your own ntfy server.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary' }, 'Save'),
        h('button', {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            await save();
            await attempt(() => api('POST', '/api/alerts/test'), 'Test alert sent');
          },
        }, 'Send test'))));
  sync();
  return card;
}

/**
 * "Show advanced options" keeps rarely needed features out of the way. When it is on, this card
 * holds the advanced global switches, and outputs show their name cleanup section.
 */
function advancedCard(s) {
  const card = h('section', { class: 'card narrow' });
  const draw = () => {
    fill(card,
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: s.advanced,
          onchange: async (e) => {
            await attempt(() => api('PUT', '/api/settings', { advanced: e.target.checked }));
            s.advanced = e.target.checked;
            draw();
          },
        }),
        h('b', null, ' Show advanced options')),
      h('span', { class: 'hint' }, 'Extra features most setups don\'t need. Turning this off hides them again; anything already set up keeps working.'),
      s.advanced ? h('div', { class: 'advanced-box' },
        h('label', { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: s.guide_logo_fallback,
            onchange: (e) => attempt(() => api('PUT', '/api/settings', { guide_logo_fallback: e.target.checked }),
              e.target.checked ? 'Guide logos on' : 'Guide logos off').then(() => { s.guide_logo_fallback = e.target.checked; }),
          }),
          ' Use guide logos for channels without one'),
        h('span', { class: 'hint' }, 'When the provider gives a channel no logo, use the logo its guide lists (if any). Provider logos and your own always win.'),
        h('p', { class: 'hint' }, h('b', null, 'Name cleanup'), ' also appears on the page of each output, to tidy names like "US: Daily News ᴴᴰ" into "Daily News".')) : null);
  };
  draw();
  return card;
}

/**
 * Two-factor sign-in: an authenticator app's 6-digit code after the password. Setup shows a QR
 * code, confirms one code, then shows recovery codes once.
 */
function twoFactorCard(state) {
  const card = h('section', { class: 'card narrow' });
  const codeInput = (placeholder = '123456') => h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder, class: 'code-input', maxlength: 9 });
  const showRecovery = (codes) => fill(card,
    h('h2', null, 'Two-factor sign-in'),
    h('p', null, h('b', null, 'Save these recovery codes now. '), 'Each one signs you in once if you lose your phone. They won\'t be shown again.'),
    h('div', { class: 'recovery-codes mono' }, codes.map((c) => h('span', null, c))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => copy(codes.join('\n')) }, 'Copy codes'),
      h('button', { class: 'btn primary', onclick: async () => draw(await api('GET', '/api/2fa')) }, 'I\'ve saved them')));
  const draw = (s) => {
    if (!s.enabled) {
      fill(card,
        h('h2', null, 'Two-factor sign-in'),
        h('p', { class: 'hint' }, 'Off. Turn it on to also ask for a code from an authenticator app (Google or Microsoft Authenticator, 1Password, Bitwarden and the like) when signing in.'),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const setup = await attempt(() => api('POST', '/api/2fa/setup'));
            const code = codeInput();
            const qr = h('div', { class: 'qr' });
            qr.innerHTML = setup.qr_svg; // built by the server from the otpauth link
            fill(card,
              h('h2', null, 'Two-factor sign-in'),
              h('p', null, '1. Scan this with your authenticator app, or enter the key by hand.'),
              qr,
              h('div', { class: 'mono secret-key', title: 'Key for manual entry' }, setup.secret.match(/.{1,4}/g).join(' ')),
              h('form', {
                class: 'form',
                onsubmit: async (e) => {
                  e.preventDefault();
                  const r = await attempt(() => api('POST', '/api/2fa/enable', { code: code.value }), 'Two-factor sign-in is on; other sessions were signed out');
                  showRecovery(r.recovery_codes);
                },
              },
              field('2. Enter the code it shows', code),
              h('div', { class: 'row' },
                h('button', { class: 'btn primary' }, 'Turn on'),
                h('button', { class: 'btn', type: 'button', onclick: () => draw(s) }, 'Cancel'))));
            code.focus();
          },
        }, 'Set up two-factor sign-in'));
      return;
    }
    // Both actions need a current code, asked for only once one is chosen.
    const step = h('div');
    const ask = ({ label, hint, placeholder, button, cls, run }) => {
      const code = codeInput(placeholder);
      fill(step, h('form', {
        class: 'form two-factor-step',
        onsubmit: async (e) => {
          e.preventDefault();
          await run(code.value);
        },
      },
      field(label, code, hint),
      h('div', { class: 'row' },
        h('button', { class: `btn ${cls}` }, button),
        h('button', { class: 'btn', type: 'button', onclick: () => fill(step) }, 'Cancel'))));
      code.focus();
    };
    fill(card,
      h('h2', null, 'Two-factor sign-in'),
      h('p', null, badge('on', 'ok'), ` Signing in asks for a code from your authenticator app. ${s.recovery_left} recovery code${s.recovery_left === 1 ? '' : 's'} left.`),
      s.recovery_left < 3 ? h('p', { class: 'hint warn-text' }, 'Running low on recovery codes: make new ones.') : null,
      h('div', { class: 'row' },
        h('button', {
          class: 'btn',
          onclick: () => ask({
            label: 'Code from your authenticator app',
            hint: 'New codes replace the old ones, which stop working.',
            button: 'Make new recovery codes',
            cls: 'primary',
            run: async (c) => showRecovery((await attempt(() => api('POST', '/api/2fa/recovery', { code: c }), 'New recovery codes; the old ones no longer work')).recovery_codes),
          }),
        }, 'New recovery codes'),
        h('button', {
          class: 'btn danger-text',
          onclick: () => ask({
            label: 'Code from your authenticator app, or a recovery code',
            hint: 'Signing in will then only need the password.',
            placeholder: 'Code or recovery code',
            button: 'Turn off two-factor sign-in',
            cls: 'danger',
            run: async (c) => {
              await attempt(() => api('POST', '/api/2fa/disable', { code: c }), 'Two-factor sign-in is off');
              draw(await api('GET', '/api/2fa'));
            },
          }),
        }, 'Turn off')),
      step);
  };
  draw(state);
  return card;
}

/**
 * Dashboard widget: read-only numbers at /api/widget for Homepage (gethomepage.dev) and other
 * dashboards, with an API key of its own. Shows a ready-to-paste Homepage services.yaml entry.
 */
function widgetCard(s, key) {
  const card = h('section', { class: 'card narrow' });
  const base = (s.base_url || s.detected_base_url || location.origin).replace(/\/+$/, '');
  const yaml = (k) => [
    '- Simple IPTV Manager:',
    '    icon: mdi-television-classic',
    `    href: ${base}`,
    '    widget:',
    '      type: customapi',
    `      url: ${base}/api/widget`,
    '      refreshInterval: 10000',
    '      headers:',
    `        X-API-Key: ${k}`,
    '      mappings:',
    '        - field: watching',
    '          label: Watching',
    '          format: number',
    '        - field: channels',
    '          label: Channels',
    '          format: number',
    '        - field: sources_ok',
    '          label: Sources OK',
    '          format: number',
    '        - field: alerts',
    '          label: Alerts',
    '          format: number',
  ].join('\n');
  const listYaml = (k) => [
    '- Watching now:',
    '    icon: mdi-play-network',
    `    href: ${base}`,
    '    widget:',
    '      type: customapi',
    `      url: ${base}/api/widget`,
    '      refreshInterval: 5000',
    '      headers:',
    `        X-API-Key: ${k}`,
    '      display: dynamic-list',
    '      mappings:',
    '        items: watching_list',
    '        name: name',
    '        label: label',
  ].join('\n');
  const snippet = (title, text) => h('div', { class: 'widget-snippet' },
    h('div', { class: 'row' }, h('b', null, title), h('button', { class: 'btn small', onclick: () => copy(text) }, 'Copy')),
    h('pre', { class: 'mono' }, text));
  const draw = (k) => {
    fill(card,
      h('h2', null, 'Dashboard widget'),
      !k ? [
        h('p', { class: 'hint' }, 'Show this server\'s numbers (streams watching now, channels, sources, alerts) on a dashboard such as ',
          h('a', { href: 'https://gethomepage.dev/widgets/services/customapi/', target: '_blank', rel: 'noopener' }, 'Homepage'),
          '. It gets an API key of its own, which can only read these numbers.'),
        h('button', { class: 'btn primary', onclick: async () => draw((await attempt(() => api('POST', '/api/widget-key'), 'Widget API on')).key) }, 'Turn on'),
      ] : [
        h('p', { class: 'hint' }, `Read-only numbers at ${base}/api/widget, with this key in an X-API-Key header. The key only reads these numbers.`),
        copyField('API key', k),
        snippet('Homepage services.yaml: four numbers', yaml(k)),
        h('details', null, h('summary', null, 'Or a list of who is watching what'), snippet('Homepage services.yaml: watching now', listYaml(k))),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn small',
            onclick: async () => {
              if (!(await confirmBox('Make a new key? Dashboards using the current one stop updating until you give them the new one.', 'New key'))) return;
              draw((await attempt(() => api('POST', '/api/widget-key'), 'New key made')).key);
            },
          }, 'New key'),
          h('button', {
            class: 'btn small danger-text',
            onclick: async () => {
              if (!(await confirmBox('Turn off the widget API? Dashboards using it stop updating.', 'Turn off'))) return;
              await attempt(() => api('DELETE', '/api/widget-key'), 'Widget API off');
              draw(null);
            },
          }, 'Turn off')),
      ]);
  };
  draw(key);
  return card;
}

// Functions, so each render gets its own nodes.
const HOW_TO_UPDATE = {
  docker: () => ['In Portainer, open the stack and click ', h('b', null, 'Pull and redeploy'),
    ' (or turn on GitOps updates). With Docker Compose: ', h('code', null, 'git pull && docker compose up -d --build'), '.'],
  proxmox: () => ['On the Proxmox host run ', h('code', null, 'pct exec <container id> -- iptv-manager-update'),
    ', or turn on nightly updates with ', h('code', null, 'iptv-manager-update --enable-auto'), '.'],
  other: () => ['Run ', h('code', null, 'git pull'), ' in the app folder, then restart the app.'],
};

const UPDATE_RESULTS = {
  updated: ['ok', 'Updated'],
  current: ['ok', 'Already up to date'],
  skipped: ['warn', 'Skipped'],
  rolled_back: ['warn', 'Rolled back'],
  failed: ['error', 'Failed'],
};

function updatesCard(initial) {
  const card = h('section', { class: 'card narrow' });
  let watching = null; // { since, timer } while following an update

  // Follow an update through the app restart; reload into the new version when it is done.
  const follow = (since) => {
    if (watching) return;
    const started = Date.now();
    watching = { since, timer: setInterval(async () => {
      let u;
      try {
        u = await api('GET', '/api/updates');
      } catch {
        return; // the app is restarting
      }
      const wu = u.web_update;
      const done = !wu.busy && wu.status && wu.status.state !== 'running' && (wu.status.started_at || 0) >= since - 5;
      if (done || Date.now() - started > 10 * 60_000) {
        clearInterval(watching.timer);
        watching = null;
        if (wu.status?.state === 'updated') {
          toast('Updated; reloading');
          setTimeout(() => location.reload(), 800);
          return;
        }
      }
      draw(u);
    }, 2000) };
  };

  const webUpdate = (u) => {
    const wu = u.web_update || {};
    if (!wu.available) {
      return u.install_type === 'proxmox'
        ? h('p', { class: 'hint' }, 'To update from here, run this once on the Proxmox host: ',
          h('code', null, 'pct exec <container id> -- iptv-manager-update --setup'))
        : null;
    }
    const st = wu.status;
    if (wu.busy) {
      return h('div', { class: 'update-progress' },
        h('p', null, h('span', { class: 'spinner' }), ' ', h('b', null, wu.pending ? 'Update requested, starting…' : st?.message || 'Updating…')),
        wu.log?.length ? h('pre', { class: 'update-log' }, wu.log.join('\n')) : null,
        h('p', { class: 'hint' }, 'The app restarts during the update; this page reconnects and reloads by itself.'));
    }
    const recent = st && st.finished_at && Date.now() / 1000 - st.finished_at < 86400;
    const [kind, label] = UPDATE_RESULTS[st?.state] || [];
    return recent && label ? h('p', null, badge(label, kind), ' ', h('span', { class: 'meta' }, `${st.message} (${ago(st.finished_at)})`)) : null;
  };

  // "Update automatically every night at HH:MM": carried out by the root updater, which confirms
  // through auto.json; the switch waits for that confirmation.
  const nightly = (u) => {
    const wu = u.web_update || {};
    if (!wu.available) return null;
    const a = wu.auto;
    const time = h('input', { type: 'time', class: 'time-input', value: a?.at || '04:00' });
    const box = h('input', { type: 'checkbox', checked: !!a?.enabled });
    const apply = async (enabled) => {
      box.disabled = time.disabled = true;
      try {
        await attempt(() => api('POST', '/api/updates/auto', { enabled, at: time.value }));
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const r = await api('GET', '/api/updates');
          const now = r.web_update.auto;
          if (now && now.enabled === enabled && (!enabled || now.at === time.value)) {
            toast(enabled ? `Nightly updates at ${time.value}` : 'Nightly updates off');
            draw(r);
            return;
          }
        }
        toast('The updater has not confirmed the change yet; check again in a minute', 'error');
      } catch {
        box.checked = !enabled;
      } finally {
        box.disabled = time.disabled = false;
      }
    };
    box.addEventListener('change', () => apply(box.checked));
    time.addEventListener('change', () => { if (box.checked) apply(true); });
    return h('div', { class: 'check nightly' }, box, h('span', null, ' Update automatically every night at '), time,
      h('span', { class: 'meta' }, ' (plus up to 30 min random delay)'));
  };

  // Sits in the action row next to "Check now".
  const updateButton = (u) => {
    const wu = u.web_update || {};
    if (!wu.available || wu.busy || !(u.behind > 0)) return null;
    return h('button', {
      class: 'btn primary',
      onclick: async (e) => {
        if (!(await confirmBox('Install the update now? The app restarts, which takes up to about a minute; streams playing through it drop briefly. If the new version fails to start, the current one is restored automatically.', 'Update now'))) return;
        e.target.disabled = true;
        const since = Math.floor(Date.now() / 1000);
        try {
          draw(await attempt(() => api('POST', '/api/updates/apply')));
          follow(since);
        } catch {
          e.target.disabled = false;
        }
      },
    }, 'Update now');
  };

  const draw = (u) => {
    const gh = (sha) => `https://github.com/${u.repo}/commit/${sha}`;
    const short = (sha) => (sha ? sha.slice(0, 7) : 'unknown');
    const date = (d) => (d ? new Date(d).toLocaleDateString() : '');
    const canApply = u.web_update?.available;
    let status;
    if (!u.checked_at) status = h('p', { class: 'meta' }, 'Not checked yet.');
    else if (u.behind > 0) {
      status = h('div', null,
        h('p', { class: 'update-available' }, `Update available: ${u.behind} new change${u.behind === 1 ? '' : 's'}.`),
        h('ul', { class: 'commit-list' }, u.commits.map((c) => h('li', null,
          h('a', { href: gh(c.sha), target: '_blank', rel: 'noopener' }, c.message), ' ', h('span', { class: 'meta' }, date(c.date))))),
        canApply ? null : h('p', { class: 'hint' }, (HOW_TO_UPDATE[u.install_type] || HOW_TO_UPDATE.other)()));
    } else if (u.behind === 0) status = h('p', null, badge('Up to date', 'ok'), ' ', h('span', { class: 'meta' }, u.note || ''));
    else status = h('p', { class: 'meta' }, u.note || 'Could not compare versions.');
    if (u.web_update?.busy && !watching) follow(u.web_update.status?.started_at || Math.floor(Date.now() / 1000));
    // Just updated: the server re-checks against the new version within seconds; pick that up.
    if (u.checking && !watching && (card._recheck || 0) < 5) {
      card._recheck = (card._recheck || 0) + 1;
      setTimeout(async () => {
        if (!card.isConnected) return;
        try {
          const r = await api('GET', '/api/updates');
          draw(r);
          updateBadge(r);
        } catch {}
      }, 4000);
    }
    fill(card,
      h('h2', null, 'Version & updates'),
      h('p', null, `Simple IPTV Manager ${u.version} · `,
        u.commit ? h('a', { href: gh(u.commit), target: '_blank', rel: 'noopener', class: 'mono' }, short(u.commit)) : h('span', { class: 'meta' }, 'commit unknown')),
      status,
      webUpdate(u),
      u.error ? h('p', { class: 'form-error' }, `Last check failed: ${u.error}`) : null,
      h('div', { class: 'row update-actions' },
        updateButton(u),
        h('button', {
          class: 'btn',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await attempt(() => api('POST', '/api/updates/check'));
              draw(r);
              updateBadge(r);
            } finally {
              e.target.disabled = false;
            }
          },
        }, 'Check now'),
        u.checked_at ? h('span', { class: 'meta' }, `Last checked ${ago(u.checked_at)}`) : null),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: u.enabled,
          onchange: (e) => attempt(() => api('PUT', '/api/settings', { update_check: e.target.checked }), e.target.checked ? 'Daily check on' : 'Daily check off'),
        }),
        ` Check GitHub (${u.repo}) for updates once a day`),
      nightly(u),
      h('p', { class: 'hint' }, u.web_update?.available
        ? 'Update now runs the same updater as iptv-manager-update in the container, including its automatic rollback.'
        : 'The check only reports new versions; updating is done the way this copy was installed.'));
  };
  draw(initial);
  return card;
}

// Top-bar "Update available" link, refreshed from the cached check at most every few minutes.
let badgeFetchedAt = 0;
function updateBadge(u) {
  const el = shell?.header.querySelector('.update-badge');
  if (!el) return;
  el.hidden = !(u && u.behind > 0);
  el.title = u && u.behind > 0 ? `${u.behind} new change${u.behind === 1 ? '' : 's'} on GitHub` : '';
}
async function refreshUpdateBadge() {
  if (Date.now() - badgeFetchedAt < 5 * 60_000) return;
  badgeFetchedAt = Date.now();
  try {
    updateBadge(await api('GET', '/api/updates'));
  } catch {}
}

/**
 * Plain-English reading of a simple pattern: an anchor (^ … / … $, with optional \s*)
 * around a literal or a digit class. Anything more elaborate is called a custom pattern.
 */
function describePattern(p) {
  let s = String(p || '').trim();
  if (!s) return 'type a pattern';
  try {
    new RegExp(s, 'i');
  } catch {
    return 'not a valid pattern';
  }
  const start = s.startsWith('^');
  if (start) s = s.slice(1).replace(/^\\s\*/, '');
  const endRe = /(?:\\s\*)?\$$/;
  const end = endRe.test(s);
  if (end) s = s.replace(endRe, '');
  const where = start && end ? 'is' : start ? 'starts with' : end ? 'ends with' : 'contains';
  if (/^(?:\\d|\[0-9\])(?:\+|\{1,\})?$/.test(s)) return `${where} a number`;
  if (s && /^(?:\\[^\w\s]|[^\\^$.*+?()[\]{}|])+$/.test(s)) {
    return `${where === 'is' ? 'is exactly' : where} "${s.replace(/\\(.)/g, '$1')}"`;
  }
  return 'custom pattern';
}

/** Settings card for the name patterns behind "Hide empty event channels". */
function emptyEventCard(s) {
  return patternsCard({
    title: 'Empty event channels',
    key: 'empty_event_patterns',
    patterns: s.empty_event_patterns,
    defaults: s.empty_event_defaults,
    tryPlaceholder: 'Try a channel name, e.g. Event 03:',
    intro: ['Event providers keep placeholder channels, such as "Event 03:" or "Live 12 NO EVENT", that only carry something when an event is scheduled. ',
      'Turn on "Hide empty event channels" in an expanded category of an output to hide the placeholders. ',
      'A channel counts as empty when its name matches any pattern below (regular expressions, case-insensitive).'],
    note: ['Note: "ends with a number" also hides a live event whose title ends in a number, e.g. "Event 01: Final 2026". ',
      'Replacing it with ^[^:]*\\d\\s*$ only counts names without a ":" as empty.'],
  });
}

/** Settings card for the guide-title patterns behind "Hide channels by guide". */
function guidePatternsCard(s) {
  return patternsCard({
    title: 'Guide placeholders',
    key: 'guide_patterns',
    patterns: s.guide_patterns,
    defaults: s.guide_defaults,
    tryPlaceholder: 'Try a program title, e.g. No Game Today',
    intro: ['Some event channels always have a name, but their guide says "No Game Today" or "Off Air" while nothing is on. ',
      'Turn on "Hide channels by guide" in an expanded category of an output to hide them until a real listing starts. ',
      'A channel counts as empty while the title of the program on now matches any pattern below (case-insensitive).'],
    note: null,
  });
}

/** Editable list of case-insensitive regular expressions stored in one setting. */
function patternsCard({ title, key, patterns: initial, defaults, tryPlaceholder, intro, note }) {
  let patterns = [...initial];
  const list = h('div', { class: 'form' });
  const testInput = h('input', { placeholder: tryPlaceholder });
  const testResult = h('span', { class: 'pattern-result' });
  const runTest = () => {
    const name = testInput.value;
    if (!name) return (testResult.textContent = '');
    const hit = patterns.find((p) => {
      try {
        return new RegExp(p, 'i').test(name);
      } catch {
        return false;
      }
    });
    testResult.className = `pattern-result ${hit ? 'empty' : 'kept'}`;
    testResult.textContent = hit ? `Empty: ${describePattern(hit)}` : 'Not empty: kept';
  };
  const draw = () => {
    fill(list,
      patterns.map((p, i) => {
        const desc = h('span', { class: 'pattern-desc', title: describePattern(p) }, describePattern(p));
        return h('div', { class: 'pattern-row' },
          h('input', {
            value: p,
            spellcheck: 'false',
            oninput: (e) => {
              patterns[i] = e.target.value;
              desc.textContent = desc.title = describePattern(e.target.value);
              runTest();
            },
          }),
          desc,
          h('button', { class: 'icon-btn', title: 'Remove pattern', onclick: () => { patterns.splice(i, 1); draw(); runTest(); } }, '✕'));
      }),
      patterns.length ? null : h('p', { class: 'meta' }, 'No patterns: the toggle hides nothing until you add one.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { patterns.push(''); draw(); [...list.querySelectorAll('input')].pop()?.focus(); } }, '+ Add pattern'),
        h('button', { class: 'btn small', onclick: () => { patterns = [...defaults]; draw(); runTest(); } }, 'Restore defaults'),
        h('button', {
          class: 'btn small primary',
          onclick: async () => {
            // Saving exactly the defaults stores "defaults", so later default changes still apply.
            const isDefault = JSON.stringify(patterns) === JSON.stringify(defaults);
            const r = await attempt(() => api('PUT', '/api/settings', { [key]: isDefault ? null : patterns.filter((p) => p.trim()) }), 'Patterns saved');
            patterns = [...r[key]];
            draw();
          },
        }, 'Save patterns')));
  };
  testInput.addEventListener('input', runTest);
  draw();
  return h('section', { class: 'card narrow' },
    h('h2', null, title),
    h('p', { class: 'hint' }, intro),
    list,
    h('div', { class: 'pattern-test' }, testInput, testResult),
    note ? h('p', { class: 'hint' }, note) : null);
}

function backupCard() {
  const secrets = h('input', { type: 'checkbox', checked: true });
  const file = h('input', { type: 'file', accept: '.json,application/json' });

  const exportNow = async () => {
    const res = await fetch(`/api/export?secrets=${secrets.checked ? 1 : 0}`);
    if (!res.ok) return toast(`Export failed (${res.status})`, 'error');
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'iptv-manager-settings.json';
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importNow = async () => {
    const f = file.files[0];
    if (!f) return toast('Choose a settings file first', 'error');
    let data;
    try {
      data = JSON.parse(await f.text());
    } catch {
      return toast('That file is not valid JSON', 'error');
    }
    const counts = `${data.sources?.length ?? 0} sources and ${data.outputs?.length ?? 0} outputs`;
    const warn = data.includes_secrets === false ? ' This file has no provider passwords, so you will need to re-enter them.' : '';
    if (!(await confirmBox(`Replace ALL current sources and outputs with the ${counts} in "${f.name}"? This cannot be undone. Export first if you want a copy of the current setup.${warn}`, 'Replace and import'))) return;
    const r = await attempt(() => api('POST', '/api/import', data));
    toast(`Imported ${r.sources} sources and ${r.outputs} outputs; refreshing sources now`);
    location.hash = '#/sources';
  };

  return h('section', { class: 'card narrow' },
    h('h2', null, 'Backup & restore'),
    h('div', { class: 'form' },
      h('p', { class: 'hint' },
        'The export holds your sources, outputs, filter rules, category and channel picks, channel edits, Jellyfin tags and output URLs. ',
        'It does not hold the downloaded playlists and guides, which are fetched again after an import, or uploaded playlist files. ',
        'Your admin password is never included.'),
      h('label', { class: 'check' }, secrets, ' Include provider passwords and output logins'),
      h('span', { class: 'hint' }, 'The file then contains credentials, so store it somewhere safe.'),
      h('div', null, h('button', { class: 'btn primary', onclick: exportNow }, 'Export settings')),
      h('hr', { class: 'sep' }),
      field('Import a settings file', file, 'Importing replaces every source and output here with the ones in the file. Output URLs and logins stay the same, so your apps keep working.'),
      h('div', null, h('button', { class: 'btn danger', onclick: importNow }, 'Import and replace…')),
      h('hr', { class: 'sep' }),
      autoBackups()));
}

/** Daily copies saved on the server: a switch, "Back up now", and the list tucked in a <details>. */
function autoBackups() {
  const box = h('div', { class: 'auto-backups' });
  const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const draw = (b) => {
    fill(box,
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: b.enabled,
          onchange: (e) => attempt(() => api('PUT', '/api/settings', { auto_backup: e.target.checked }), e.target.checked ? 'Daily backups on' : 'Daily backups off'),
        }),
        h('b', null, ' Save a backup automatically every day')),
      h('span', { class: 'hint' }, `Kept on this server in its data folder (the last ${b.keep}), including provider passwords, like the database next to them.`),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: async () => draw({ ...b, ...(await attempt(() => api('POST', '/api/backups'), 'Backup saved')) }) }, 'Back up now'),
        b.files[0] ? h('span', { class: 'meta' }, `Latest: ${b.files[0].date}`) : h('span', { class: 'meta' }, 'None saved yet')),
      b.files.length ? h('details', null,
        h('summary', null, `Saved backups (${b.files.length})`),
        h('div', { class: 'backup-list' }, b.files.map((f) => h('div', { class: 'backup-row' },
          h('span', null, f.date), h('span', { class: 'meta' }, fmtSize(f.size)),
          h('a', { class: 'btn small', href: `/api/backups/${f.name}`, download: `iptv-manager-${f.name}` }, 'Download'),
          h('button', {
            class: 'btn small danger-text',
            onclick: async () => {
              if (!(await confirmBox(`Restore the backup from ${f.date}? Every source and output is replaced with the ones in it, then the sources refresh.`, 'Restore'))) return;
              const r = await attempt(() => api('POST', `/api/backups/${f.name}/restore`));
              toast(`Restored ${r.sources} sources and ${r.outputs} outputs; refreshing sources now`);
              location.hash = '#/sources';
            },
          }, 'Restore'))))) : null);
  };
  api('GET', '/api/backups').then(draw).catch(() => {});
  return box;
}

window.addEventListener('hashchange', route);
route();
