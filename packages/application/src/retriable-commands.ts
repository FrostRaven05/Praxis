/** Keeps an unconfirmed command stable until its result is acknowledged. */
export class RetriableCommands<Command> {
  private pending = new Map<string, Command>();
  private saving = new Set<string>();
  async execute<Result>(
    key: string,
    matches: (command: Command) => boolean,
    create: () => Command,
    send: (command: Command) => Promise<Result>,
    rejected?: (error: unknown) => boolean,
  ): Promise<{ command: Command; result: Result }> {
    if (this.saving.has(key)) throw new Error("正在保存，请稍候");
    let command = this.pending.get(key);
    if (!command || !matches(command)) {
      command = create();
      this.pending.set(key, command);
    }
    this.saving.add(key);
    try {
      const result = await send(command);
      this.pending.delete(key);
      return { command, result };
    } catch (error) {
      if (rejected?.(error)) this.pending.delete(key);
      throw error;
    } finally {
      this.saving.delete(key);
    }
  }
}
