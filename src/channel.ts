import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk";
import type { CoreConfig } from "./types.js";
import {
  listWeChatPadProAccountIds,
  resolveDefaultWeChatPadProAccountId,
  resolveWeChatPadProAccount,
  type ResolvedWeChatPadProAccount,
} from "./accounts.js";
import { WeChatPadProConfigSchema } from "./config-schema.js";
import { monitorWeChatPadProProvider } from "./monitor.js";
import {
  looksLikeWeChatPadProTargetId,
  normalizeWeChatPadProMessagingTarget,
} from "./normalize.js";
import { getWeChatPadProRuntime } from "./runtime.js";
import { sendMessageWeChatPadPro } from "./send.js";

const meta = {
  id: "wechatpadpro",
  label: "WeChatPadPro",
  selectionLabel: "WeChatPadPro (861 server)",
  docsPath: "/channels/wechatpadpro",
  docsLabel: "wechatpadpro",
  blurb: "WeChat integration via WeChatPadPro 861 server.",
  aliases: ["wxp", "wechat861"],
  order: 70,
  quickstartAllowFrom: true,
};

type WeChatPadProSetupInput = ChannelSetupInput & {
  serverUrl?: string;
  wxid?: string;
  authcode?: string;
};

export const wechatpadproPlugin: ChannelPlugin<ResolvedWeChatPadProAccount> = {
  id: "wechatpadpro",
  meta,
  pairing: {
    idLabel: "wechatWxid",
    normalizeAllowEntry: (entry) =>
      entry.replace(/^(wechatpadpro|wxp|wechat861):/i, "").toLowerCase(),
    notifyApproval: async ({ id }) => {
      console.log(`[wechatpadpro] User ${id} approved for pairing`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wechatpadpro"] },
  configSchema: buildChannelConfigSchema(WeChatPadProConfigSchema),
  config: {
    listAccountIds: (cfg) => listWeChatPadProAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveWeChatPadProAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWeChatPadProAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "wechatpadpro",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "wechatpadpro",
        accountId,
        clearBaseFields: ["serverUrl", "wxid", "authcode", "name"],
      }),
    isConfigured: (account) =>
      Boolean(
        account.serverUrl?.trim() && (account.authcode?.trim() || account.wxid?.trim()),
      ),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(
        account.serverUrl?.trim() && (account.authcode?.trim() || account.wxid?.trim()),
      ),
      serverUrl: account.serverUrl ? "[set]" : "[missing]",
      wxid: account.wxid ? "[set]" : "[missing]",
      authcode: account.authcode ? "[set]" : "[missing]",
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (
        resolveWeChatPadProAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []
      ).map((entry) => String(entry).toLowerCase()),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(wechatpadpro|wxp|wechat861):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        cfg.channels?.wechatpadpro?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.wechatpadpro.accounts.${resolvedAccountId}.`
        : "channels.wechatpadpro.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("wechatpadpro"),
        normalizeEntry: (raw) => raw.replace(/^(wechatpadpro|wxp|wechat861):/i, "").toLowerCase(),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- WeChatPadPro groups: groupPolicy="open" allows any member in groups to trigger. Set channels.wechatpadpro.groupPolicy="allowlist" + channels.wechatpadpro.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  messaging: {
    normalizeTarget: normalizeWeChatPadProMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeWeChatPadProTargetId,
      hint: "<wxid>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "wechatpadpro",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      const setupInput = input as WeChatPadProSetupInput;
      if (!setupInput.serverUrl) {
        return "WeChatPadPro requires --server-url (e.g., http://120.48.170.187:8061).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const setupInput = input as WeChatPadProSetupInput;
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "wechatpadpro",
        accountId,
        name: setupInput.name,
      });
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            wechatpadpro: {
              ...namedConfig.channels?.wechatpadpro,
              enabled: true,
              serverUrl: setupInput.serverUrl,
              wxid: setupInput.wxid,
              authcode: setupInput.authcode,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          wechatpadpro: {
            ...namedConfig.channels?.wechatpadpro,
            enabled: true,
            accounts: {
              ...namedConfig.channels?.wechatpadpro?.accounts,
              [accountId]: {
                ...namedConfig.channels?.wechatpadpro?.accounts?.[accountId],
                enabled: true,
                serverUrl: setupInput.serverUrl,
                wxid: setupInput.wxid,
                authcode: setupInput.authcode,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const result = await sendMessageWeChatPadPro(to, text, {
        accountId: accountId ?? undefined,
      });
      return { channel: "wechatpadpro", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const messageWithMedia = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendMessageWeChatPadPro(to, messageWithMedia, {
        accountId: accountId ?? undefined,
      });
      return { channel: "wechatpadpro", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      serverUrl: snapshot.serverUrl ?? "[missing]",
      wxid: snapshot.wxid ?? "[missing]",
      authcode: snapshot.authcode ?? "[missing]",
      running: snapshot.running ?? false,
      mode: "webhook",
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(
        account.serverUrl?.trim() && (account.authcode?.trim() || account.wxid?.trim()),
      );
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        serverUrl: account.serverUrl ? "[set]" : "[missing]",
        wxid: account.wxid ? "[set]" : "[missing]",
        authcode: account.authcode ? "[set]" : "[missing]",
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: "webhook",
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.serverUrl) {
        throw new Error(
          `WeChatPadPro not configured for account "${account.accountId}" (missing serverUrl)`,
        );
      }

      ctx.log?.info(`[${account.accountId}] starting WeChatPadPro monitor`);

      const { stop } = await monitorWeChatPadProProvider({
        accountId: account.accountId,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });

      return { stop };
    },
  },
};
