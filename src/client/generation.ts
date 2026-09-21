// Latest-wins gate for asynchronous generation tasks.
// A task captures a token when it starts; whenever the user changes the
// selection (or cancels), earlier tokens stop being current, so a stale
// task that finishes late can never overwrite a newer selection.
export type TaskGate = {
  begin(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
};

export function createTaskGate(): TaskGate {
  let sequence = 0;
  return {
    begin() {
      return ++sequence;
    },
    isCurrent(token: number) {
      return token === sequence;
    },
    invalidate() {
      sequence++;
    },
  };
}
