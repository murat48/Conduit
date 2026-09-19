import Anthropic from '@anthropic-ai/sdk';
import { ASSET_OPTIONS } from '../constants';

// Server-only: turns a free-text strategy description into automation-rule fields.
// Provider is switchable via AI_PROVIDER without touching this file's callers —
// 'gemini' (free, used locally) or 'anthropic' (used once shipped). Never import this
// module from a client component: it reads server-only API keys from process.env.

export interface StrategyDraft {
  clarification?: string;
  explanation: string;
  mode?: 'trade' | 'portfolio';
  minAmount?: string;
  maxPriceImpact?: string;
  trade?: {
    asset: string; // resolved contract address
    buyPercent?: number;
    buyBelowUsdc?: string;
    sellAboveUsdc?: string;
    sellPercent?: number;
    offramp?: boolean;
  };
  allocations?: { asset: string; percent: number }[];
}

interface RawToolArgs {
  clarification?: string;
  explanation: string;
  mode?: 'trade' | 'portfolio';
  minAmount?: string;
  maxPriceImpact?: string;
  trade?: {
    assetSymbol?: string;
    buyPercent?: number;
    buyBelowUsdc?: string;
    sellAboveUsdc?: string;
    sellPercent?: number;
    offramp?: boolean;
  };
  allocations?: { assetSymbol: string; percent: number }[];
}

const TOOL_NAME = 'set_automation_rule';
const TOOL_DESCRIPTION =
  "Fill in a Stellar trading automation rule from the user's plain-language strategy. " +
  'If required information is missing or ambiguous, call this with ONLY `clarification` set to a specific ' +
  'question and leave every other field unset — never guess a number the user did not imply.';

const ASSET_SYMBOLS = ASSET_OPTIONS.map(asset => asset.symbol);

// Overridable without a code change — set GEMINI_MODEL / ANTHROPIC_MODEL in .env.local
// to point at a newer model release; these are the defaults when unset.
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    clarification: {
      type: 'string',
      description: 'A question for the user, set ONLY when the request is too ambiguous to fill the fields below confidently.',
    },
    explanation: {
      type: 'string',
      description: 'One short plain-language sentence restating the configured rule, shown to the user before they confirm it.',
    },
    mode: { type: 'string', enum: ['trade', 'portfolio'] },
    minAmount: {
      type: 'string',
      description: 'Minimum incoming USDC amount (plain number as a string, e.g. "1") that triggers the rule. Default to "1" if not mentioned.',
    },
    maxPriceImpact: {
      type: 'string',
      description: 'Max allowed price impact percent as a string, e.g. "3". Omit if not mentioned.',
    },
    trade: {
      type: 'object',
      description: 'Only when mode is "trade": buy/sell a single asset on price conditions.',
      properties: {
        assetSymbol: { type: 'string', description: `One of: ${ASSET_SYMBOLS.join(', ')}` },
        buyPercent: { type: 'number', description: '0-100, share of incoming USDC to spend buying.' },
        buyBelowUsdc: { type: 'string', description: 'Only buy while price is at/below this many USDC. Omit if no condition.' },
        sellAboveUsdc: { type: 'string', description: 'Sell once price reaches this many USDC. Omit if selling is not part of the strategy.' },
        sellPercent: { type: 'number', description: '0-100, share of the held asset to sell when the sell condition triggers.' },
        offramp: { type: 'boolean', description: 'true if proceeds should be cashed out to TRY after selling.' },
      },
    },
    allocations: {
      type: 'array',
      description: 'Only when mode is "portfolio": how to split incoming USDC across assets.',
      items: {
        type: 'object',
        properties: {
          assetSymbol: { type: 'string', description: `One of: ${ASSET_SYMBOLS.join(', ')}` },
          percent: { type: 'number' },
        },
        required: ['assetSymbol', 'percent'],
      },
    },
  },
  required: ['explanation'],
};

const SYSTEM_PROMPT =
  "You configure a Stellar/Soroswap automated trading rule from a user's plain-language description. " +
  'All price thresholds the user mentions are denominated in USDC — the currency the automation actually trades against. ' +
  `Only these asset symbols exist: ${ASSET_SYMBOLS.join(', ')}. If the user names something else, ask via clarification. ` +
  'Always call the set_automation_rule tool — never answer in plain text.';

function resolveAssets(raw: RawToolArgs): StrategyDraft {
  if (raw.clarification) return { clarification: raw.clarification, explanation: raw.explanation };

  const findAsset = (symbol: string | undefined) =>
    ASSET_OPTIONS.find(option => option.symbol.toUpperCase() === (symbol ?? '').toUpperCase());

  const draft: StrategyDraft = {
    explanation: raw.explanation,
    mode: raw.mode,
    minAmount: raw.minAmount,
    maxPriceImpact: raw.maxPriceImpact,
  };

  if (raw.trade) {
    const match = findAsset(raw.trade.assetSymbol);
    if (!match) {
      return {
        explanation: raw.explanation,
        clarification: `I don't recognize the asset "${raw.trade.assetSymbol}". Supported: ${ASSET_SYMBOLS.join(', ')}.`,
      };
    }
    draft.trade = { ...raw.trade, asset: match.value };
  }

  if (raw.allocations?.length) {
    const resolved: { asset: string; percent: number }[] = [];
    for (const row of raw.allocations) {
      const match = findAsset(row.assetSymbol);
      if (!match) {
        return {
          explanation: raw.explanation,
          clarification: `I don't recognize the asset "${row.assetSymbol}". Supported: ${ASSET_SYMBOLS.join(', ')}.`,
        };
      }
      resolved.push({ asset: match.value, percent: row.percent });
    }
    draft.allocations = resolved;
  }

  return draft;
}

async function callAnthropic(prompt: string): Promise<RawToolArgs> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system: SYSTEM_PROMPT,
    tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: TOOL_PARAMETERS as Anthropic.Tool.InputSchema }],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: prompt }],
  });

  const block = response.content.find(
    (item): item is Anthropic.ToolUseBlock => item.type === 'tool_use'
  );
  if (!block) throw new Error('Model did not return a tool call');
  return block.input as RawToolArgs;
}

async function callGemini(prompt: string): Promise<RawToolArgs> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      input: `${SYSTEM_PROMPT}\n\nUser strategy: ${prompt}`,
      tools: [{ type: 'function', name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS }],
      generation_config: {
        tool_choice: { allowed_tools: { mode: 'any', tools: [TOOL_NAME] } },
      },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const call = (data.steps as { type: string; name: string; arguments: RawToolArgs }[] | undefined)?.find(
    step => step.type === 'function_call'
  );
  if (!call) throw new Error('Model did not return a function call');
  return call.arguments;
}

export async function generateStrategyDraft(prompt: string): Promise<StrategyDraft> {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  const raw = provider === 'anthropic' ? await callAnthropic(prompt) : await callGemini(prompt);
  return resolveAssets(raw);
}
