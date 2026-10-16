export class DraftBuffer {
  value: string;
  committed: string;
  private cancelPending?: () => void;

  constructor(
    value: string,
    private commit: (value: string) => void,
    private schedule = (callback: () => void) => {
      const timer = setTimeout(callback, 500);
      return () => clearTimeout(timer);
    }
  ) {
    this.value = this.committed = value;
  }

  update = (value: string) => {
    this.cancelPending?.();
    this.value = value;
    this.cancelPending = this.schedule(this.flush);
  };

  flush = () => {
    this.cancelPending?.();
    this.cancelPending = undefined;
    if (this.value === this.committed) return;
    this.committed = this.value;
    this.commit(this.value);
  };

  reset = (value: string) => {
    this.cancelPending?.();
    this.cancelPending = undefined;
    this.value = this.committed = value;
  };
}
