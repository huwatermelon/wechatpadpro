import { DEFAULT_ACCOUNT_ID, isTruthyEnvValue, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, WeChatPadProAccountConfig } from "./types.js";

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_WECHATPADPRO_ACCOUNTS)) {
    console.warn("[wechatpadpro:accounts]", ...args);
  }
};

export type ResolvedWeChatPadProAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  serverUrl: string;
  /** Auth code for API authentication (replaces direct wxid for API auth). */
  authcode?: string;
  wxid?: string;
  config: WeChatPadProAccountConfig;
};

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.wechatpadpro?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) {
      continue;
    }
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

export function listWeChatPadProAccountIds(cfg: CoreConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  debugAccounts("listWeChatPadProAccountIds", ids);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultWeChatPadProAccountId(cfg: CoreConfig): string {
  const ids = listWeChatPadProAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): WeChatPadProAccountConfig | undefined {
  const accounts = cfg.channels?.wechatpadpro?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as WeChatPadProAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as WeChatPadProAccountConfig | undefined) : undefined;
}

function mergeWeChatPadProAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): WeChatPadProAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.wechatpadpro ??
    {}) as WeChatPadProAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveWeChatPadProAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedWeChatPadProAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.wechatpadpro?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeWeChatPadProAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const serverUrl = merged.serverUrl?.trim()?.replace(/\/$/, "") ?? "";

    debugAccounts("resolve", {
      accountId,
      enabled,
      serverUrl: serverUrl ? "[set]" : "[missing]",
      wxid: merged.wxid ? "[set]" : "[missing]",
      authcode: merged.authcode ? "[set]" : "[missing]",
    });

    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      serverUrl,
      authcode: merged.authcode?.trim() || undefined,
      wxid: merged.wxid?.trim() || undefined,
      config: merged,
    } satisfies ResolvedWeChatPadProAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.serverUrl) {
    return primary;
  }

  const fallbackId = resolveDefaultWeChatPadProAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.serverUrl) {
    return primary;
  }
  return fallback;
}

export function listEnabledWeChatPadProAccounts(
  cfg: CoreConfig,
): ResolvedWeChatPadProAccount[] {
  return listWeChatPadProAccountIds(cfg)
    .map((accountId) => resolveWeChatPadProAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
