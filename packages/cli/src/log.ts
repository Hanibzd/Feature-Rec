/* Tiny zero-dep logger with ANSI styling. */
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  accent: "\x1b[38;5;99m", // violet ~ brand
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

export const log = {
  banner(msg: string) {
    console.log(`\n${c.accent}${c.bold}▍AutoDemo${c.reset} ${c.bold}${msg}${c.reset}`);
  },
  step(msg: string) {
    console.log(`${c.accent}▸${c.reset} ${msg}`);
  },
  info(msg: string) {
    console.log(`  ${c.dim}${msg}${c.reset}`);
  },
  ok(msg: string) {
    console.log(`  ${c.green}✓${c.reset} ${msg}`);
  },
  warn(msg: string) {
    console.log(`  ${c.yellow}!${c.reset} ${msg}`);
  },
  error(msg: string) {
    console.log(`  ${c.red}✗${c.reset} ${msg}`);
  },
  done(msg: string) {
    console.log(`${c.green}${c.bold}✓ ${msg}${c.reset}\n`);
  },
};
