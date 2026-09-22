import { EventEmitter } from 'node:events';

import {
  CLS,
  STATES,
  STATE_CLASS,
  CLASS_LABEL,
  STATE_LABEL,
  IMPORTANCE,
  IMPORTANCE_LABEL,
  type AttentionClass,
  type Importance,
  type SessionState,
  type HookEventMessage,
  type HookPayload,
  type SwitchInfo,
  type FleetSnapshot,
  type SessionSnapshot
} from '../shared/protocol.ts';
import type { ArbiterStore } from './db.ts';

// Proof that the session moved on by itself: its claim on the human is stale.
const PROGRESS_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

interface ArbiterGuards {
  // Do not yank the view away while the human is mid-keystroke.
  typingGraceMs: number;
  // Minimum time on a session before an automatic switch may fire again.
  dwellMs: number;
  // A manual pick is respected for a while, even if something louder arrives.
  manualStickyMs: number;
  // A session whose pane has drawn nothing by then never came up.
  bootTimeoutMs: number;
}

const DEFAULTS: ArbiterGuards = {
  typingGraceMs: 2500,
  dwellMs: 1200,
  manualStickyMs: 10000,
  bootTimeoutMs: 15000
};

export function classifyNotification(payload: HookPayload): { state: SessionState; reason: string } {
  const message = typeof payload.message === 'string' ? payload.message : '';
  if (/waiting for your input/i.test(message)) {
    return { state: STATES.WAITING_INPUT, reason: message || 'en attente de saisie' };
  }
  return { state: STATES.WAITING_PERM, reason: message || 'permission demandée' };
}

export interface RegisterSession {
  readonly uuid: string;
  readonly label: string;
  readonly cwd: string;
  readonly paneId: string;
  readonly windowId: string;
  readonly model?: string | null;
  readonly prompt?: string | null;
  // Restore path: the tooltip survives the restart, no need to re-summarise.
  readonly summary?: string | null;
  // A resumed session waits for its next instruction: it is not working, no
  // matter that it was created with an initial prompt.
  readonly resumed?: boolean;
  // Human-assigned weight, `NORMAL` unless said otherwise.
  readonly importance?: Importance;
}

export interface SessionRecord {
  uuid: string;
  label: string;
  cwd: string;
  paneId: string;
  windowId: string;
  model: string | null;
  prompt: string | null;
  summary: string | null;
  importance: Importance;
  // Not persisted: only meaningful between `register` and the first pane draw.
  resumed: boolean;
  state: SessionState;
  reason: string;
  since: number;
  lastEvent: string | null;
  updatedAt: number;
}

interface Timer {
  unref?(): void;
}
type Schedule = (fn: () => void, ms: number) => Timer;

export interface ArbiterOptions {
  store: ArbiterStore;
  now?: () => number;
  schedule?: Schedule;
  options?: Partial<ArbiterGuards>;
}

interface ArbiterEvents {
  change: [];
  orphan: [{ uuid: string; event: string }];
  switch: [SwitchInfo];
  // A launch that never came up: the fleet takes its window and file down.
  failed: [{ uuid: string; label: string }];
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
 *   - recent typing, a recent switch or a manual pick all defer the move
 *     rather than cancel it; the decision is replayed when the guard expires.
 */
export class Arbiter extends EventEmitter<ArbiterEvents> {
  readonly sessions = new Map<string, SessionRecord>();
  focused: string | null = null;
  lastSwitch: SwitchInfo | null = null;

  private readonly store: ArbiterStore;
  private readonly now: () => number;
  private readonly schedule: Schedule;
  private readonly opt: ArbiterGuards;

  private stickyUntil = 0;
  private lastSwitchAt = 0;
  private lastInputAt = 0;
  private timer: Timer | null = null;

  constructor({ store, now = () => Date.now(), schedule = setTimeout, options = {} }: ArbiterOptions) {
    super();
    this.store = store;
    this.now = now;
    this.schedule = schedule;
    this.opt = { ...DEFAULTS, ...options };
  }

  register(session: RegisterSession): SessionRecord {
    const ts = this.now();
    const rec: SessionRecord = {
      uuid: session.uuid,
      label: session.label,
      cwd: session.cwd,
      paneId: session.paneId,
      windowId: session.windowId,
      model: session.model ?? null,
      prompt: session.prompt ?? null,
      summary: session.summary ?? null,
      importance: session.importance ?? IMPORTANCE.NORMAL,
      resumed: session.resumed ?? false,
      state: STATES.BOOTING,
      reason: 'démarrage',
      since: ts,
      lastEvent: null,
      updatedAt: ts
    };
    this.sessions.set(rec.uuid, rec);
    this.store.insertSession({ ...rec, createdAt: ts });
    this._armBootWatchdog(rec.uuid);
    if (this.focused === null) this._switchTo(rec.uuid, 'première session', ts);
    this.evaluate();
    this.emit('change');
    return rec;
  }

  /** Drop a session the arbiter registered but that never came up. */
  unregister(uuid: string): void {
    if (!this.sessions.delete(uuid)) return;
    this.store.deleteQueue(uuid);
    this.store.deleteSession(uuid);
    if (this.focused === uuid) this.focused = null;
    this.evaluate();
    this.emit('change');
  }

  /** Out-of-band one-line description of the session's initial prompt. */
  setSummary(uuid: string, summary: string): void {
    const s = this.sessions.get(uuid);
    if (!s || !summary) return;
    s.summary = summary;
    this.store.setSummary(uuid, summary);
    this.emit('change');
  }

  /**
   * Human-assigned importance. Persisted, and re-decided at once — same path
   * as a hook, under the same guards: a sticky manual pick never yields to a
   * mere bump.
   */
  setImportance(uuid: string, importance: Importance): void {
    const s = this.sessions.get(uuid);
    if (!s || s.importance === importance) return;
    s.importance = importance;
    this.store.setImportance(uuid, importance);
    this.evaluate();
    this.emit('change');
  }

  /** The internal record, windowId included: used by the session factory. */
  get(uuid: string): SessionRecord | null {
    return this.sessions.get(uuid) ?? null;
  }

  /** Sessions that still exist as far as the fleet is concerned. */
  live(): SessionRecord[] {
    return [...this.sessions.values()].filter((s) => STATE_CLASS[s.state] > CLS.GONE);
  }

  /**
   * First bytes drawn by the pane. `SessionStart` is not observed to fire
   * (Claude Code 2.1.236, HTTP hooks), so the pane rendering at all is the
   * only proof the process came up. A session launched with a prompt is
   * already working; one launched without waits for its first instruction —
   * and so does a resumed one, whatever its original prompt was.
   */
  noteAlive(uuid: string): void {
    const s = this.sessions.get(uuid);
    if (s?.state !== STATES.BOOTING) return;
    const ts = this.now();
    if (s.prompt && !s.resumed) this._setState(s, STATES.RUNNING, 'travaille', ts);
    else this._setState(s, STATES.IDLE, s.resumed ? 'reprise' : 'prête', ts);
    this.evaluate();
    this.emit('change');
  }

  /**
   * The pane printed the end-of-session marker: Claude Code exited. Before it
   * ever drew anything, that is a launch that did not take.
   */
  noteEnded(uuid: string): void {
    const s = this.sessions.get(uuid);
    if (s === undefined || STATE_CLASS[s.state] === CLS.GONE) return;
    const failed = s.state === STATES.BOOTING;
    this._setState(
      s,
      failed ? STATES.FAILED : STATES.GONE,
      failed ? 'démarrage échoué' : 'session terminée',
      this.now()
    );
    if (failed) this.emit('failed', { uuid, label: s.label });
    this.evaluate();
    this.emit('change');
  }

  /**
   * Backstop for a launch that draws nothing at all and never exits — no pane
   * output, no marker, no hook. Anything the session emits leaves `booting`
   * before this fires. The callback checks the state rather than cancelling,
   * so an injected scheduler with no cancellation stays sound.
   */
  private _armBootWatchdog(uuid: string): void {
    const timer = this.schedule(() => {
      const s = this.sessions.get(uuid);
      if (s?.state !== STATES.BOOTING) return;
      this._setState(s, STATES.FAILED, 'aucun signe de vie', this.now());
      this.emit('failed', { uuid, label: s.label });
      this.evaluate();
      this.emit('change');
    }, this.opt.bootTimeoutMs);
    timer.unref?.();
  }

  byPane(paneId: string): SessionRecord | null {
    for (const s of this.sessions.values()) if (s.paneId === paneId) return s;
    return null;
  }

  byWindow(windowId: string): SessionRecord | null {
    for (const s of this.sessions.values()) if (s.windowId === windowId) return s;
    return null;
  }

  cls(uuid: string): AttentionClass {
    const s = this.sessions.get(uuid);
    return s ? STATE_CLASS[s.state] : CLS.GONE;
  }

  handleHook({ uuid, event, payload }: HookEventMessage): void {
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
  markGone(uuid: string): void {
    const s = this.sessions.get(uuid);
    if (!s) return;
    this._setState(s, STATES.GONE, 'pane fermé', this.now());
    this.evaluate();
    this.emit('change');
  }

  /**
   * Drop the deferral guards without moving the floor. The smoke test puts a
   * session on screen by hand, then clears what that manual pick armed so the
   * assertions that follow observe the focus policy and nothing else.
   */
  clearGuards(): void {
    this.stickyUntil = 0;
    this.lastSwitchAt = 0;
    this.lastInputAt = 0;
  }

  /** Keystrokes reaching a pane: the human is busy there right now. */
  noteInput(uuid: string): void {
    if (uuid === this.focused) this.lastInputAt = this.now();
  }

  /** Manual pick: honoured immediately, then protected for a short while. */
  focus(uuid: string): void {
    if (!this.sessions.has(uuid)) return;
    const ts = this.now();
    this.stickyUntil = ts + this.opt.manualStickyMs;
    this._switchTo(uuid, 'choix manuel', ts);
    this.emit('change');
  }

  /** Explicitly drop the current session and hand the floor to the queue. */
  leave(): void {
    this.stickyUntil = 0;
    this.lastInputAt = 0;
    const next = this._bestCandidate();
    const ts = this.now();
    if (next) this._switchTo(next.uuid, `relais après sortie · ${CLASS_LABEL[this.cls(next.uuid)]}`, ts);
    else this.focused = null;
    this.emit('change');
  }

  /** Sessions claiming attention, best first, focused one excluded. */
  queue(): SessionRecord[] {
    return [...this.sessions.values()]
      .filter((s) => s.uuid !== this.focused && STATE_CLASS[s.state] > CLS.RUNNING)
      .sort(
        (a, b) =>
          STATE_CLASS[b.state] - STATE_CLASS[a.state] ||
          b.importance - a.importance ||
          a.since - b.since
      );
  }

  private _bestCandidate(): SessionRecord | null {
    return this.queue()[0] ?? null;
  }

  /** Any live session, most recently active first. Used only as a fallback. */
  private _bestLive(): SessionRecord | null {
    return (
      [...this.sessions.values()]
        .filter((s) => s.uuid !== this.focused && s.state !== STATES.GONE)
        .sort(
          (a, b) =>
            STATE_CLASS[b.state] - STATE_CLASS[a.state] ||
            b.importance - a.importance ||
            b.updatedAt - a.updatedAt
        )[0] ?? null
    );
  }

  /**
   * The whole focus policy. Idempotent, so it can be replayed by a timer once
   * a guard expires.
   */
  evaluate(): void {
    const ts = this.now();
    const candidate = this._bestCandidate();

    // A dead pane is never worth looking at: leave it at once, guards or not.
    const current = this.focused ? this.sessions.get(this.focused) : null;
    if (this.focused && (!current || STATE_CLASS[current.state] === CLS.GONE)) {
      const fallback = candidate ?? this._bestLive();
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
    // nothing. An equal claim keeps the incumbent: no ping-pong. Importance
    // only breaks a tie inside a class — it never crosses a class boundary.
    const wants =
      candidateCls > focusedCls ||
      (candidateCls === focusedCls && candidate.importance > (current?.importance ?? IMPORTANCE.LOW)) ||
      focusedCls <= CLS.RUNNING;
    if (!wants) return;

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

  private _rearm(delay: number): void {
    if (this.timer) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.evaluate();
      this.emit('change');
    }, Math.ceil(delay));
    this.timer.unref?.();
  }

  private _switchTo(uuid: string, reason: string, ts: number): void {
    if (this.focused === uuid) return;
    const from = this.focused;
    this.focused = uuid;
    this.lastSwitchAt = ts;
    this.lastInputAt = 0;
    this.lastSwitch = { from, to: uuid, reason, at: ts };
    this.emit('switch', this.lastSwitch);
  }

  private _setState(s: SessionRecord, state: SessionState, reason: string, ts: number): void {
    if (s.state !== state) s.since = ts;
    s.state = state;
    s.reason = reason;
    this.store.updateSessionState(s.uuid, state, ts);
    if (STATE_CLASS[state] > CLS.RUNNING) this.store.upsertQueue(s.uuid, STATE_CLASS[state], reason, s.since);
    else this.store.deleteQueue(s.uuid);
  }

  snapshot(): FleetSnapshot {
    const queue = this.queue();
    const rank = new Map(queue.map((s, i) => [s.uuid, i]));
    const sessions: SessionSnapshot[] = [...this.sessions.values()].map((s) => ({
      uuid: s.uuid,
      label: s.label,
      cwd: s.cwd,
      paneId: s.paneId,
      model: s.model,
      prompt: s.prompt,
      summary: s.summary,
      state: s.state,
      cls: STATE_CLASS[s.state],
      clsLabel: STATE_LABEL[s.state] ?? CLASS_LABEL[STATE_CLASS[s.state]],
      importance: s.importance,
      importanceLabel: IMPORTANCE_LABEL[s.importance],
      reason: s.reason,
      lastEvent: s.lastEvent,
      since: s.since,
      updatedAt: s.updatedAt,
      rank: rank.get(s.uuid) ?? -1
    }));
    return {
      focused: this.focused,
      lastSwitch: this.lastSwitch,
      sessions
    };
  }
}
