// Browser-side Telegram client.
//
// There is deliberately no token in this file. It runs in the client bundle, so anything
// held here would be readable by every visitor. Messages go through /api/telegram, which
// signs them with the server's TELEGRAM_BOT_TOKEN (no NEXT_PUBLIC_ prefix, so Next.js
// never inlines it into the bundle). Same route automation.ts uses.

const PROXY = '/api/telegram';

class TelegramBot {
  // Posts through the server proxy. Returns false rather than throwing: notifications are
  // never allowed to break the caller's trading flow.
  private async post(chatId: string, text: string): Promise<boolean> {
    if (!chatId) {
      console.error('❌ Telegram chat id is missing');
      return false;
    }

    try {
      const response = await fetch(PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, text }),
        signal: AbortSignal.timeout(15000),
      });

      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        console.error('❌ Telegram send failed:', body.error ?? `proxy ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      // Network failure, abort, or a non-JSON response
      console.error('❌ Telegram send failed:', (error as Error).message);
      return false;
    }
  }

  async sendPriceAlert(chatId: string, price: number, targetPrice: number, condition: string): Promise<boolean> {
    const emoji = condition === 'above' ? '📈' : '📉';
    const direction = condition === 'above' ? 'rose above' : 'fell below';

    return this.post(
      chatId,
      `🚨 XLM PRICE ALERT

${emoji} Price ${direction} your target.

💰 Current: $${price.toFixed(4)}
🎯 Target: $${targetPrice}
⏰ ${new Date().toLocaleString('en-US')}`
    );
  }

  async sendTestMessage(chatId: string, currentPrice: number): Promise<boolean> {
    return this.post(
      chatId,
      `🧪 TEST MESSAGE

✅ Notifications are working.
💰 XLM: $${currentPrice.toFixed(4)}
⏰ ${new Date().toLocaleString('en-US')}`
    );
  }

  async sendMessage(chatId: string, message: string): Promise<boolean> {
    return this.post(chatId, message);
  }
}

export const telegramBot = new TelegramBot();
