import { NextRequest, NextResponse } from 'next/server';
import { generateStrategyDraft } from '@/lib/ai/strategy';

export async function POST(request: NextRequest) {
  try {
    const { prompt } = (await request.json()) as { prompt?: string };
    if (!prompt || !prompt.trim()) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const draft = await generateStrategyDraft(prompt.trim());
    return NextResponse.json(draft);
  } catch (error) {
    console.error('AI strategy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate strategy' },
      { status: 500 }
    );
  }
}
