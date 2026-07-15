import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface PiAgent {
  name: string;
  description: string;
  mode: 'primary' | 'subagent';
  native: boolean;
  tools?: string[]; // if set, restrict tools
  promptPrefix?: string; // slash command or prompt content to prepend
  permission?: Array<{ permission: string; action: string; pattern: string }>;
}

const DEFAULT_PERMISSION = [
  { permission: '*', action: 'allow', pattern: '*' },
  { permission: 'doom_loop', action: 'ask', pattern: '*' },
  { permission: 'external_directory', pattern: '*', action: 'ask' },
  { permission: 'question', action: 'allow', pattern: '*' },
];

const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

export function loadPiAgents(): PiAgent[] {
  const agents: PiAgent[] = [
    {
      name: 'build',
      description: 'Pi coding agent — full tools (read, bash, edit, write)',
      mode: 'primary',
      native: true,
      permission: DEFAULT_PERMISSION,
    },
    {
      name: 'plan',
      description: 'Plan mode — read-only analysis and design (no edits)',
      mode: 'primary',
      native: true,
      tools: READ_ONLY_TOOLS,
      promptPrefix: '/plan ',
      permission: [
        ...DEFAULT_PERMISSION,
        { permission: 'edit', action: 'deny', pattern: '*' },
        { permission: 'bash', action: 'deny', pattern: '*' },
        { permission: 'write', action: 'deny', pattern: '*' },
      ],
    },
    {
      name: 'explore',
      description: 'Explore mode — read-only codebase exploration',
      mode: 'primary',
      native: true,
      tools: READ_ONLY_TOOLS,
      permission: [
        ...DEFAULT_PERMISSION,
        { permission: 'edit', action: 'deny', pattern: '*' },
        { permission: 'bash', action: 'deny', pattern: '*' },
        { permission: 'write', action: 'deny', pattern: '*' },
      ],
    },
  ];

  // Load Pi prompt templates as subagents
  const promptsDir = join(homedir(), '.pi/agent/prompts');
  if (existsSync(promptsDir)) {
    try {
      for (const file of readdirSync(promptsDir)) {
        if (!file.endsWith('.md')) continue;
        const name = file.replace(/\.md$/, '');
        // Skip if we already have a primary with this name
        if (agents.some(a => a.name === name)) continue;
        let description = `Pi prompt: ${name}`;
        try {
          const content = readFileSync(join(promptsDir, file), 'utf-8');
          const descMatch = content.match(/^description:\s*(.+)$/m) || content.match(/^#\s*(.+)$/m);
          if (descMatch) description = descMatch[1].trim();
        } catch {}
        agents.push({
          name,
          description,
          mode: 'subagent',
          native: false,
          promptPrefix: `/${name} `,
          permission: DEFAULT_PERMISSION,
        });
      }
    } catch {}
  }

  // Also pull commands from pi RPC if available (cached)
  try {
    const output = execSync(
      `printf '%s\\n' '{"type":"get_commands","id":"1"}' | pi --mode rpc --no-session 2>/dev/null | grep '"type":"response"' | head -1`,
      { encoding: 'utf-8', timeout: 8000, shell: '/bin/bash' },
    );
    if (output.trim()) {
      const parsed = JSON.parse(output);
      const commands = parsed?.data?.commands || [];
      for (const cmd of commands) {
        if (cmd.source !== 'prompt') continue;
        if (agents.some(a => a.name === cmd.name)) continue;
        agents.push({
          name: cmd.name,
          description: cmd.description || `Pi prompt: ${cmd.name}`,
          mode: 'subagent',
          native: false,
          promptPrefix: `/${cmd.name} `,
          permission: DEFAULT_PERMISSION,
        });
      }
    }
  } catch {}

  return agents;
}

let cached: PiAgent[] | null = null;

export function getPiAgents(): PiAgent[] {
  if (!cached) cached = loadPiAgents();
  return cached;
}

export function getAgent(name: string): PiAgent | undefined {
  return getPiAgents().find(a => a.name === name);
}
