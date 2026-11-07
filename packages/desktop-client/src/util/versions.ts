// @ts-strict-ignore
function parseSemanticVersion(versionString): [number, number, number] {
  return versionString
    .replace('v', '')
    .split('.')
    .map(n => parseInt(n));
}

export function cmpSemanticVersion(
  versionStringA: string,
  versionStringB: string,
): number {
  const x = parseSemanticVersion(versionStringA);
  const y = parseSemanticVersion(versionStringB);

  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
