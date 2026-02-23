import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk";
import type {
  CoreConfig,
  WeChatPadProInboundMessage,
} from "./types.js";
import { resolveWeChatPadProAccount, type ResolvedWeChatPadProAccount } from "./accounts.js";
import { handleWeChatPadProInbound } from "./inbound.js";
import { getWeChatPadProRuntime } from "./runtime.js";

/** Shared processed message IDs per account (for webhook + polling dedup). */
const processedIdsByAccountId = new Map<string, Set<string>>();

function getOrCreateProcessedIds(accountId: string): Set<string> {
  let s = processedIdsByAccountId.get(accountId);
  if (!s) {
    s = new Set<string>();
    processedIdsByAccountId.set(accountId, s);
  }
  return s;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export type WeChatPadProMonitorOptions = {
  config?: CoreConfig;
  accountId?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    connected?: boolean;
    lastConnectedAt?: number;
    lastDisconnect?: { at: number; status?: number; error?: string };
  }) => void;
  onMessage?: (message: WeChatPadProInboundMessage) => void | Promise<void>;
};

function extractStr(field: unknown): string {
  if (field == null) return "";
  if (typeof field === "string") return field;
  if (typeof field === "object" && field !== null) {
    const obj = field as Record<string, unknown>;
    // protobuf SKBuiltinStringT serializes as {"string": "..."} or {"str": "..."}
    for (const key of ["string", "str", "String_", "String"]) {
      if (key in obj && typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return String(field);
}

/** Parse ws861 sync AddMsg to WeChatPadProInboundMessage. */
export function parseSyncMessageToInbound(
  msg: Record<string, unknown>,
  botWxid: string,
): WeChatPadProInboundMessage | null {
  const fromUser =
    extractStr(msg.fromUser ?? msg.from_user_name ?? msg.FromUserName ?? msg.from_user) || "";
  const toUser =
    extractStr(msg.toUser ?? msg.to_user_name ?? msg.ToUserName ?? msg.to_user) || "";
  const content =
    extractStr(msg.content ?? msg.Content) || "";
  const msgType = msg.msgType ?? msg.msg_type ?? msg.MsgType ?? msg.type;
  const numType = Number(msgType);

  // Only handle text(1) and app(49) for now
  if (numType !== 1 && numType !== 49) return null;

  const messageId =
    String(msg.new_msg_id ?? msg.NewMsgId ?? msg.newMsgId ?? msg.MsgId ?? msg.msg_id ?? msg.msgId ?? "").trim() ||
    `sync-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const createTime = Number(
    msg.create_time ?? msg.CreateTime ?? msg.createTime ?? msg.timestamp ?? Date.now(),
  );
  const timestamp = createTime > 1e12 ? createTime : createTime * 1000;

  const isGroupChat = fromUser.includes("@chatroom") || toUser.includes("@chatroom");
  const groupWxid = isGroupChat ? (fromUser.includes("@chatroom") ? fromUser : toUser) : undefined;

  // Bot is the receiver (toUser is bot in incoming msg from others)
  const senderWxid = fromUser || "";
  const wxid = toUser || botWxid;

  let text = content.trim();
  if (numType === 49 && text) {
    // type=49: use raw content for now; could parse XML like bridge.ts parseAppMessage
    const titleMatch = text.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
    if (titleMatch) text = titleMatch[1].trim();
  }
  if (!text) return null;

  return {
    messageId,
    wxid,
    senderWxid,
    senderName: undefined,
    text,
    timestamp,
    isGroupChat,
    groupWxid,
    groupName: undefined,
    msgType: numType,
    rawContent: content || undefined,
  };
}

function extractAddMsgs(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const addMsgs = (obj.AddMsgs ?? (obj.Data as Record<string, unknown> | undefined)?.AddMsgs) as
    | unknown[]
    | undefined;
  return Array.isArray(addMsgs) ? addMsgs.filter((m): m is Record<string, unknown> => m != null && typeof m === "object") : [];
}

const MAX_PROCESSED_IDS = 5000;

/**
 * Handle webhook POST from OpenClaw gateway.
 * The payload is the ws861 sync response JSON.
 */
export async function handleWebhookPost(
  payload: unknown,
  account: ResolvedWeChatPadProAccount,
  opts: {
    config: CoreConfig;
    runtime: RuntimeEnv;
    statusSink?: WeChatPadProMonitorOptions["statusSink"];
    onMessage?: WeChatPadProMonitorOptions["onMessage"];
    processedIds?: Set<string>;
  },
): Promise<void> {
  const processedIds =
    opts.processedIds ?? getOrCreateProcessedIds(account.accountId);
  const addMsgs = extractAddMsgs(payload);
  const botWxid = account.wxid?.trim() || "";

  for (const m of addMsgs) {
    if (m.isHistory === true) continue;
    const inbound = parseSyncMessageToInbound(m, botWxid);
    if (!inbound) continue;

    if (processedIds.has(inbound.messageId)) continue;
    if (processedIds.size >= MAX_PROCESSED_IDS) {
      const first = processedIds.values().next().value;
      if (first) processedIds.delete(first);
    }
    processedIds.add(inbound.messageId);

    if (opts.onMessage) {
      await Promise.resolve(opts.onMessage(inbound)).catch((err) =>
        opts.runtime.error?.(`[wechatpadpro] onMessage error: ${String(err)}`),
      );
      continue;
    }
    await handleWeChatPadProInbound({
      message: inbound,
      account,
      config: opts.config,
      runtime: opts.runtime,
      statusSink: opts.statusSink,
    }).catch((err) => {
      opts.runtime.error?.(`[wechatpadpro] handleInbound error: ${String(err)}`);
    });
  }
}

async function doSyncAndProcess(
  serverUrl: string,
  authcode: string,
  botWxid: string,
  opts: {
    config: CoreConfig;
    account: ResolvedWeChatPadProAccount;
    runtime: RuntimeEnv;
    statusSink?: WeChatPadProMonitorOptions["statusSink"];
    onMessage?: WeChatPadProMonitorOptions["onMessage"];
    processedIds: Set<string>;
  },
): Promise<void> {
  const url = `${serverUrl}/api/Msg/Sync?authcode=${encodeURIComponent(authcode)}`;
  const body = JSON.stringify({
    Wxid: botWxid || undefined,
    Scene: 0,
    Synckey: "",
  });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    opts.runtime.error?.(`[wechatpadpro] Sync fetch error: ${String(err)}`);
    return;
  }
  const raw = await res.text();
  let payload: unknown;
  try {
    payload = raw ? (JSON.parse(raw) as unknown) : {};
  } catch {
    return;
  }

  const addMsgs = extractAddMsgs(payload);
  if (addMsgs.length === 0) return;

  await handleWebhookPost(payload, opts.account, opts);
}

export async function monitorWeChatPadProProvider(
  opts: WeChatPadProMonitorOptions = {},
): Promise<{ stop: () => void }> {
  const core = getWeChatPadProRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveWeChatPadProAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (message: string) => core.logging.getChildLogger().info(message),
    error: (message: string) => core.logging.getChildLogger().error(message),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  if (!account.serverUrl) {
    throw new Error(
      `WeChatPadPro serverUrl not configured for account "${account.accountId}"`,
    );
  }

  if (!account.authcode?.trim()) {
    throw new Error(
      `WeChatPadPro authcode not configured for account "${account.accountId}"`,
    );
  }

  const botWxid = account.wxid?.trim() || "";
  const logger = core.logging.getChildLogger({
    channel: "wechatpadpro",
    accountId: account.accountId,
  });

  const webhookBaseUrl =
    (cfg.channels?.wechatpadpro as { webhookBaseUrl?: string } | undefined)?.webhookBaseUrl?.trim() ||
    process.env.OPENCLAW_GATEWAY_URL?.trim() ||
    "http://127.0.0.1:19001";
  const syncMessageUrl = `${webhookBaseUrl.replace(/\/$/, "")}/channels/wechatpadpro/sync/${account.authcode}`;

  const processedIds = getOrCreateProcessedIds(account.accountId);
  const webhookPath = `/channels/wechatpadpro/sync/${account.authcode}`;

  // 1. Register HTTP route for webhook (gateway will route POSTs here)
  const unregisterHttp = registerPluginHttpRoute({
    path: webhookPath,
    pluginId: "wechatpadpro",
    accountId: account.accountId,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }
      try {
        const raw = await readRequestBody(req);
        let payload: unknown;
        try {
          payload = raw ? (JSON.parse(raw) as unknown) : {};
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
        await handleWebhookPost(payload, account, {
          config: cfg,
          runtime,
          statusSink: opts.statusSink,
          onMessage: opts.onMessage,
          processedIds,
        });
      } catch (err) {
        runtime.error?.(`[wechatpadpro] webhook error: ${String(err)}`);
      }
    },
  });

  // 3. Register business callback URL with ws861
  try {
    const setUrl = `${account.serverUrl}/api/Webhook/Business/Set?authcode=${encodeURIComponent(account.authcode)}`;
    const setRes = await fetch(setUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncMessageUrl }),
    });
    const setText = await setRes.text();
    if (!setRes.ok) {
      logger.warn(
        `[wechatpadpro:${account.accountId}] Webhook/Business/Set failed (${setRes.status}): ${setText}`,
      );
    } else {
      logger.info(
        `[wechatpadpro:${account.accountId}] Registered syncMessageUrl`,
      );
    }
  } catch (err) {
    logger.warn(
      `[wechatpadpro:${account.accountId}] Webhook/Business/Set error: ${String(err)}`,
    );
  }

  // 4. Start heartbeat
  try {
    const hbUrl = `${account.serverUrl}/api/Login/AutoHeartBeat?authcode=${encodeURIComponent(account.authcode)}`;
    const hbRes = await fetch(hbUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!hbRes.ok) {
      const hbText = await hbRes.text();
      logger.warn(
        `[wechatpadpro:${account.accountId}] AutoHeartBeat failed (${hbRes.status}): ${hbText}`,
      );
    } else {
      logger.info(`[wechatpadpro:${account.accountId}] AutoHeartBeat started`);
    }
  } catch (err) {
    logger.warn(
      `[wechatpadpro:${account.accountId}] AutoHeartBeat error: ${String(err)}`,
    );
  }

  opts.statusSink?.({
    connected: true,
    lastConnectedAt: Date.now(),
    lastDisconnect: undefined,
  });

  // 5. Cold-start catch-up poll (simulates app foregrounding; webhook is primary)
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedulePoll = () => {
    if (stopped) return;
    const baseMs = 8 * 60_000;
    const jitterMs = Math.floor(Math.random() * 7 * 60_000);
    pollTimer = setTimeout(() => {
      if (stopped) return;
      void doSyncAndProcess(account.serverUrl, account.authcode!, botWxid, {
        config: cfg,
        account,
        runtime,
        statusSink: opts.statusSink,
        onMessage: opts.onMessage,
        processedIds,
      }).finally(schedulePoll);
    }, baseMs + jitterMs);
  };

  schedulePoll();

  const stop = () => {
    stopped = true;
    unregisterHttp();
    processedIdsByAccountId.delete(account.accountId);
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    opts.statusSink?.({
      connected: false,
      lastDisconnect: { at: Date.now(), error: "stopped" },
    });
    logger.info(`[wechatpadpro:${account.accountId}] Monitor stopped`);
  };

  opts.abortSignal?.addEventListener("abort", stop, { once: true });

  return { stop };
}
