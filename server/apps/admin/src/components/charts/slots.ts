/** A chart colour, in the fixed order of `--chart-1..5` (a series keeps its slot whatever else is drawn). */
export type ChartSlot = 1 | 2 | 3 | 4 | 5;

export const slotColor = (slot: ChartSlot) => `var(--chart-${slot})`;
