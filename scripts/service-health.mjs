const port = process.env.PORT ?? '3001';
try {
  if (!/^\d+$/.test(port)) throw new Error();
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error();
} catch { process.exitCode = 1; }
