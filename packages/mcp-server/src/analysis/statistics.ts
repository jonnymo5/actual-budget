export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/** Linear-interpolated quantile (`q` from 0 to 1) of an ascending list. */
export function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function quantile(values: number[], q: number): number {
  return quantileSorted(
    [...values].sort((a, b) => a - b),
    q,
  );
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

/** Population standard deviation; 0 for fewer than two values. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

export type LineFit = {
  /** Change in y per step of x. */
  slope: number;
  intercept: number;
  /** How much of the variation the line explains, 0 to 1 (0 for a flat line). */
  rSquared: number;
};

/** Least-squares line through `values`, with x = 0, 1, 2, ... */
export function fitLine(values: number[]): LineFit {
  const count = values.length;
  if (count < 2) return { slope: 0, intercept: values[0] ?? 0, rSquared: 0 };

  const averageX = (count - 1) / 2;
  const averageY = mean(values);
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  values.forEach((value, x) => {
    covariance += (x - averageX) * (value - averageY);
    varianceX += (x - averageX) ** 2;
    varianceY += (value - averageY) ** 2;
  });

  const slope = covariance / varianceX;
  return {
    slope,
    intercept: averageY - slope * averageX,
    rSquared: varianceY === 0 ? 0 : covariance ** 2 / (varianceX * varianceY),
  };
}

/** Rounds to a whole number of minor units without ever producing -0. */
export function roundMinor(value: number): number {
  return Math.round(value) + 0;
}

/** `value` times `scale`, rounded to `places` decimals. */
export function roundTo(value: number, places: number, scale = 1): number {
  const factor = 10 ** places;
  return Math.round(value * scale * factor) / factor + 0;
}
