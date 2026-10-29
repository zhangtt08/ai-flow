import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function psEncoded(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function runPowerShell(script, { timeout = 20_000, detached = false } = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(script)],
        { windowsHide: true, detached, stdio: 'ignore' }
      );
      if (detached) {
        child.unref();
        return resolve(true);
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 忽略
        }
        resolve(false);
      }, timeout);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function copyToClipboard(text) {
  const temp = path.join(os.tmpdir(), `ai-flow-clipboard-${process.pid}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(temp, String(text ?? ''), 'utf8');
    const escaped = temp.replace(/'/g, "''");
    const script = `$text = [System.IO.File]::ReadAllText('${escaped}', [System.Text.Encoding]::UTF8); Set-Clipboard -Value $text`;
    return await runPowerShell(script, { timeout: 12_000 });
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // 忽略临时文件清理失败
    }
  }
}

export function showNotification(title, body) {
  const safeTitle = String(title || 'AI Flow').replace(/'/g, "''");
  const safeBody = String(body || '').replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipTitle = '${safeTitle}'
$notify.BalloonTipText = '${safeBody}'
$notify.Visible = $true
$notify.ShowBalloonTip(7000)
Start-Sleep -Seconds 8
$notify.Dispose()
`;
  runPowerShell(script, { detached: true });
}

export function openFolder(target) {
  if (!target || !fs.existsSync(target)) return false;
  try {
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  } catch {
    return false;
  }
}

export function openExternalUrl(url) {
  try {
    if (!/^https?:\/\//i.test(String(url))) return false;
    spawn('cmd.exe', ['/c', 'start', '', String(url)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}
