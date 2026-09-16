import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { SessionSnapshot, FleetSnapshot } from '../shared/protocol.ts';

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as T;
}

const stage = required<HTMLElement>('stage');
const rail = required<HTMLElement>('rail');
const titleEl = required<HTMLElement>('title');
const reasonEl = required<HTMLElement>('reason');
const dotEl = required<HTMLElement>('dot');
const emptyEl = required<HTMLElement>('empty');
const toastEl = required<HTMLElement>('toast');
const pinBtn = required<HTMLButtonElement>('pin');
const leaveBtn = required<HTMLButtonElement>('leave');

interface TermEntry {
  readonly term: Terminal;
  readonly el: HTMLDivElement;
}

const terms = new Map<string, TermEntry>(); // paneId -> { term, el }
let state: FleetSnapshot = { sessions: [], focused: null, pinned: false, lastSwitch: null };
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
  term.onData((data) => window.fleet.input(paneId, data));

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
  reasonEl.textContent = focused ? `${focused.clsLabel} · ${focused.reason}` : '';
  dotEl.className = `dot ${focused ? focused.state : ''}`;
  pinBtn.classList.toggle('on', state.pinned);
  pinBtn.textContent = state.pinned ? 'épinglé' : 'épingler';

  const others = state.sessions.filter((s) => s.uuid !== state.focused);
  rail.replaceChildren(
    ...others.map((s) => {
      const chip = document.createElement('div');
      chip.className = 'chip' + (s.rank >= 0 ? ' claiming' : '');
      chip.innerHTML =
        `<span class="dot ${s.state}"></span>` +
        `<span><span class="name">${s.label}</span>` +
        `<div class="sub">${s.clsLabel} · ${elapsed(s.since)}</div></span>` +
        (s.rank >= 0 ? `<span class="rank">#${s.rank + 1}</span>` : '');
      chip.onclick = () => window.fleet.focus(s.uuid);
      return chip;
    })
  );
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

pinBtn.onclick = () => window.fleet.pin(!state.pinned);
leaveBtn.onclick = () => window.fleet.leave();
window.addEventListener('resize', applyGeometry);
setInterval(render, 1000); // keeps the rail's elapsed times honest

window.fleet.ready().then((s) => {
  state = s;
  applyGeometry();
  render();
});
