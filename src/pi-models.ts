import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PiModel {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  images: boolean;
  /** Per-model thinking level map from models.json — keys are supported variants */
  thinkingLevelMap?: Record<string, string | null>;
}

export interface PiSettings {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel?: string;
}

function parseContextSize(s: string): number {
  const t = s.trim().toLowerCase();
  if (t.endsWith('m')) {
    const n = parseFloat(t.slice(0, -1));
    return Math.round(n * 1_000_000);
  }
  if (t.endsWith('k')) {
    const n = parseFloat(t.slice(0, -1));
    return Math.round(n * 1000);
  }
  return parseInt(t, 10) || 128000;
}

export function loadPiSettings(): PiSettings {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.pi/agent/settings.json'), 'utf-8'));
    return {
      defaultProvider: raw.defaultProvider || 'zai',
      defaultModel: raw.defaultModel || 'glm-5.2',
      defaultThinkingLevel: raw.defaultThinkingLevel,
    };
  } catch {
    return { defaultProvider: 'zai', defaultModel: 'glm-5.2' };
  }
}

export function loadPiModels(): PiModel[] {
  try {
    const output = execSync('pi --list-models', {
      encoding: 'utf-8',
      timeout: 15000,
      env: process.env,
    });

    const models: PiModel[] = [];
    const lines = output.split('\n');
    for (const line of lines) {
      // Skip header
      if (!line.trim() || line.startsWith('provider') || line.startsWith('-')) continue;
      // Format: provider  model  context  max-out  thinking  images
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const [provider, id, context, maxOut, thinking, images] = parts;
      models.push({
        provider,
        id,
        name: id,
        contextWindow: parseContextSize(context),
        maxTokens: parseContextSize(maxOut),
        reasoning: thinking.toLowerCase() === 'yes',
        images: images.toLowerCase() === 'yes',
      });
    }

    // Enrich names from models.json if available
    try {
      const modelsJson = JSON.parse(readFileSync(join(homedir(), '.pi/agent/models.json'), 'utf-8'));
      for (const [providerId, provider] of Object.entries(modelsJson.providers || {})) {
        for (const m of (provider as any).models || []) {
          const found = models.find(x => x.provider === providerId && x.id === m.id);
          if (found) {
            found.name = m.name || found.name;
            if (m.contextWindow) found.contextWindow = m.contextWindow;
            if (m.maxTokens) found.maxTokens = m.maxTokens;
            found.thinkingLevelMap = m.thinkingLevelMap || m.thinkingLevels;
          }
        }
      }
    } catch {}

    return models;
  } catch (err) {
    console.error('[pi-models] failed to list models:', err);
    // Fallback to default
    return [{
      provider: 'zai',
      id: 'glm-5.2',
      name: 'GLM-5.2',
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      reasoning: true,
      images: false,
    }];
  }
}

function buildOpenCodeModel(m: PiModel) {
  // Determine supported variants from thinkingLevelMap
  let variants: Record<string, object> = {};
  if (m.reasoning) {
    if (m.thinkingLevelMap) {
      for (const [level, mapped] of Object.entries(m.thinkingLevelMap)) {
        if (mapped !== null) {
          variants[level] = {};
        }
      }
    }
    // Always include 'off' (no thinking)
    variants['off'] = {};
    // Fallback: no map → assume all 7 levels
    if (Object.keys(variants).length <= 1) {
      const all = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      for (const v of all) variants[v] = {};
    }
  }
  return {
    id: m.id,
    name: m.name,
    family: m.id,
    api: {
      id: m.id,
      npm: '@ai-sdk/openai-compatible',
    },
    status: 'active',
    headers: {},
    options: {},
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: m.contextWindow,
      input: m.contextWindow,
      output: m.maxTokens,
    },
    capabilities: {
      temperature: true,
      reasoning: m.reasoning,
      attachment: m.images,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: m.images,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: m.reasoning ? { field: 'reasoning_content' } : false,
    },
    release_date: '2025-01-01',
    variants,
  };
}

export function buildProvidersResponse(models: PiModel[], settings: PiSettings) {
  // Group by provider
  const byProvider = new Map<string, PiModel[]>();
  for (const m of models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider)!.push(m);
  }

  const providers = Array.from(byProvider.entries()).map(([providerId, providerModels]) => {
    const modelsMap: Record<string, ReturnType<typeof buildOpenCodeModel>> = {};
    for (const m of providerModels) {
      modelsMap[m.id] = buildOpenCodeModel(m);
    }
    return {
      id: providerId,
      source: 'env' as const,
      name: providerId,
      env: [],
      options: {},
      models: modelsMap,
    };
  });

  // Default map: each provider's first model, plus settings default
  const defaultMap: Record<string, string> = {};
  for (const p of providers) {
    const first = Object.keys(p.models)[0];
    if (first) defaultMap[p.id] = first;
  }
  // Override with Pi settings
  if (settings.defaultProvider && settings.defaultModel) {
    defaultMap[settings.defaultProvider] = settings.defaultModel;
  }

  return {
    providers,
    default: defaultMap,
  };
}

export function buildProviderResponse(models: PiModel[], settings: PiSettings) {
  const config = buildProvidersResponse(models, settings);
  return {
    all: config.providers,
    default: config.default,
    connected: config.providers.map(p => p.id),
  };
}

// Cache models for 60s
let cachedModels: PiModel[] | null = null;
let cachedAt = 0;
let cachedSettings: PiSettings | null = null;

export function getPiModels(): PiModel[] {
  const now = Date.now();
  if (cachedModels && now - cachedAt < 60_000) return cachedModels;
  cachedModels = loadPiModels();
  cachedAt = now;
  return cachedModels;
}

export function getPiSettings(): PiSettings {
  if (cachedSettings) return cachedSettings;
  cachedSettings = loadPiSettings();
  return cachedSettings;
}

export function getDefaultModelRef(): { providerID: string; modelID: string } {
  const s = getPiSettings();
  return { providerID: s.defaultProvider, modelID: s.defaultModel };
}
