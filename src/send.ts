import type { CoreConfig, WeChatPadProSendResult } from "./types.js";
import { resolveWeChatPadProAccount } from "./accounts.js";
import { getWeChatPadProRuntime } from "./runtime.js";

type WeChatPadProSendOpts = {
  serverUrl?: string;
  wxid?: string;
  accountId?: string;
  type?: number; // 1 = text, other types for @ mentions, etc.
  at?: string; // For group @ mentions, comma-separated wxids
  verbose?: boolean;
  appendAiSuffix?: boolean; // Default true for text
  skipHumanDelay?: boolean;
};

function humanTypingDelayMs(text: string): number {
  const len = text.length;
  const cpsBase = 3.5 + Math.random() * 2.5; // 3.5~6 chars/sec
  const typingMs = (len / cpsBase) * 1000;
  const thinkMs = 800 + Math.random() * 2200; // 0.8~3s "thinking"
  const total = thinkMs + typingMs;
  const min = 1500;
  const max = 12000;
  return Math.max(min, Math.min(max, total));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ws861 ResponseResult format. */
type Ws861Response = {
  Code: number;
  Success: boolean;
  Message?: string;
  Data?: unknown;
};

function resolveCredentials(
  explicit: { serverUrl?: string; wxid?: string; authcode?: string },
  account: { serverUrl: string; wxid?: string; authcode?: string; accountId: string },
): { serverUrl: string; authcode: string } {
  const serverUrl = explicit.serverUrl?.trim() ?? account.serverUrl;
  const authcode = explicit.authcode?.trim() ?? account.authcode;

  if (!serverUrl) {
    throw new Error(
      `WeChatPadPro serverUrl missing for account "${account.accountId}" (set channels.wechatpadpro.serverUrl).`,
    );
  }
  if (!authcode) {
    throw new Error(
      `WeChatPadPro authcode missing for account "${account.accountId}" (set channels.wechatpadpro.authcode).`,
    );
  }

  return { serverUrl, authcode };
}

function normalizeWxid(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error("Wxid is required for WeChatPadPro sends");
  }

  let normalized = trimmed;
  if (normalized.startsWith("wechatpadpro:")) {
    normalized = normalized.slice("wechatpadpro:".length).trim();
  } else if (normalized.startsWith("wxp:")) {
    normalized = normalized.slice("wxp:".length).trim();
  }

  if (!normalized) {
    throw new Error("Wxid is required for WeChatPadPro sends");
  }
  return normalized;
}

function resolveAiSuffix(cfg: CoreConfig, accountId: string): string {
  const channelCfg = cfg.channels?.wechatpadpro as { aiSuffix?: string } | undefined;
  const accountCfg = channelCfg?.accounts?.[accountId] as { aiSuffix?: string } | undefined;
  const suffix = accountCfg?.aiSuffix ?? channelCfg?.aiSuffix ?? " [AI]";
  return typeof suffix === "string" ? suffix : " [AI]";
}

function parseWs861Response(res: Response, body: string): Ws861Response {
  let data: unknown;
  try {
    data = body ? (JSON.parse(body) as unknown) : {};
  } catch {
    throw new Error(
      `WeChatPadPro API invalid JSON (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return {
    Code: Number(obj.Code ?? obj.code ?? -1),
    Success: Boolean(obj.Success ?? obj.success),
    Message: typeof obj.Message === "string" ? obj.Message : String(obj.Message ?? obj.message ?? ""),
    Data: obj.Data ?? obj.data,
  };
}

export async function sendMessageWeChatPadPro(
  to: string,
  text: string,
  opts: WeChatPadProSendOpts = {},
): Promise<WeChatPadProSendResult> {
  const core = getWeChatPadProRuntime();
  const cfg = core.config.loadConfig() as CoreConfig;
  const account = resolveWeChatPadProAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { serverUrl, authcode } = resolveCredentials(
    { serverUrl: opts.serverUrl },
    account,
  );
  const toWxid = normalizeWxid(to);

  if (!text?.trim()) {
    throw new Error("Message must be non-empty for WeChatPadPro sends");
  }

  let message = text.trim();
  const type = opts.type ?? 1;

  if (opts.appendAiSuffix !== false) {
    const aiSuffix = resolveAiSuffix(cfg, account.accountId);
    if (aiSuffix && !message.endsWith(aiSuffix)) {
      message = message + aiSuffix;
    }
  }

  const senderWxid = account.wxid?.trim() || "";
  const body: Record<string, unknown> = {
    Wxid: senderWxid,
    ToWxid: toWxid,
    Content: message,
    Type: type,
  };
  if (opts.at && type === 1) {
    body.At = opts.at;
  }

  if (!opts.skipHumanDelay) {
    const delay = humanTypingDelayMs(message);
    await sleep(delay);
  }

  const url = `${serverUrl}/api/Msg/SendTxt?authcode=${encodeURIComponent(authcode)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text().catch(() => "");

  if (!response.ok) {
    const parsed = parseWs861Response(response, responseText);
    const errMsg =
      parsed.Message || responseText || `HTTP ${response.status}`;
    throw new Error(`WeChatPadPro send failed: ${errMsg}`);
  }

  const parsed = parseWs861Response(response, responseText);
  if (parsed.Code !== 0 || !parsed.Success) {
    throw new Error(
      `WeChatPadPro API error: ${parsed.Message || `Code=${parsed.Code}`}`,
    );
  }

  let messageId: string | undefined;
  const data = parsed.Data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const mid = d.messageId ?? d.msgId ?? d.MessageId ?? d.NewMsgId;
    if (mid != null) messageId = String(mid);
  }

  if (opts.verbose) {
    console.log(`[wechatpadpro] Sent message ${messageId || "unknown"} to ${toWxid}`);
  }

  core.channel.activity.record({
    channel: "wechatpadpro",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { ok: true, messageId };
}

export async function sendImageWeChatPadPro(
  to: string,
  base64Data: string,
  opts: WeChatPadProSendOpts & { appendAiSuffix?: boolean } = {},
): Promise<WeChatPadProSendResult> {
  const core = getWeChatPadProRuntime();
  const cfg = core.config.loadConfig() as CoreConfig;
  const account = resolveWeChatPadProAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { serverUrl, authcode } = resolveCredentials(
    { serverUrl: opts.serverUrl },
    account,
  );
  const toWxid = normalizeWxid(to);

  if (!base64Data?.trim()) {
    throw new Error("Base64 image data is required for WeChatPadPro image sends");
  }

  const body: Record<string, unknown> = {
    ToWxid: toWxid,
    Base64: base64Data.includes(",") ? base64Data.split(",")[1] ?? base64Data : base64Data,
  };

  const url = `${serverUrl}/api/Msg/UploadImg?authcode=${encodeURIComponent(authcode)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text().catch(() => "");

  if (!response.ok) {
    const parsed = parseWs861Response(response, responseText);
    const errMsg =
      parsed.Message || responseText || `HTTP ${response.status}`;
    throw new Error(`WeChatPadPro image send failed: ${errMsg}`);
  }

  const parsed = parseWs861Response(response, responseText);
  if (parsed.Code !== 0 || !parsed.Success) {
    throw new Error(
      `WeChatPadPro API error: ${parsed.Message || `Code=${parsed.Code}`}`,
    );
  }

  if (opts.verbose) {
    console.log(`[wechatpadpro] Sent image to ${toWxid}`);
  }

  core.channel.activity.record({
    channel: "wechatpadpro",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { ok: true };
}
