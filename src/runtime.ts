import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWeChatPadProRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWeChatPadProRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeChatPadPro runtime not initialized");
  }
  return runtime;
}
