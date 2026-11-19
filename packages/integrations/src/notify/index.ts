/** Operator notifications (roadmap: "clips ready", failures, token revoked). */
export interface Notifier {
  readonly name: string;
  send(text: string): Promise<void>;
}

/** Telegram Bot API. Create a bot with @BotFather; the chat id is your user or group id. */
export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';
  constructor(private readonly opts: { botToken: string; chatId: string; apiBase?: string }) {}

  async send(text: string): Promise<void> {
    const res = await fetch(`${this.opts.apiBase ?? 'https://api.telegram.org'}/bot${this.opts.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.opts.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
}

/** No channel configured: notifications only go to the log. */
export class LogNotifier implements Notifier {
  readonly name = 'log';
  constructor(private readonly log: (text: string) => void = () => undefined) {}
  async send(text: string): Promise<void> {
    this.log(text);
  }
}
