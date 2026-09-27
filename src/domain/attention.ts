/**
 * Attention classes and session states: the fleet's vocabulary. Pure domain
 * concepts — no process, no infrastructure, imported by every layer.
 */

/**
 * Attention classes. Focus always goes to the highest class on screen.
 * Class 0 means "this session needs nothing from the human": it is
 * background work and must never occupy the foreground while something else
 * is waiting.
 */
export const CLS = {
  GONE: -1,
  RUNNING: 0, // working on its own
  IDLE: 1, // turn finished, awaiting the next instruction
  WAIT_INPUT: 2, // Notification: idle nudge
  WAIT_PERM: 3 // Notification: blocking permission prompt
} as const;

export type AttentionClass = (typeof CLS)[keyof typeof CLS];

/**
 * Importance levels. The attention class always wins: importance only breaks
 * ties *inside* a class, it never promotes a session across a class
 * boundary. `NORMAL` is the default.
 */
export const IMPORTANCE = {
  LOW: -1,
  NORMAL: 0,
  HIGH: 1
} as const;

export type Importance = (typeof IMPORTANCE)[keyof typeof IMPORTANCE];

export const IMPORTANCE_LABEL: Record<Importance, string> = {
  [IMPORTANCE.LOW]: 'basse',
  [IMPORTANCE.NORMAL]: 'normale',
  [IMPORTANCE.HIGH]: 'haute'
};

export function isImportance(value: unknown): value is Importance {
  return value === IMPORTANCE.LOW || value === IMPORTANCE.NORMAL || value === IMPORTANCE.HIGH;
}

export const STATES = {
  BOOTING: 'booting',
  RUNNING: 'running',
  WAITING_PERM: 'waiting_perm',
  WAITING_INPUT: 'waiting_input',
  IDLE: 'idle',
  GONE: 'gone',
  // Registered, but the pane never drew anything: the launch did not take.
  FAILED: 'failed'
} as const;

export type SessionState = (typeof STATES)[keyof typeof STATES];

export const STATE_CLASS: Record<SessionState, AttentionClass> = {
  [STATES.BOOTING]: CLS.RUNNING,
  [STATES.RUNNING]: CLS.RUNNING,
  [STATES.IDLE]: CLS.IDLE,
  [STATES.WAITING_INPUT]: CLS.WAIT_INPUT,
  [STATES.WAITING_PERM]: CLS.WAIT_PERM,
  [STATES.GONE]: CLS.GONE,
  [STATES.FAILED]: CLS.GONE
};

export const CLASS_LABEL: Record<AttentionClass, string> = {
  [CLS.WAIT_PERM]: 'permission',
  [CLS.WAIT_INPUT]: 'attente',
  [CLS.IDLE]: 'tour terminé',
  [CLS.RUNNING]: 'travaille',
  [CLS.GONE]: 'terminée'
};

/**
 * States whose own name says more than their attention class. `booting` and
 * `failed` both sit at a class that says nothing useful on a chip.
 */
export const STATE_LABEL: Partial<Record<SessionState, string>> = {
  [STATES.BOOTING]: 'démarrage',
  [STATES.FAILED]: 'démarrage échoué'
};