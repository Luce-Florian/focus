'use strict';

const { EventEmitter } = require('node:events');

/**
 * Attention classes. Focus always goes to the highest class on screen.
 * Class 0 means "this session needs nothing from the human": it is background
 * work and must never occupy the foreground while something else is waiting.
 */
const CLS = {
  GONE: -1,
  RUNNING: 0,      // working on its own
  IDLE: 1,         // turn finished, awaiting the next instruction
  WAIT_INPUT: 2,   // Notification: idle nudge
  WAIT_PERM: 3     // Notification: blocking permission prompt
};

const STATES = {
  BOOTING: 'booting',
  RUNNING: 'running',
  WAITING_PERM: 'waiting_perm',
  WAITING_INPUT: 'waiting_input',
  IDLE: 'idle',
  GONE: 'gone'
};

const STATE_CLASS = {
  [STATES.BOOTING]: CLS.RUNNING,
  [STATES.RUNNING]: CLS.RUNNING,
  [STATES.IDLE]: CLS.IDLE,
  [STATES.WAITING_INPUT]: CLS.WAIT_INPUT,
  [STATES.WAITING_PERM]: CLS.WAIT_PERM,
  [STATES.GONE]: CLS.GONE
};

const CLASS_LABEL = {
  [CLS.WAIT_PERM]: 'permission',
  [CLS.WAIT_INPUT]: 'attente',
  [CLS.IDLE]: 'tour terminé',
  [CLS.RUNNING]: 'travaille',
  [CLS.GONE]: 'terminée'
};

// Proof that the session moved on by itself: its claim on the human is stale.
const PROGRESS_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

const DEFAULTS = {
  // Do not yank the view away while the human is mid-keystroke.
  typingGraceMs: 2500,
  // Minimum time on a session before an automatic switch may fire again.
  dwellMs: 1200,
  // A manual pick is respected for a while, even if something louder arrives.
  manualStickyMs: 10000
};

function classifyNotification(payload) {
  const message = String(payload.message || '');
  if (/waiting for your input/i.test(message)) {
    return { state: STATES.WAITING_INPUT, reason: message || 'en attente de saisie' };
  }
  return { state: STATES.WAITING_PERM, reason: message || 'permission demandée' };
}

/**
 * Attention arbiter.
 *
 * The human never navigates. Focus lands on the session with the highest
 * attention class and moves on its own as classes change. Two invariants keep
 * that from turning into flicker:
 *
 *   - a session the human is being asked something by is never preempted by an
 *     equal claim (ties keep the incumbent);
 *   - recent typing, a recent switch, a manual pick or a pin all defer the move
 *     rather than cancel it; the decision is replayed when the guard expires.
 */
class Arbiter extends EventEmitter {
  constructor({ store, now = () => Date.now(), schedule = setTimeout, options = {} } = {}) {
    super();
    this.store = store;
    this.now = now;
    this.schedule = schedule;
    this.opt = { ...DEFAULTS, ...options };

    this.sessions = new Map();
    this.focused = null;
    this.pinned = false;
    this.stickyUntil = 0;
    this.lastSwitchAt = 0;
    this.lastInputAt = 0;
    this.lastSwitch = null;
    this._timer = null;
  }

  register(session) {
    const ts = this.now();
    const rec = {
      uuid: session.uuid,
      label: session.label,
      cwd: session.cwd,
      paneId: session.paneId,
      windowId: session.windowId,
      state: STATES.BOOTING,
      reason: 'démarrage',
      since: ts,
      lastEvent: null,
      updatedAt: ts
    };
    this.sessions.set(rec.uuid, rec);
    this.store.insertSession({ ...rec, createdAt: ts });
    if (this.focused === null) this._switchTo(rec.uuid, 'première session', ts);
    this.evaluate();
    this.emit('change');
    return rec;
  }

  byPane(paneId) {
    for (const s of this.sessions.values()) if (s.paneId === paneId) return s;
    return null;
  }

  byWindow(windowId) {
    for (const s of this.sessions.values()) if (s.windowId === windowId) return s;
    return null;
  }

  cls(uuid) {
    const s = this.sessions.get(uuid);
    return s ? STATE_CLASS[s.state] : CLS.GONE;
  }

  handleHook({ uuid, event, payload }) {
    const ts = this.now();
    this.store.logHookEvent(uuid, event, payload, ts);

    const s = this.sessions.get(uuid);
    if (!s) {
      this.emit('orphan', { uuid, event });
      return;
    }

    s.lastEvent = event;
    s.updatedAt = ts;

    if (PROGRESS_EVENTS.has(event)) {
      this._setState(s, STATES.RUNNING, 'travaille', ts);
    } else if (event === 'Notification') {
      const { state, reason } = classifyNotification(payload);
      this._setState(s, state, reason, ts);
    } else if (event === 'Stop') {
      this._setState(s, STATES.IDLE, 'tour terminé', ts);
    } else if (event === 'SessionEnd') {
      this._setState(s, STATES.GONE, 'session terminée', ts);
    }

    this.evaluate();
    this.emit('change');
  }

  /** Pane or window died without a SessionEnd hook. */
  markGone(uuid) {
    const s = this.sessions.get(uuid);
    if (!s) return;
    this._setState(s, STATES.GONE, 'pane fermé', this.now());
    this.evaluate();
    this.emit('change');
  }

  /** Keystrokes reaching a pane: the human is busy there right now. */
  noteInput(uuid) {
    if (uuid === this.focused) this.lastInputAt = this.now();
  }

  /** Manual pick: honoured immediately, then protected for a short while. */
  focus(uuid) {
    if (!this.sessions.has(uuid)) return;
    const ts = this.now();
    this.stickyUntil = ts + this.opt.manualStickyMs;
    this._switchTo(uuid, 'choix manuel', ts);
    this.emit('change');
  }

  /** Hard lock: automatic switching is suspended until unpinned. */
  setPinned(pinned) {
    this.pinned = Boolean(pinned);
    if (!this.pinned) this.evaluate();
    this.emit('change');
  }

  /** Explicitly drop the current session and hand the floor to the queue. */
  leave() {
    this.pinned = false;
    this.stickyUntil = 0;
    this.lastInputAt = 0;
    const next = this._bestCandidate();
    const ts = this.now();
    if (next) this._switchTo(next.uuid, `relais après sortie · ${CLASS_LABEL[this.cls(next.uuid)]}`, ts);
    else this.focused = null;
    this.emit('change');
  }

  /** Sessions claiming attention, best first, focused one excluded. */
  queue() {
    return [...this.sessions.values()]
      .filter((s) => s.uuid !== this.focused && STATE_CLASS[s.state] > CLS.RUNNING)
      .sort((a, b) => STATE_CLASS[b.state] - STATE_CLASS[a.state] || a.since - b.since);
  }

  _bestCandidate() {
    return this.queue()[0] || null;
  }

  /** Any live session, most recently active first. Used only as a fallback. */
  _bestLive() {
    return [...this.sessions.values()]
      .filter((s) => s.uuid !== this.focused && s.state !== STATES.GONE)
      .sort((a, b) => STATE_CLASS[b.state] - STATE_CLASS[a.state] || b.updatedAt - a.updatedAt)[0] || null;
  }

  /**
   * The whole focus policy. Idempotent, so it can be replayed by a timer once
   * a guard expires.
   */
  evaluate() {
    const ts = this.now();
    const candidate = this._bestCandidate();

    // A dead pane is never worth looking at: leave it at once, guards or not.
    const current = this.focused ? this.sessions.get(this.focused) : null;
    if (this.focused && (!current || STATE_CLASS[current.state] === CLS.GONE)) {
      const fallback = candidate || this._bestLive();
      if (fallback) {
        this._switchTo(fallback.uuid, candidate ? CLASS_LABEL[STATE_CLASS[fallback.state]] : 'session suivante', ts);
      } else {
        this.focused = null;
      }
      return;
    }

    if (!candidate) return;

    const candidateCls = STATE_CLASS[candidate.state];
    const focusedCls = this.focused ? this.cls(this.focused) : CLS.GONE;

    // Move only towards a stronger claim, or away from a session that needs
    // nothing. An equal claim keeps the incumbent: no ping-pong.
    const wants = candidateCls > focusedCls || focusedCls <= CLS.RUNNING;
    if (!wants) return;

    if (this.pinned) return;

    const defer = Math.max(
      this.stickyUntil - ts,
      this.lastInputAt + this.opt.typingGraceMs - ts,
      this.lastSwitchAt + this.opt.dwellMs - ts
    );
    if (defer > 0) {
      this._rearm(defer);
      return;
    }

    this._switchTo(candidate.uuid, CLASS_LABEL[candidateCls], ts);
    this.emit('change');
  }

  _rearm(delay) {
    if (this._timer) return;
    this._timer = this.schedule(() => {
      this._timer = null;
      this.evaluate();
      this.emit('change');
    }, Math.ceil(delay));
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  _switchTo(uuid, reason, ts) {
    if (this.focused === uuid) return;
    const from = this.focused;
    this.focused = uuid;
    this.lastSwitchAt = ts;
    this.lastInputAt = 0;
    this.lastSwitch = { from, to: uuid, reason, at: ts };
    this.emit('switch', this.lastSwitch);
  }

  _setState(s, state, reason, ts) {
    if (s.state !== state) s.since = ts;
    s.state = state;
    s.reason = reason;
    this.store.updateSessionState(s.uuid, state, ts);
    if (STATE_CLASS[state] > CLS.RUNNING) this.store.upsertQueue(s.uuid, STATE_CLASS[state], reason, s.since);
    else this.store.deleteQueue(s.uuid);
  }

  snapshot() {
    const queue = this.queue();
    const rank = new Map(queue.map((s, i) => [s.uuid, i]));
    return {
      focused: this.focused,
      pinned: this.pinned,
      lastSwitch: this.lastSwitch,
      sessions: [...this.sessions.values()].map((s) => ({
        uuid: s.uuid,
        label: s.label,
        cwd: s.cwd,
        paneId: s.paneId,
        state: s.state,
        cls: STATE_CLASS[s.state],
        clsLabel: s.state === STATES.BOOTING ? 'démarrage' : CLASS_LABEL[STATE_CLASS[s.state]],
        reason: s.reason,
        lastEvent: s.lastEvent,
        since: s.since,
        updatedAt: s.updatedAt,
        rank: rank.has(s.uuid) ? rank.get(s.uuid) : -1
      }))
    };
  }
}

module.exports = { Arbiter, STATES, CLS, CLASS_LABEL, classifyNotification };
