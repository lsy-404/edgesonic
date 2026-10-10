export function createRequestEpoch() {
  let current = 0;

  return {
    begin(): number {
      current += 1;
      return current;
    },
    invalidate(): void {
      current += 1;
    },
    isCurrent(epoch: number): boolean {
      return epoch === current;
    },
  };
}
