const runtimeFactories = new Map();

export function registerRuntime(id, factory) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Runtime id must be a non-empty string.");
  }
  if (typeof factory !== "function") {
    throw new Error(`Runtime factory for "${id}" must be a function.`);
  }
  runtimeFactories.set(id, factory);
}

export function hasRuntime(id) {
  return runtimeFactories.has(id);
}

export function listRuntimes() {
  return [...runtimeFactories.keys()];
}

export async function createRuntime(id, context) {
  const factory = runtimeFactories.get(id);
  if (!factory) {
    throw new Error(`Unknown Live2D runtime "${id}".`);
  }
  const runtime = await factory(context);
  if (!runtime || typeof runtime.setAvatarState !== "function") {
    throw new Error(`Runtime "${id}" must return an object with setAvatarState().`);
  }
  return runtime;
}
