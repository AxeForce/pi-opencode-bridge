# Pi-OpenCode Bridge

A bridge server that lets the **OpenCode desktop app** use **Pi** as the backend agent. The bridge speaks the OpenCode Server protocol on the front and drives Pi via its RPC mode (`pi --mode rpc`) on the back.

```
┌─────────────────────────────────────┐
│  OpenCode Desktop / TUI             │
│  (connects via OPENCODE_API_URL)    │
└──────────────┬──────────────────────┘
               │ HTTP + SSE
               ▼
┌─────────────────────────────────────┐
│  Bridge Server (Node + Hono)        │
│  ├── OpenCode protocol routes       │
│  ├── Session/message/file/git       │
│  ├── Stream adapter (Pi → SSE)      │
│  └── Pi RPC client (subprocess)     │
└──────────────┬──────────────────────┘
               │ JSONL over stdin/stdout
               ▼
┌─────────────────────────────────────┐
│  pi --mode rpc                      │
│  (Pi coding agent)                  │
└─────────────────────────────────────┘
```

## Features

### Real (Pi-backed)
- **Chat streaming** — text deltas, reasoning/thinking, tool calls with full metadata
- **Tools** — bash, read, write, edit, grep, find, ls (via Pi)
- **Permission system** — Pi asks, desktop approves/rejects, bridge relays
- **Token + cost tracking** — real usage from Pi (`input`, `output`, `reasoning`, `cache read/write`, `cost`)
- **Models & agents** — discovered from Pi (`pi --list-models`)
- **Session persistence** — survives restarts (`~/.pi-opencode-bridge/sessions/`)
- **Session list** — directory-scoped, project-aware (git + non-git)
- **Auto session titles** — heuristic from first message, then LLM-refined after first reply
- **File search** — ripgrep / git grep / recursive walk with `.gitignore` awareness
- **Git status & diff** — `GET /file/status` returns real `FileDiff[]`; session diff tracks files touched by tools
- **VCS branch** — detected from git

### Honest stubs (return empty / no-op)
- LSP, formatter, PTY terminals
- MCP connect/disconnect (Pi manages its own MCP)
- Session revert/unrevert
- Shell/command message injection
- TUI hooks, auth tokens

## Requirements

- **Node.js** ≥ 20
- **Pi** installed and on PATH (`pi --version`)
- Pi configured with a model provider (API keys in env or `~/.pi/agent/settings.json`)
- **Optional** (enables faster search): `ripgrep` (`rg`) and/or `fd` on PATH
- **Optional** (for git features): `git` on PATH

## Quick start

```bash
npm install
npm run build
npm start
```

Output:
```
[bridge] starting on 127.0.0.1:4096
[bridge] pi models: 42 (default opencode-go/mimo-v2.5)
[bridge] pi agents: build, plan, explore
[bridge] listening on http://127.0.0.1:4096
```

### Connect OpenCode Desktop

1. Open **Settings** in OpenCode Desktop
2. Set server URL to `http://127.0.0.1:4096`
3. Or set `OPENCODE_API_URL=http://localhost:4096` in the environment

### Connect OpenCode TUI

```bash
OPENCODE_API_URL=http://localhost:4096 opencode
```

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_API_PORT` | `4096` | Port to listen on |
| `OPENCODE_API_HOST` | `127.0.0.1` | Host to bind (set `OPENCODE_ALLOW_REMOTE=1` for non-localhost) |
| `PI_WORKING_DIR` | `process.cwd()` | Default working directory for Pi |
| `BRIDGE_PASSWORD` | _(none)_ | Optional basic-auth password (opt-in) |
| `OPENCODE_ALLOW_REMOTE` | `0` | Allow non-localhost bind without auth warning |
| `PI_EPHEMERAL` | `0` | Set `1` to skip Pi session persistence |

## Architecture

### Key design decisions

- **Pi runs as a subprocess** (`pi --mode rpc`), not via the Node SDK. Communication is JSONL over stdin/stdout.
- **Sessions persist** under `~/.pi-opencode-bridge/` (bridge store) and `~/.pi-opencode-bridge/pi-sessions/` (Pi's own resume files).
- **Project IDs** match OpenCode's scheme: git repos use the root commit hash; non-git dirs get a stable SHA-1 of the path (so each folder is its own project, unlike OpenCode's `global`+`/`).
- **IDs** follow OpenCode format: `ses_` / `msg_` / `prt_` prefix + 12 hex chars + 14 base62 chars. No underscores/hyphens in the body (desktop regex requirement).
- **SSE** uses the global envelope: `data: {"directory":"...","payload":{"type":"...","properties":{...}}}` (no `event:` field).
- **Security**: localhost-only by default. Remote binds require `OPENCODE_ALLOW_REMOTE=1`. Auth is opt-in via `BRIDGE_PASSWORD`.

### Event mapping (Pi → OpenCode)

| Pi event | OpenCode event(s) |
|----------|-------------------|
| `message_update` + `text_delta` | `message.part.updated` (TextPart) + delta |
| `message_update` + `thinking_delta` | `message.part.updated` (ReasoningPart) |
| `message_end` (assistant) | Token/cost update on message |
| `tool_execution_start` | `message.part.updated` (ToolPart, running) |
| `tool_execution_end` | `message.part.updated` (ToolPart, completed/error) |
| `turn_start` | `message.part.updated` (StepStartPart) |
| `turn_end` | `message.part.updated` (StepFinishPart) + token/cost |
| `agent_start` | `session.status` (busy) |
| `agent_end` | `session.status` (idle) + `session.idle` + token finalization |
| `auto_retry_start/end` | `session.status` (retry/busy) |
| `extension_ui_request` (confirm) | `permission.asked` |
| `extension_ui_request` (select/input) | `question.asked` |

### Token & cost tracking

Pi reports `usage` on every assistant `message_end` and `turn_end`:

```json
{
  "input": 794,
  "output": 15,
  "reasoning": 11,
  "cacheRead": 2560,
  "cacheWrite": 0,
  "totalTokens": 809,
  "cost": { "total": 0.00011536 }
}
```

The bridge extracts this, maps it to OpenCode's `Tokens` shape (`{ input, output, reasoning, cache: { read, write } }`), and accumulates across multi-step tool loops.

### Session titles

1. **Instant** (on first user message): heuristic — trimmed first line of the prompt
2. **LLM-refined** (after first AI reply): Pi generates a 3–8 word title via one-shot `pi -p`
3. **Manual**: `PATCH /session/:id { title }` or `POST /session/:id/summarize`

### File structure

```
src/
├── index.ts            # Entry — security, CORS, route mounting
├── state.ts            # Session store, project repair, title logic
├── pi-session.ts       # Pi RPC client (subprocess lifecycle)
├── stream-adapter.ts   # Pi events → OpenCode SSE/parts/tools/tokens
├── project.ts          # Project ID resolution (git + non-git)
├── directory.ts        # x-opencode-directory header/query parsing
├── search.ts           # File search (rg/git-grep/walk)
├── git.ts              # Git status, diff, branch → FileDiff[]
├── title-gen.ts        # Heuristic + LLM session title generation
├── pi-models.ts        # Model discovery from Pi
├── pi-agents.ts        # Agent definitions (build/plan/explore)
├── storage.ts          # JSON persistence for sessions
├── queue.ts            # Per-session async prompt queue
├── id.ts               # ID generation (ses_, msg_, prt_)
├── types/              # TypeScript interfaces
└── routes/
    ├── global.ts       # SSE, config, providers, project, health
    ├── session.ts      # Session CRUD, diff, summarize, permissions
    ├── message.ts      # Prompt (sync/async), message list
    └── file.ts         # File ops, search, git status
```

## Development

```bash
npm run dev          # Watch mode (tsx)
npm run typecheck    # Type-check without emit
npm run build        # Compile + copy fixtures
```

## Data locations

| Path | Purpose |
|------|---------|
| `~/.pi-opencode-bridge/sessions/` | Bridge session store (JSON per session) |
| `~/.pi-opencode-bridge/pi-sessions/` | Pi resume files (JSONL per session) |

## Acknowledgments

- Built on the [OpenCode Server protocol](https://opencode.ai/docs/server/)
- Powered by [Pi](https://pi.dev/) by Mario Zechner
- Inspired by [AgentPool's `serve-opencode`](https://github.com/phil65/agentpool)

## License

MIT
