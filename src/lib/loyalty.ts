export const earnedPoints = (cardAmount: number) => Math.floor(cardAmount / 100) * 10;
export const maxPoints = (amount: number, balance: number) => Math.max(0, Math.min(balance, Math.floor(amount / 2)));
