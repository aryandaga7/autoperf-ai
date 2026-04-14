/** Tracks cumulative cost across CC subprocess invocations. */
export class CostTracker {
  private totalUsd = 0;
  private budgetUsd: number;

  constructor(budgetUsd: number) {
    this.budgetUsd = budgetUsd;
  }

  add(costUsd: number): void {
    this.totalUsd += costUsd;
  }

  getTotal(): number {
    return this.totalUsd;
  }

  getRemaining(): number {
    return Math.max(0, this.budgetUsd - this.totalUsd);
  }

  isOverBudget(): boolean {
    return this.totalUsd >= this.budgetUsd;
  }
}
