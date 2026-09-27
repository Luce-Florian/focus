import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { AgentId, SessionSnapshot, FleetSnapshot, Importance } from '../shared/protocol.ts';
import { IMPORTANCE, IMPORTANCE_LABEL } from '../shared/protocol.ts';

function required(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el;
}

function requiredAs<T extends HTMLElement>(id: string, ctor: abstract new () => T): T {
  const el = required(id);
  if (!(el instanceof ctor)) throw new Error(`#${id} is not a ${ctor.name}`);
  return el;
}

const stage = required('stage');
const rail = required('rail');
const titleEl = required('title');
const reasonEl = required('reason');
const dotEl = required('dot');
const emptyEl = required('empty');
const toastEl = required('toast');
const leaveBtn = required('leave');
const newBtn = required('new');

const dlg = requiredAs('create', HTMLDialogElement);
const form = requiredAs('create-form', HTMLFormElement);
const cwdInput = requiredAs('cwd', HTMLInputElement);
const labelInput = requiredAs('label', HTMLInputElement);
const promptInput = requiredAs('prompt', HTMLTextAreaElement);
const agentSelect = requiredAs('agent', HTMLSelectElement);
const modelSelect = requiredAs('model', HTMLSelectElement);
const importanceSelect = requiredAs('importance', HTMLSelectElement);
const errorEl = required('create-error');
const browseBtn = required('browse');
const cancelBtn = required('cancel');
const submitBtn = requiredAs('submit', HTMLButtonElement);

interface TermEntry {
  readonly term: Terminal;
  readonly el: HTMLDivElement;
}

const terms = new Map<string, TermEntry>(); // paneId -> { term, el }
let state: FleetSnapshot = { sessions: [], focused: null, lastSwitch: null };
let geometry = { cols: 100, rows: 30 };
let shownPane: string | null = null;
let lastSwitchAt = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function makeTerm(paneId: string): TermEntry {
  const el = document.createElement('div');
  el.className = 'term';
  el.hidden = true;
  stage.appendChild(el);

  const term = new Terminal({
    fontFamily: 'Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0d0d11', foreground: '#d6d6e0' }
  });
  term.open(el);
  term.resize(geometry.cols, geometry.rows);
  term.onData((data) => { window.fleet.input(paneId, data); });

  const entry: TermEntry = { term, el };
  terms.set(paneId, entry);
  return entry;
}

window.fleet.onOutput((paneId, bytes) => {
  // Every pane is rendered continuously, focused or not: switching is a
  // visibility toggle, never a replay.
  const entry = terms.get(paneId) ?? makeTerm(paneId);
  entry.term.write(new Uint8Array(bytes));
});

const sessionOf = (uuid: string | null): SessionSnapshot | null =>
  state.sessions.find((s) => s.uuid === uuid) ?? null;

/** low → normal → high → low: one click, one step. */
const nextImportance = (level: Importance): Importance =>
  level === IMPORTANCE.LOW ? IMPORTANCE.NORMAL : level === IMPORTANCE.NORMAL ? IMPORTANCE.HIGH : IMPORTANCE.LOW;

const IMPORTANCE_MARK: Record<Importance, string> = {
  [IMPORTANCE.LOW]: '↓',
  [IMPORTANCE.NORMAL]: '·',
  [IMPORTANCE.HIGH]: '↑'
};

function elapsed(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2600);
}

function render(): void {
  const focused = sessionOf(state.focused);
  const pane = focused ? focused.paneId : null;

  for (const [paneId, entry] of terms) {
    const show = paneId === pane;
    if (show === !entry.el.hidden) continue;
    entry.el.hidden = !show;
  }
  if (pane !== shownPane) {
    shownPane = pane;
    const entry = pane ? terms.get(pane) : null;
    if (entry) {
      entry.term.refresh(0, entry.term.rows - 1);
      entry.term.focus();
    }
  }
  emptyEl.hidden = Boolean(pane);

  titleEl.textContent = focused ? focused.label : '—';
  titleEl.title = focused ? tooltip(focused) : '';
  reasonEl.textContent = focused ? `${focused.clsLabel} · ${focused.reason}` : '';
  dotEl.className = `dot ${focused ? focused.state : ''}`;

  const others = state.sessions.filter((s) => s.uuid !== state.focused);
  rail.replaceChildren(...others.map(chipFor));
}

/**
 * Labels, prompts and summaries are human input now, not constants from
 * config.ts: every one of them goes in as text, never as markup.
 */
function chipFor(s: SessionSnapshot): HTMLDivElement {
  const chip = document.createElement('div');
  chip.className = 'chip' + (s.rank >= 0 ? ' claiming' : '');
  chip.title = tooltip(s);

  const dot = document.createElement('span');
  dot.className = `dot ${s.state}`;

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.label;

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${s.clsLabel} · ${elapsed(s.since)}`;

  const body = document.createElement('span');
  body.append(name, sub);

  // Cycle button: the click changes the level, it must not focus the chip.
  const imp = document.createElement('button');
  imp.type = 'button';
  imp.className = `imp imp-${s.importanceLabel}`;
  imp.textContent = IMPORTANCE_MARK[s.importance];
  imp.title = `importance ${IMPORTANCE_LABEL[s.importance]} — cliquer pour changer`;
  imp.onclick = (e) => {
    e.stopPropagation();
    window.fleet.setImportance(s.uuid, nextImportance(s.importance));
  };

  chip.append(dot, body, imp);

  if (s.rank >= 0) {
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${s.rank + 1}`;
    chip.append(rank);
  }

  chip.onclick = () => { window.fleet.focus(s.uuid); };
  return chip;
}

/** The summary when the out-of-band pass answered, else the raw prompt. */
function tooltip(s: SessionSnapshot): string {
  return [s.summary ?? s.prompt, s.cwd].filter((x) => x !== null && x !== '').join('\n');
}

function applyGeometry(): void {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;font:13px Menlo,monospace;white-space:pre';
  probe.textContent = 'W'.repeat(100);
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  const cellW = rect.width / 100;
  const cellH = rect.height;
  probe.remove();

  const box = stage.getBoundingClientRect();
  const cols = Math.max(40, Math.floor((box.width - 16) / cellW));
  const rows = Math.max(10, Math.floor((box.height - 12) / cellH));
  if (cols === geometry.cols && rows === geometry.rows) return;
  geometry = { cols, rows };
  for (const { term } of terms.values()) term.resize(cols, rows);
  window.fleet.resize(cols, rows);
}

window.fleet.onState((s) => {
  const previous = state.focused;
  state = s;
  if (s.lastSwitch && s.lastSwitch.at !== lastSwitchAt) {
    lastSwitchAt = s.lastSwitch.at;
    const target = sessionOf(s.lastSwitch.to);
    // Announce every jump: the view moved on its own, say why.
    if (previous && target && s.lastSwitch.from) toast(`→ ${target.label} · ${s.lastSwitch.reason}`);
  }
  render();
});

// ---- creation ----

/** Each agent carries its own model list; picking one refreshes the other. */
async function loadModels(): Promise<void> {
  const models = await window.fleet.models(agentSelect.value as AgentId);
  modelSelect.replaceChildren(...models.map((m) => new Option(m.label, m.id)));
}

async function openCreate(): Promise<void> {
  if (agentSelect.options.length === 0) {
    const agents = await window.fleet.agents();
    agentSelect.replaceChildren(...agents.map((a) => new Option(a.label, a.id)));
    await loadModels();
  }
  errorEl.hidden = true;
  submitBtn.disabled = false;
  dlg.showModal();
  browseBtn.focus();
}

function fail(message: string): void {
  errorEl.textContent = message;
  errorEl.hidden = false;
  submitBtn.disabled = false;
}

browseBtn.onclick = () => {
  void window.fleet.pickDir().then((dir) => {
    if (dir === null) return;
    cwdInput.value = dir;
    // The directory name is the obvious label; the human overrides it or not.
    if (!labelInput.value.trim()) labelInput.placeholder = dir.split('/').filter(Boolean).pop() ?? dir;
  });
};

cancelBtn.onclick = () => { dlg.close(); };

agentSelect.onchange = () => { void loadModels(); };

form.onsubmit = (e) => {
  e.preventDefault();
  if (!cwdInput.value) {
    fail('choisis un répertoire de travail');
    return;
  }
  submitBtn.disabled = true;
  errorEl.hidden = true;
  void window.fleet
    .create({
      cwd: cwdInput.value,
      label: labelInput.value,
      prompt: promptInput.value,
      agent: agentSelect.value as AgentId,
      model: modelSelect.value,
      importance: Number.parseInt(importanceSelect.value, 10) as Importance
    })
    .then((r) => {
      if (!r.ok) {
        fail(r.error);
        return;
      }
      form.reset();
      cwdInput.value = '';
      labelInput.placeholder = 'nom du répertoire';
      // `reset()` puts the agent back to the first option: the model list on
      // screen still belongs to the agent that was picked, so refresh it.
      void loadModels();
      dlg.close();
    });
};

newBtn.onclick = () => { void openCreate(); };
window.fleet.onNotice(toast);
leaveBtn.onclick = () => { window.fleet.leave(); };
window.addEventListener('resize', applyGeometry);
setInterval(render, 1000); // keeps the rail's elapsed times honest

void window.fleet.ready().then((s) => {
  state = s;
  applyGeometry();
  render();
});
