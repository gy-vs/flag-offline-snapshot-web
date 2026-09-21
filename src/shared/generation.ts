// Generation gate for export/delta builds.
//
// Requirements:
//   - a newer selection must invalidate an in-flight generation: when the older
//     generation settles its result must never overwrite the newer choice
//     ("旧生成任务不能覆盖新选择");
//   - the user can cancel the current generation;
//   - a cancelled generation cooperatively aborts via the AbortSignal.

export type GenerationResult<T> =
  | {status: 'completed'; value: T}
  | {status: 'cancelled'}
  | {status: 'superseded'}
  | {status: 'failed'; error: unknown};

export class GenerationCancelledError extends Error {
  constructor() {
    super('generation cancelled');
    this.name = 'GenerationCancelledError';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new GenerationCancelledError();
}

export class GenerationGate {
  private generation = 0;
  private controller: AbortController | null = null;
  private running = false;

  /**
   * Begin a new generation. Any previously running generation is marked
   * superseded and its signal aborted; its eventual result is dropped inside
   * `run` and can never reach callers of the newer generation.
   */
  begin(): {generation: number; signal: AbortSignal} {
    this.generation += 1;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.running = true;
    return {generation: this.generation, signal: controller.signal};
  }

  /** Cancel the current generation explicitly. */
  cancel(): boolean {
    if (!this.running) return false;
    this.running = false;
    this.controller?.abort();
    this.controller = null;
    return true;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run `producer` for the given generation. The producer should honour the
   * signal for cooperative cancellation.
   *
   * Resolves to 'superseded' when a newer selection began while the work was
   * in flight, 'cancelled' on explicit cancel, 'failed' when the producer
   * throws, and 'completed' only when the result still belongs to the latest
   * selection.
   */
  async run<T>(generation: number, signal: AbortSignal, producer: (signal: AbortSignal) => Promise<T>): Promise<GenerationResult<T>> {
    const markDone = () => {
      if (this.generation === generation && this.running) this.running = false;
    };
    if (generation !== this.generation) return {status: 'superseded'};
    try {
      const value = await producer(signal);
      if (generation !== this.generation) return {status: 'superseded'};
      if (signal.aborted) {
        markDone();
        return {status: 'cancelled'};
      }
      markDone();
      return {status: 'completed', value};
    } catch (error) {
      if (error instanceof GenerationCancelledError || signal.aborted) {
        markDone();
        return generation === this.generation ? {status: 'cancelled'} : {status: 'superseded'};
      }
      markDone();
      return {status: 'failed', error};
    }
  }
}
