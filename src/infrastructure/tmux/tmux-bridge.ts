import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

const OCTAL = /^[0-7]{3}$/;

/**
 * tmux control mode escapes %output payloads with three-digit octal sequences
 * (verified against tmux 3.6: tab -> \011, backslash -> \134, ESC -> \033).
 * Bytes >= 0x80 are passed through raw, so UTF-8 survives untouched as long as
 * the stream is read as latin1 (one char == one byte).
 */
export function decodeOutput(text: string): Buffer {
  const bytes = Buffer.allocUnsafe(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) === '\\' && OCTAL.test(text.slice(i + 1, i + 4))) {
      bytes[n++] = parseInt(text.slice(i + 1, i + 4), 8);
      i += 3;
    } else {
      bytes[n++] = text.charCodeAt(i) & 0xff;
    }
  }
  return Buffer.from(bytes.subarray(0, n));
}

export function toHexKeys(str: string): string[] {
  return Array.from(Buffer.from(str, 'utf8'), (b) => b.toString(16).padStart(2, '0'));
}

interface PendingCommand {
  resolve(lines: string[]): void;
  reject(err: Error): void;
}

interface ControlBlock {
  lines: string[];
}

export interface TmuxBridgeOptions {
  readonly socket: string;
  readonly session: string;
}

export interface NewSessionWindowOptions {
  readonly label: string;
  readonly cwd: string;
  readonly command: string;
}

export interface WindowPane {
  readonly windowId: string;
  readonly paneId: string;
}

interface TmuxBridgeEvents {
  output: [paneId: string, bytes: Buffer];
  'window-closed': [windowId: string];
  stderr: [data: string];
  'control-exit': [code: string];
  notification: [line: string];
  detached: [code: number | null];
}

export class TmuxBridge extends EventEmitter<TmuxBridgeEvents> {
  private readonly socket: string;
  private readonly session: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutTail = '';
  private block: ControlBlock | null = null;
  private readonly pending: PendingCommand[] = [];
  private placeholderWindow = '';

  constructor({ socket, session }: TmuxBridgeOptions) {
    super();
    this.socket = socket;
    this.session = session;
  }

  /** One-shot tmux command outside the control channel (setup / teardown). */
  cli(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('tmux', ['-L', this.socket, ...args], (err, stdout, stderr) => {
        if (err) { reject(new Error(`tmux ${args.join(' ')}: ${stderr.trim() || err.message}`)); return; }
        resolve(stdout.trim());
      });
    });
  }

  async createServer(): Promise<void> {
    try {
      await this.cli(['kill-session', '-t', this.session]);
    } catch {
      // No leftover session; nothing to clean.
    }
    // `-f /dev/null` keeps the user's ~/.tmux.conf out of the picture.
    await this.cli([
      '-f', '/dev/null',
      'new-session', '-d', '-s', this.session, '-x', '120', '-y', '40',
      'sh', '-c', 'while :; do sleep 3600; done'
    ]);
    await this.cli(['set-option', '-t', this.session, 'status', 'off']);
    await this.cli(['set-option', '-g', 'default-terminal', 'xterm-256color']);
    await this.cli(['set-option', '-g', 'escape-time', '0']);
    await this.cli(['set-option', '-g', 'history-limit', '20000']);
    // Panes keep the size we hand them, independent of any other client.
    await this.cli(['set-option', '-g', 'window-size', 'latest']);
    // Window 0 is the idle placeholder that keeps the session alive.
    this.placeholderWindow = await this.cli(['list-windows', '-t', this.session, '-F', '#{window_id}']);
  }

  attach(): void {
    const proc = spawn('tmux', ['-L', this.socket, '-C', 'attach-session', '-t', this.session], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = proc;
    proc.stdout.setEncoding('latin1');
    proc.stdout.on('data', (chunk: string) => { this._feed(chunk); });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => this.emit('stderr', d));
    proc.on('exit', (code) => this.emit('detached', code));
  }

  private _feed(chunk: string): void {
    this.stdoutTail += chunk;
    let idx: number;
    while ((idx = this.stdoutTail.indexOf('\n')) !== -1) {
      const line = this.stdoutTail.slice(0, idx).replace(/\r$/, '');
      this.stdoutTail = this.stdoutTail.slice(idx + 1);
      this._line(line);
    }
  }

  private _line(line: string): void {
    if (this.block) {
      if (line.startsWith('%end ') || line.startsWith('%error ')) {
        const failed = line.startsWith('%error ');
        const resolver = this.pending.shift();
        if (resolver) {
          if (failed) resolver.reject(new Error(this.block.lines.join('\n')));
          else resolver.resolve(this.block.lines);
        }
        this.block = null;
        return;
      }
      this.block.lines.push(line);
      return;
    }

    if (line.startsWith('%begin ')) {
      this.block = { lines: [] };
      return;
    }
    if (line.startsWith('%output ')) {
      const sp = line.indexOf(' ', 8);
      const paneId = sp === -1 ? line.slice(8) : line.slice(8, sp);
      const payload = sp === -1 ? '' : line.slice(sp + 1);
      this.emit('output', paneId, decodeOutput(payload));
      return;
    }
    if (line.startsWith('%window-close ') || line.startsWith('%unlinked-window-close ')) {
      this.emit('window-closed', line.slice(line.indexOf(' ') + 1).trim());
      return;
    }
    if (line === '%exit' || line.startsWith('%exit ')) {
      this.emit('control-exit', line.slice(6).trim());
      return;
    }
    this.emit('notification', line);
  }

  /** Send a command down the control channel; replies arrive in FIFO order. */
  cmd(line: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) { reject(new Error('control channel not attached')); return; }
      this.pending.push({ resolve, reject });
      this.proc.stdin.write(line + '\n');
    });
  }

  setClientSize(cols: number, rows: number): Promise<string[]> {
    return this.cmd(`refresh-client -C ${cols}x${rows}`);
  }

  /**
   * -H takes literal hex bytes, so xterm.js input (including escape sequences)
   * travels verbatim with zero quoting or key-name interpretation.
   */
  async sendKeys(paneId: string, data: string): Promise<void> {
    const hex = toHexKeys(data);
    for (let i = 0; i < hex.length; i += 200) {
      await this.cmd(`send-keys -t ${paneId} -H ${hex.slice(i, i + 200).join(' ')}`);
    }
  }

  async newSessionWindow({ label, cwd, command }: NewSessionWindowOptions): Promise<WindowPane> {
    const out = await this.cli([
      'new-window', '-d', '-P',
      '-F', '#{window_id} #{pane_id}',
      '-t', `${this.session}:`,
      '-n', label,
      '-c', cwd,
      command
    ]);
    const [windowId, paneId] = out.split(' ');
    if (!windowId || !paneId) throw new Error(`unexpected tmux new-window output: ${out}`);
    return { windowId, paneId };
  }

  async kill(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.stdin.write('kill-session -t ' + this.session + '\n');
      } catch {
        // Channel already gone.
      }
      this.proc.kill();
    }
    try {
      await this.cli(['kill-session', '-t', this.session]);
    } catch {
      // Already dead.
    }
  }
}
