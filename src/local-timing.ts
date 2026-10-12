type Event = { label: string; start_ms: number; end_ms: number; parent?: number; ok: boolean };
export type LocalTiming = { id: string; kind: string; started_at_ms: number; ended_at_ms?: number;
  events: Event[]; context: Record<string, unknown>; current?: number };
const traces = new WeakMap<object, LocalTiming>();
export const LOCAL_TIMING_RUN = "20261012-one-job";

async function localTimingIo<T>(env: object, label: string, operation: () => Promise<T>): Promise<T> {
  const trace = traces.get(env)!;
  const event: Event = { label, start_ms: Date.now(), end_ms: 0, parent: trace.current, ok: false };
  trace.events.push(event);
  try { const result = await operation(); event.ok = true; return result; }
  finally { event.end_ms = Date.now(); }
}

export async function localTimingSpan<T>(env: object, label: string, operation: () => Promise<T>): Promise<T> {
  const trace = traces.get(env);
  if (!trace) return operation();
  const parent = trace.current;
  const index = trace.events.length;
  trace.events.push({ label, start_ms: Date.now(), end_ms: 0, parent, ok: false });
  trace.current = index;
  try {
    const result = await operation();
    trace.events[index]!.ok = true;
    return result;
  } finally {
    trace.events[index]!.end_ms = Date.now();
    trace.current = parent;
  }
}

export function localTimingEnvironment<T extends { CASTLOOP_BUCKET: object }>(env: T, kind: string,
  context: Record<string, unknown> = {}): { env: T; trace: LocalTiming } {
  const trace: LocalTiming = { id: crypto.randomUUID(), kind, started_at_ms: Date.now(), events: [], context };
  const result = { ...env };
  traces.set(result, trace);
  result.CASTLOOP_BUCKET = new Proxy(env.CASTLOOP_BUCKET, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const key = typeof args[0] === "string" ? args[0] : property === "list" ? JSON.stringify(args[0]) : "batch";
        const output: unknown = await localTimingIo(result, `r2.${String(property)}:${key}`, async () => Reflect.apply(value, target, args));
        if (property !== "get" || !output || typeof output !== "object") return output;
        return new Proxy(output, {
          get(object, name) {
            const field: unknown = Reflect.get(object, name, object);
            if (typeof field !== "function") return field;
            if (!["text", "json", "arrayBuffer", "blob"].includes(String(name))) return field.bind(object);
            return (...values: unknown[]) => localTimingIo(result, `r2.body.${String(name)}:${key}`, async () => Reflect.apply(field, object, values));
          },
        });
      };
    },
  });
  return { env: result, trace };
}

export function finishLocalTiming(trace: LocalTiming): string {
  trace.ended_at_ms = Date.now();
  const { current: _current, ...report } = trace;
  return JSON.stringify({ run: LOCAL_TIMING_RUN, ...report });
}
