/** What one author posted recently. Raids give themselves away by posting the same text everywhere. */
export interface Activity {
  windowMinutes: number;
  messages: number;
  channels: number;
  /** Earlier messages in the window with the same fingerprint as this one. */
  identicalMessages: number;
}

interface Seen {
  channelId: string;
  fingerprint: string;
  at: number;
}

const MAX_PER_AUTHOR = 50;

/** Recent messages per author, in memory: it starts empty when the bot restarts. */
export class AuthorHistory {
  readonly #windowMs: number;
  readonly #seen = new Map<string, Seen[]>();

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
  }

  /**
   * The author's activity in the window before `now`. Only messages strictly before `now`
   * count, so a message judged again (an edit, or a mark) does not count itself or later ones.
   */
  activity(authorId: string, fingerprint: string, now: number): Activity {
    const recent = this.#recent(authorId, now).filter((s) => s.at < now);
    return {
      windowMinutes: Math.round(this.#windowMs / 60_000),
      messages: recent.length,
      channels: new Set(recent.map((s) => s.channelId)).size,
      identicalMessages: fingerprint
        ? recent.filter((s) => s.fingerprint === fingerprint).length
        : 0,
    };
  }

  record(authorId: string, channelId: string, fingerprint: string, now: number): void {
    const list = this.#recent(authorId, now);
    list.push({ channelId, fingerprint, at: now });
    this.#seen.set(authorId, list.slice(-MAX_PER_AUTHOR));
  }

  /** Forgets authors with nothing left in the window, so the map does not grow without bound. */
  sweep(now: number): void {
    for (const [authorId, list] of this.#seen)
      if (!list.some((s) => now - s.at < this.#windowMs)) this.#seen.delete(authorId);
  }

  #recent(authorId: string, now: number): Seen[] {
    return (this.#seen.get(authorId) ?? []).filter((s) => now - s.at < this.#windowMs);
  }
}
