import { NextRequest, NextResponse } from 'next/server';

// Telegram proxy so the bot token stays on the server.
// Configure TELEGRAM_BOT_TOKEN (no NEXT_PUBLIC_ prefix) and the browser never sees it.

const API = 'https://api.telegram.org/bot';

const missingToken = () =>
  NextResponse.json(
    { error: 'TELEGRAM_BOT_TOKEN is not configured on the server' },
    { status: 400 }
  );

// GET /api/telegram → reads the chat id from the bot's pending updates
export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return missingToken();

  try {
    const response = await fetch(`${API}${token}/getUpdates`, { signal: AbortSignal.timeout(15000) });
    const body = (await response.json()) as {
      ok?: boolean;
      description?: string;
      result?: Array<{ message?: { chat?: { id?: number } }; channel_post?: { chat?: { id?: number } } }>;
    };

    if (!response.ok || !body.ok) {
      return NextResponse.json({ error: body.description ?? `Telegram API ${response.status}` }, { status: 502 });
    }

    const ids = (body.result ?? [])
      .map(update => update.message?.chat?.id ?? update.channel_post?.chat?.id)
      .filter((id): id is number => typeof id === 'number');

    return NextResponse.json({ chatId: ids.length ? String(ids[ids.length - 1]) : null });
  } catch (error) {
    console.error('❌ Telegram getUpdates failed:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}

// POST /api/telegram { chatId, text }
export async function POST(request: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return missingToken();

  let chatId: string | undefined;
  let text: string | undefined;
  try {
    ({ chatId, text } = (await request.json()) as { chatId?: string; text?: string });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!chatId || !text) {
    return NextResponse.json({ error: 'chatId and text are required' }, { status: 400 });
  }

  try {
    const response = await fetch(`${API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15000),
    });
    const body = (await response.json()) as { ok?: boolean; description?: string };

    if (!response.ok || !body.ok) {
      return NextResponse.json({ error: body.description ?? `Telegram API ${response.status}` }, { status: 502 });
    }
    return NextResponse.json({ sent: true });
  } catch (error) {
    console.error('❌ Telegram sendMessage failed:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
