const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl && process.env.ALLOW_NONLOCAL_TEST_DATABASE !== "1") {
  let host: string | null = null;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL; refusing to run tests.");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(host)) {
    throw new Error(
      `Refusing to run tests with non-local DATABASE_URL host "${host}". ` +
        "These tests create and delete rows; use apps/web/docker-compose.yml " +
        "or set ALLOW_NONLOCAL_TEST_DATABASE=1 only for an intentional disposable database."
    );
  }
}
