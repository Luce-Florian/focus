'use strict';

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const OCTAL = /^[0-7]{3}$/;

/**
 * tmux control mode escapes %output payloads with three-digit octal sequences
 * (verified against tmux 3.6: tab -> \011, backslash -> \134, ESC -> \033).
 * Bytes >= 0x80 are passed through raw, so UTF-8 survives untouched as long as
 * the stream is read as latin1 (one char == one byte).
 */
function decodeOutput(text) {
  const bytes = Buffer.allocUnsafe(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && OCTAL.test(text.slice(i + 1, i + 4))) {
      bytes[n++] = parseInt(text.slice(i + 1, i + 4), 8);
      i += 3;
    } else {
      bytes[n++] = text.charCodeAt(i) & 0xff;
    }
  }
  return Buffer.from(bytes.subarray(0, n));
}

function toHexKeys(str) {
  return Array.from(Buffer.from(str, 'utf8'), (b) => b.toString(16).padStart(2, '0'));
}

class TmuxBridge extends EventEmitter {
  constructor({ socket, session }) {
    super();
    this.socket = socket;
    this.session = session;
    this.proc = null;
    this.stdoutTail = '';
    this.block = null;
    this.pending = [];
  }

  /** One-shot tmux command outside the control channel (setup / teardown). */
  cli(args) {
    return new Promise((resolve, reject) => {
      execFile('tmux', ['-L', this.socket, ...args], (err, stdout, stderr) => {
        if (err) return reject(new Error(`tmux ${args.join(' ')}: ${stderr.trim() || err.message}`));
        resolve(stdout.trim());
      });
    });
  }

  async createServer() {
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
    this.placeholderWindow = await this.cli([
      'list-windows', '-t', this.session, '-F', '#{window_id}'
    ]);
  }

  attach() {
    this.proc = spawn('tmux', ['-L', this.socket, '-C', 'attach-session', '-t', this.session], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc.stdout.setEncoding('latin1');
    this.proc.stdout.on('data', (chunk) => this._feed(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => this.emit('stderr', d));
    this.proc.on('exit', (code) => this.emit('detached', code));
  }

  _feed(chunk) {
    this.stdoutTail += chunk;
    let idx;
    while ((idx = this.stdoutTail.indexOf('\n')) !== -1) {
      const line = this.stdoutTail.slice(0, idx).replace(/\r$/, '');
      this.stdoutTail = this.stdoutTail.slice(idx + 1);
      this._line(line);
    }
  }

  _line(line) {
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
  cmd(line) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) return reject(new Error('control channel not attached'));
      this.pending.push({ resolve, reject });
      this.proc.stdin.write(line + '\n');
    });
  }

  setClientSize(cols, rows) {
    return this.cmd(`refresh-client -C ${cols}x${rows}`);
  }

  /**
   * -H takes literal hex bytes, so xterm.js input (including escape sequences)
   * travels verbatim with zero quoting or key-name interpretation.
   */
  async sendKeys(paneId, data) {
    const hex = toHexKeys(data);
    for (let i = 0; i < hex.length; i += 200) {
      await this.cmd(`send-keys -t ${paneId} -H ${hex.slice(i, i + 200).join(' ')}`);
    }
  }

  async newSessionWindow({ label, cwd, command }) {
    const out = await this.cli([
      'new-window', '-d', '-P',
      '-F', '#{window_id} #{pane_id}',
      '-t', `${this.session}:`,
      '-n', label,
      '-c', cwd,
      command
    ]);
    const [windowId, paneId] = out.split(' ');
    return { windowId, paneId };
  }

  async kill() {
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

module.exports = { TmuxBridge, decodeOutput, toHexKeys };
