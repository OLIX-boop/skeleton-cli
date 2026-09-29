import { spawn } from 'node:child_process';

interface ClipboardCommand {
  cmd: string;
  args: string[];
}

export function clipboardCommands(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ClipboardCommand[] {
  switch (platform) {
    case 'darwin':
      return [{ cmd: 'pbcopy', args: [] }];
    case 'win32':
      // `clip` mangles non-ASCII text; PowerShell's Set-Clipboard reads UTF-8 stdin correctly.
      return [
        { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8; $input | Set-Clipboard'] },
        { cmd: 'clip', args: [] },
      ];
    default: {
      const cmds: ClipboardCommand[] = [];
      if (env.WAYLAND_DISPLAY) cmds.push({ cmd: 'wl-copy', args: [] });
      cmds.push(
        { cmd: 'xclip', args: ['-selection', 'clipboard'] },
        { cmd: 'xsel', args: ['--clipboard', '--input'] },
        { cmd: 'termux-clipboard-set', args: [] },
      );
      if (env.WSL_DISTRO_NAME) cmds.push({ cmd: 'clip.exe', args: [] });
      return cmds;
    }
  }
}

function run(command: ClipboardCommand, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.cmd, command.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command.cmd} exited with code ${code}`))));
    child.stdin.on('error', reject);
    child.stdin.end(text);
  });
}

/** Copy text to the system clipboard, trying each platform tool in turn. */
export async function copyToClipboard(text: string): Promise<string> {
  const errors: string[] = [];
  for (const command of clipboardCommands()) {
    try {
      await run(command, text);
      return command.cmd;
    } catch (error) {
      errors.push(`${command.cmd}: ${(error as Error).message}`);
    }
  }
  throw new Error(`No clipboard tool worked (${errors.join('; ')}). Install xclip, xsel or wl-clipboard, or use --stdout.`);
}
