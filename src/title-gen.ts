import { execFileSync, execSync } from 'node:child_process';

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
  model?: { providerID: string; modelID: string };
  timeoutMs?: number;
}): Promise<string> {
  const fallback = titleFromUserText(opts.userText) || 'New session';
  const user = opts.userText.slice(0, 800);
  const asst = (opts.assistantText || '').slice(0, 600);
  const prompt =
    `Create a short session title (3-8 words) for this coding chat.\n` +
    `Rules: return ONLY the title text, no quotes, no punctuation at the end, no markdown.\n\n` +
    `User:\n${user}\n\n` +
    (asst ? `Assistant:\n${asst}\n` : '');

  try {
    const title = await runPiPrint(prompt, opts.model, opts.timeoutMs ?? 25000);
    const cleaned = cleanTitle(title);
    return cleaned || fallback;
  } catch (err) {
    console.warn('[title-gen] failed, using heuristic:', err);
    return fallback;
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
  return new Promise((resolve, reject) => {
    try {
      const args = ['-p', '--no-session'];
      if (model?.providerID && model?.modelID) {
        args.push('--model', `${model.providerID}/${model.modelID}`);
      }
      args.push(message);

      let output: string;
      if (process.platform === 'win32') {
        // Windows: run via PowerShell so pi.cmd is discoverable; pass args via $args to avoid quoting issues
        output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& pi @args', ...args], {
          env: process.env,
          timeout: timeoutMs,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
      } else {
        output = execFileSync('pi', args, {
          env: process.env,
          timeout: timeoutMs,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
      }
      resolve(output.trim());
    } catch (err: any) {
      reject(err);
    }
  });
}
