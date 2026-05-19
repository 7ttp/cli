const ROOT_FLAGS_WITH_VALUES = new Set([
  "--output-format",
  "--output",
  "--profile",
  "--workdir",
  "--network-id",
  "--dns-resolver",
  "--agent",
  "-o",
]);

const PROJECT_REF_PARENT_COMMANDS = new Set([
  "config",
  "encryption",
  "network-bans",
  "network-restrictions",
  "postgres-config",
  "secrets",
  "snippets",
  "ssl-enforcement",
  "vanity-subdomains",
]);

function splitFlag(arg: string) {
  const eq = arg.indexOf("=");
  return eq === -1
    ? { name: arg, hasInlineValue: false }
    : { name: arg.slice(0, eq), hasInlineValue: true };
}

function findRootCommandIndex(args: ReadonlyArray<string>) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) return -1;
    if (arg === "--") return -1;
    if (!arg.startsWith("-")) return i;
    const { name, hasInlineValue } = splitFlag(arg);
    if (ROOT_FLAGS_WITH_VALUES.has(name) && !hasInlineValue) i++;
  }
  return -1;
}

export function normalizeLegacyArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const commandIndex = findRootCommandIndex(args);
  if (commandIndex === -1) return args;

  const command = args[commandIndex];
  if (command === undefined || !PROJECT_REF_PARENT_COMMANDS.has(command)) return args;

  const prefix: string[] = [];
  const projectRef: string[] = [];

  for (let i = commandIndex + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) return args;
    if (arg === "--") return args;
    if (!arg.startsWith("-")) {
      if (projectRef.length === 0) return args;
      return [
        ...args.slice(0, commandIndex + 1),
        ...prefix,
        arg,
        ...projectRef,
        ...args.slice(i + 1),
      ];
    }

    const { name, hasInlineValue } = splitFlag(arg);
    if (name !== "--project-ref") {
      prefix.push(arg);
      if (ROOT_FLAGS_WITH_VALUES.has(name) && !hasInlineValue) {
        const value = args[i + 1];
        if (value === undefined) return args;
        prefix.push(value);
        i++;
      }
      continue;
    }

    projectRef.push(arg);
    if (!hasInlineValue) {
      const value = args[i + 1];
      if (value === undefined) return args;
      projectRef.push(value);
      i++;
    }
  }

  return args;
}
