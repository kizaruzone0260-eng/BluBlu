#!/bin/sh
# Checks the RUNTIME layer of apps/api/Dockerfile from inside the container.
#
# It is a file rather than an inline `sh -c '…'` in the workflow for one reason: inside a
# single-quoted shell string you cannot write `require("fastify")` without the `'"'"'` acrobatics,
# and the first version of that check died on exactly that (`Syntax error: Unterminated quoted
# string`, run 38049533552). Fed to `docker run -i --entrypoint sh … < this file`, quoting is
# ordinary again.
#
# What it proves:
#  - no dev dependency resolves from apps/api — pnpm's strict layout resolves only DIRECT
#    dependencies there, so a resolvable vitest means a dev dependency shipped (measured before the
#    `deps` stage: run 38045464863);
#  - the production logger still works: fastify is started with a logger inside the image, which is
#    pino running as fastify's own production dependency — not as our devDependency.
set -e
cd /repo/apps/api

echo "dev-tool packages still in the pnpm store: $(ls /repo/node_modules/.pnpm | grep -cE '^(vitest|tsx|drizzle-kit|typescript|embedded-postgres)@' || true)"
for m in vitest tsx drizzle-kit typescript embedded-postgres @types/ws; do
  if node -e 'require.resolve(process.argv[1])' "$m" >/dev/null 2>&1; then
    echo "FAIL: $m is resolvable from the runtime layer"
    exit 1
  fi
  echo "absent: $m"
done

node -e 'const F = require("fastify"); const a = F({ logger: { level: "info" } }); a.log.info("fastify and its pino logger work in the runtime layer")'
echo "pino in the store: $(ls /repo/node_modules/.pnpm | grep -E '^pino@' | head -1)"
