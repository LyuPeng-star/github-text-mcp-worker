import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    ...options,
  });
}

function stop(message) {
  process.stderr.write(`deployment blocked: ${message}\n`);
  process.exit(1);
}

function pass(message) {
  process.stdout.write(`deployment guard: PASS ${message}\n`);
}

/*
 * SOURCE_COMMIT is a public commit SHA, so its --var value may be printed.
 * For every current or future --var whose name matches token, secret, key, or
 * password (case-insensitive), the value must be rendered as "(hidden)". Never
 * print environment values or an unsanitized argv.
 */
function sanitizeVar(specification) {
  const separator = specification.indexOf(":");
  if (separator < 0) return specification;
  const name = specification.slice(0, separator);
  if (/(token|secret|key|password)/i.test(name)) return `${name}:(hidden)`;
  return specification;
}

function sanitizeWranglerArgv(args) {
  const sanitized = ["wrangler"];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--var" && index + 1 < args.length) {
      sanitized.push(arg, sanitizeVar(args[index + 1]));
      index += 1;
    } else if (arg.startsWith("--var=")) {
      sanitized.push(`--var=${sanitizeVar(arg.slice("--var=".length))}`);
    } else {
      sanitized.push(arg);
    }
  }
  return sanitized;
}

for (const args of [["diff", "--exit-code"], ["diff", "--cached", "--exit-code"]]) {
  const result = run("git", args);
  if (result.status !== 0) stop(`git ${args.slice(0, -1).join(" ")} is not clean`);
  pass(`git ${args.join(" ")}`);
}

const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
if (status.status !== 0) stop("git status could not be read");
if (status.stdout.length !== 0) stop("tracked or untracked deployment inputs are pending");
pass("git status --porcelain=v1 --untracked-files=all");

const head = run("git", ["rev-parse", "--verify", "HEAD"]);
if (head.status !== 0) stop("HEAD could not be resolved; source archives can use npx wrangler deploy without a SOURCE_COMMIT");
const sourceCommit = head.stdout.trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) stop("HEAD is not a complete commit SHA");

const forwarded = process.argv.slice(2);
if (forwarded.some((arg) => arg === "--var" || arg.startsWith("--var="))) {
  stop("caller-supplied --var is forbidden; SOURCE_COMMIT is injected by this script");
}
if (forwarded.some((arg) => arg === "--tag" || arg.startsWith("--tag="))) {
  stop("caller-supplied --tag is forbidden; the source tag is injected by this script");
}

const sourceTag = `source-${sourceCommit.slice(0, 12)}`;
const wranglerArgs = [
  "deploy",
  "--var",
  `SOURCE_COMMIT:${sourceCommit}`,
  "--tag",
  sourceTag,
  ...forwarded,
];
pass(`HEAD ${sourceCommit}`);
pass(`tag ${sourceTag}`);
pass(`argv ${JSON.stringify(sanitizeWranglerArgv(wranglerArgs))}`);

const wrangler = run("wrangler", wranglerArgs, {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
if (wrangler.error) stop(`Wrangler could not start (${wrangler.error.name})`);
process.exit(wrangler.status ?? 1);
