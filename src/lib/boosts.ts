// Brand-funded "boosts": a listed company pays Stockback to multiply the stock-back its
// customers earn, turning shoppers into shareholders. This is the main revenue line
// alongside FEE_RATE. The entries below are illustrative demo sponsors, not real deals.
export const FEE_RATE = 0.01;

export const BOOSTS: Record<string, { multiplier: number; label: string }> = {
  LULU: { multiplier: 3, label: "3× stock-back week" },
  CELH: { multiplier: 2, label: "2× on Celsius" },
  COST: { multiplier: 2, label: "2× for members" },
};
