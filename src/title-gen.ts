import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TITLE_GENERATION_MODEL = {
  providerID: 'opencode-go',
  modelID: 'deepseek-v4-flash',
} as const;

/** Short human title from first user prompt (no extra LLM call). */
export function titleFromUserText(text: string, maxLen = 72): string {
  let t = (text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) || '';
  t = t.replace(/^\/[a-zA-Z0-9_-]+\s*/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 40 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/**
 * Ask Pi for a short session title (one-shot, no tools, ephemeral).
 * Falls back to heuristic titleFromUserText on failure.
 */
export async function generateSessionTitle(opts: {
  userText: string;
  assistantText?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const user = opts.userText.slice(0, 800);
  const asst = (opts.assistantText || '').slice(0, 600);
  const prompt =
    `Create a short session title (3-8 words) for this coding chat.\n` +
    `Rules: return ONLY the title text, no quotes, no punctuation at the end, no markdown.\n\n` +
    `User:\n${user}\n\n` +
    (asst ? `Assistant:\n${asst}\n` : '');

  try {
    const title = await runPiPrint(prompt, TITLE_GENERATION_MODEL, opts.timeoutMs ?? 25000);
    const cleaned = cleanTitle(title);
    return cleaned || null;
  } catch (err) {
    console.warn('[title-gen] failed:', err);
    return null;
  }
}

function cleanTitle(raw: string): string {
  let t = (raw || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('```')) || '';
  t = t.replace(/^["'`]+|["'`]+$/g, '').trim();
  t = t.replace(/^title:\s*/i, '').trim();
  if (t.length > 80) t = t.slice(0, 79).trimEnd() + '…';
  // Reject garbage
  if (!t || t.length < 2) return '';
  if (/^(ok|okay|sure|here|yes|no)\b/i.test(t) && t.length < 8) return '';
  return t;
}

function runPiPrint(
  message: string,
  model?: { providerID: string; modelID: string },
  timeoutMs = 25000,
): Promise<string> {
  const args = ['-p', '--no-session'];
  if (model?.providerID && model?.modelID) {
    args.push('--model', `${model.providerID}/${model.modelID}`);
  }

  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const script = fileURLToPath(new URL('../scripts/run-pi.ps1', import.meta.url));
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', script, ...args,
      ], { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      collectChildOutput(child, message, timeoutMs, resolve, reject);
      return;
    }

    execFile(
      'pi',
      [...args, message],
      {
        env: process.env,
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      },
    );
  });
}

function collectChildOutput(
  child: ReturnType<typeof spawn>,
  input: string,
  timeoutMs: number,
  resolve: (value: string) => void,
  reject: (reason?: unknown) => void,
): void {
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('title generation timed out'));
  }, timeoutMs);

  child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  child.once('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (code !== 0 && !stdout.trim()) {
      reject(new Error(stderr.trim() || `pi exited ${code}`));
      return;
    }
    resolve(stdout.trim());
  });

  child.stdin?.end(input);
}
