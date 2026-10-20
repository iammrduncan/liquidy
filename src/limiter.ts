/**
 * Runs at most `max` tasks at once; the rest wait in arrival order. A finishing task hands its
 * slot straight to the next waiter, so a newcomer cannot slip in between and exceed `max`.
 */
export function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
