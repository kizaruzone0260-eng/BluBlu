// Keep argon2 fast in tests; fixed secret so tokens are stable per process.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-0123456789';
process.env.ARGON2_MEMORY_COST ??= '8192';
process.env.ARGON2_TIME_COST ??= '1';
process.env.ARGON2_PARALLELISM ??= '1';
