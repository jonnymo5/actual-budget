import {
  fitLine,
  mean,
  median,
  quantile,
  roundMinor,
  roundTo,
  stdev,
  sum,
} from './statistics';

describe('descriptive statistics', () => {
  it('summarizes a list', () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
  });

  it('finds the median whatever the order and the length', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('interpolates quantiles between values', () => {
    const values = [10, 20, 30, 40, 50];
    expect(quantile(values, 0)).toBe(10);
    expect(quantile(values, 0.25)).toBe(20);
    expect(quantile(values, 0.9)).toBe(46);
    expect(quantile(values, 1)).toBe(50);
  });

  it('computes the population standard deviation', () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
    expect(stdev([5])).toBe(0);
    expect(stdev([3, 3, 3])).toBe(0);
  });
});

describe('fitLine', () => {
  it('recovers a straight line exactly', () => {
    const fit = fitLine([200, 230, 260, 290, 320]);
    expect(fit.slope).toBeCloseTo(30, 10);
    expect(fit.intercept).toBeCloseTo(200, 10);
    expect(fit.rSquared).toBeCloseTo(1, 10);
  });

  it('reports a flat series as slope zero with nothing explained', () => {
    expect(fitLine([50, 50, 50, 50])).toEqual({
      slope: 0,
      intercept: 50,
      rSquared: 0,
    });
  });

  it('explains little of a noisy series with no direction', () => {
    expect(fitLine([10, 40, 10, 40, 10, 40]).rSquared).toBeLessThan(0.1);
  });

  it('copes with too few points', () => {
    expect(fitLine([])).toEqual({ slope: 0, intercept: 0, rSquared: 0 });
    expect(fitLine([7])).toEqual({ slope: 0, intercept: 7, rSquared: 0 });
  });
});

describe('rounding', () => {
  it('rounds to whole minor units and never returns -0', () => {
    expect(roundMinor(12.5)).toBe(13);
    expect(Object.is(roundMinor(-0.2), 0)).toBe(true);
  });

  it('rounds to decimals after scaling', () => {
    expect(roundTo(0.12345, 3)).toBe(0.123);
    expect(roundTo(0.0856, 1, 100)).toBe(8.6);
    expect(Object.is(roundTo(-0.0001, 1), 0)).toBe(true);
  });
});
