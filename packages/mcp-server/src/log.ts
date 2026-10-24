// stdout carries the MCP protocol when running over stdio, so diagnostics
// always go to stderr.
export function log(message: string): void {
  process.stderr.write(`[actual-mcp] ${message}\n`);
}
