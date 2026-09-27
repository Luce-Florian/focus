import { rmSync, statSync, accessSync, constants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { shQuote } from '../../shared/sh.ts';
import { IMPORTANCE, isImportance, type CreateSessionSpec } from '../../shared/protocol.ts';
import { isAgentId } from '../../domain/agent.ts';
import type { AgentProfile, AgentRegistry, FleetConfig, HookSink, PaneMultiplexer, RestorableSession } from '../ports.ts';
import type { Arbiter } from '../../domain/arbiter.ts';

export type FleetErrorCode = 'EFULL' | 'EAGENT' | 'EBADCWD' | 'ELABEL' | 'EMODEL' | 'ETMUX';

export class FleetError extends Error {
  readonly code: FleetErrorCode;

  constructor(code: FleetErrorCode, message: string) {
    super(message);
    this.name = 'FleetError';
    this.code = code;
  }
}

export interface CreatedSession {
  readonly uuid: string;
  readonly label: string;
  readonly cwd: string;
  readonly paneId: string;
  readonly windowId: string;
  readonly agent: string;
  readonly model: string | null;
  readonly prompt: string | null;
  readonly settingsFile: string;
}

export interface CreateSessionDeps {
  readonly cfg: FleetConfig;
  readonly multiplexer: PaneMultiplexer;
  readonly arbiter: Arbiter;
  readonly hooks: HookSink;
  readonly profiles: AgentRegistry;
}

interface ValidatedSpec {
  cwd: string;
  label: string;
  model: string;
  agent: AgentProfile;
}

/**
 * Use case: open a session, at runtime and at boot. Creating a session and
 * restoring one are the same operation — mint the identity (or reuse it),
 * write the agent's settings file, open a pane on the chosen directory, then
 * hand it to the arbiter. The uuid exists before the pane does, so the join
 * is by construction, never discovered.
 */
export function createSessionUseCase({ cfg, multiplexer, arbiter, hooks, profiles }: CreateSessionDeps) {
  function liveCount(): number {
    return arbiter.live().length;
  }

  function validate(spec: { cwd: string; label?: string; model?: string; agent?: string }): ValidatedSpec {
    if (liveCount() >= cfg.MAX_SESSIONS) {
      throw new FleetError('EFULL', `la flotte est pleine (${cfg.MAX_SESSIONS} sessions)`);
    }

    // An empty string is "unspecified", not "unknown": the create form sends
    // `agentSelect.value`, which is empty whenever the list has not loaded yet.
    const named = (spec.agent ?? '').trim();
    const requested = named === '' ? (profiles.list()[0]?.id ?? 'claude') : named;
    const agent = isAgentId(requested) ? profiles.get(requested) : undefined;
    if (!agent) throw new FleetError('EAGENT', `agent inconnu : ${requested}`);

    const dir = path.resolve(spec.cwd);
    let isDir: boolean;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      throw new FleetError('EBADCWD', `répertoire introuvable : ${dir}`);
    }
    if (!isDir) throw new FleetError('EBADCWD', `pas un répertoire : ${dir}`);
    try {
      accessSync(dir, constants.R_OK | constants.X_OK);
    } catch {
      throw new FleetError('EBADCWD', `répertoire illisible : ${dir}`);
    }

    const name = (spec.label ?? '').trim() || path.basename(dir);
    if (!name) throw new FleetError('ELABEL', 'nom de session vide');

    // Whitelist rather than escape: the model lands on a command line.
    const model = spec.model ?? '';
    if (!agent.models().some((m) => m.id === model)) {
      throw new FleetError('EMODEL', `modèle inconnu : ${model}`);
    }

    return { cwd: dir, label: name.slice(0, 40), model, agent };
  }

  /**
   * Settings file plus pane for one session, the identity already minted.
   * On failure the settings file is removed: no orphan file, no orphan window.
   */
  async function openPane(opts: {
    uuid: string;
    label: string;
    cwd: string;
    agent: AgentProfile;
    model: string;
    prompt: string | null;
    resumed: boolean;
  }): Promise<{ settingsFile: string; windowId: string; paneId: string }> {
    const { uuid, label, cwd, agent, model, prompt, resumed } = opts;
    const settingsFile = agent.writeSettings({
      runDir: cfg.RUN_DIR,
      uuid,
      host: hooks.host,
      port: hooks.port,
      token: hooks.token
    });

    // The pane outlives the agent so the final screen stays readable; the
    // marker — printed by the fleet's own wrapper, not by the agent — is what
    // tells the fleet the process is gone.
    const agentCommand = resumed
      ? agent.resume({ uuid, model, settingsFile })
      : agent.launch({ uuid, model, settingsFile, prompt });
    const command = `${agentCommand}; printf '\\n%s\\n' ${shQuote(cfg.SESSION_END_MARKER)}; exec sleep 86400`;

    try {
      const { windowId, paneId } = await multiplexer.newSessionWindow({
        label,
        cwd,
        command: `sh -c ${shQuote(command)}`
      });
      return { settingsFile, windowId, paneId };
    } catch (err: unknown) {
      rmSync(settingsFile, { force: true });
      throw new FleetError('ETMUX', `tmux a refusé la fenêtre : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Every step undoes the previous one on failure: no orphan tmux window, no
   * orphan settings file, no orphan row.
   */
  async function createSession(spec: CreateSessionSpec): Promise<CreatedSession> {
    const { cwd, label, model, agent } = validate(spec);
    const prompt = (spec.prompt ?? '').trim();
    const importance = isImportance(spec.importance) ? spec.importance : IMPORTANCE.NORMAL;
    const uuid = crypto.randomUUID();

    const { settingsFile, windowId, paneId } = await openPane({
      uuid,
      label,
      cwd,
      agent,
      model,
      // The initial prompt is the agent's own positional argument, so the
      // session starts on it with no keystroke replay.
      prompt: prompt || null,
      resumed: false
    });

    try {
      arbiter.register({ uuid, label, cwd, paneId, windowId, agent: agent.id, model: model || null, prompt: prompt || null, importance });
    } catch (err: unknown) {
      await multiplexer.cli(['kill-window', '-t', windowId]).catch(() => undefined);
      rmSync(settingsFile, { force: true });
      throw err;
    }

    // The human just asked for this session: it takes the floor now, through
    // the manual-pick path, and no incoming claim preempts that.
    arbiter.focus(uuid);

    if (prompt) {
      // Detached on purpose: a tooltip is never worth delaying a session for.
      agent
        .summarize(prompt)
        .then((summary) => {
          if (summary) arbiter.setSummary(uuid, summary);
        })
        .catch(() => undefined);
    }

    return {
      uuid,
      label,
      cwd,
      paneId,
      windowId,
      agent: agent.id,
      model: model || null,
      prompt: prompt || null,
      settingsFile
    };
  }

  /**
   * Bring a session that survived a restart back to the foreground fleet:
   * same uuid, fresh pane, conversation resumed where it stopped. The hook
   * identity carries over untouched, so the join is still URL routing.
   */
  async function restoreSession(row: RestorableSession): Promise<CreatedSession> {
    const { cwd, label, model, agent } = validate({ cwd: row.cwd, label: row.label, model: row.model ?? '', agent: row.agent });

    const { settingsFile, windowId, paneId } = await openPane({
      uuid: row.uuid,
      label,
      cwd,
      agent,
      model,
      prompt: null,
      resumed: true
    });

    try {
      arbiter.register({
        uuid: row.uuid,
        label,
        cwd,
        paneId,
        windowId,
        agent: agent.id,
        model: model || null,
        prompt: row.prompt,
        summary: row.summary,
        importance: row.importance,
        resumed: true
      });
    } catch (err: unknown) {
      await multiplexer.cli(['kill-window', '-t', windowId]).catch(() => undefined);
      rmSync(settingsFile, { force: true });
      throw err;
    }

    // No manual pick here: the first restored session takes the floor through
    // the ordinary `première session` path, and the arbiter re-evaluates as
    // hooks arrive.
    return {
      uuid: row.uuid,
      label,
      cwd,
      paneId,
      windowId,
      agent: agent.id,
      model: model || null,
      prompt: row.prompt,
      settingsFile
    };
  }

  return { createSession, restoreSession };
}

/** Re-exported so the orchestrator and its callers share one import site. */
export type { RestorableSession } from '../ports.ts';