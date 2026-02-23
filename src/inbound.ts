import {
  createReplyPrefixOptions,
  logInboundDrop,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { ResolvedWeChatPadProAccount } from "./accounts.js";
import type {
  CoreConfig,
  GroupPolicy,
  WeChatPadProAccountConfig,
  WeChatPadProInboundMessage,
} from "./types.js";
import { getWeChatPadProRuntime } from "./runtime.js";
import { sendMessageWeChatPadPro } from "./send.js";

const CHANNEL_ID = "wechatpadpro" as const;

const DEFAULT_BLOCKED = new Set([
  "weixin",
  "fmessage",
  "newsapp",
  "filehelper",
  "floatbottle",
  "medianote",
  "mphelper",
]);

function isBlockedAccount(wxid: string, config: WeChatPadProAccountConfig): boolean {
  if (!wxid?.trim()) return true;
  const w = wxid.trim().toLowerCase();
  if (w.startsWith("gh_")) return true;
  if (DEFAULT_BLOCKED.has(w)) return true;
  const blocked = config.blockedAccounts ?? [];
  if (blocked.some((b) => b?.trim().toLowerCase() === w)) return true;
  return false;
}

const chatLastActivity = new Map<string, number>();
const globalProcessedTimestamps = new Map<string, number[]>();

const GLOBAL_WINDOW_MS = 60_000;
const DEFAULT_CHAT_COOLDOWN_MS = 8000;
const DEFAULT_GLOBAL_MAX_PER_MIN = 10;

function isRateLimited(
  accountId: string,
  chatId: string,
  config: WeChatPadProAccountConfig,
): boolean {
  const rl = config.rateLimiting ?? {};
  const cooldownMs = rl.chatCooldownMs ?? DEFAULT_CHAT_COOLDOWN_MS;
  const globalMax = rl.globalMaxPerMin ?? DEFAULT_GLOBAL_MAX_PER_MIN;

  const chatKey = `${accountId}:${chatId}`;
  const last = chatLastActivity.get(chatKey) ?? 0;
  if (Date.now() - last < cooldownMs) return true;

  const timestamps = globalProcessedTimestamps.get(accountId) ?? [];
  const cutoff = Date.now() - GLOBAL_WINDOW_MS;
  const recent = timestamps.filter((t) => t >= cutoff);
  if (recent.length >= globalMax) return true;

  return false;
}

function recordChatActivity(accountId: string, chatId: string): void {
  const now = Date.now();
  chatLastActivity.set(`${accountId}:${chatId}`, now);
}

function recordProcess(accountId: string, chatId: string): void {
  const now = Date.now();
  chatLastActivity.set(`${accountId}:${chatId}`, now);

  const timestamps = globalProcessedTimestamps.get(accountId) ?? [];
  timestamps.push(now);
  const cutoff = now - GLOBAL_WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
  globalProcessedTimestamps.set(accountId, timestamps);
}

function recordReply(accountId: string, chatId: string): void {
  recordChatActivity(accountId, chatId);
}

function parseAppMessageXml(xml: string): string | null {
  if (!xml?.trim()) return null;
  const s = xml.trim();

  // type=2000 (transfer) - skip
  const appmsgType = s.match(/<type>(\d+)<\/type>/);
  const typeNum = appmsgType ? parseInt(appmsgType[1], 10) : 0;
  if (typeNum === 2000) return null;

  // type=57 (quote/reply)
  if (typeNum === 57) {
    const titleMatch = s.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
    const referMatch = s.match(/<refermsg>[\s\S]*?<content>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/content>[\s\S]*?<\/refermsg>/s);
    const title = titleMatch?.[1]?.trim() ?? "";
    const refer = referMatch?.[1]?.trim() ?? "";
    if (title || refer) {
      return refer ? `[Quote: ${title}]\n${refer}` : title;
    }
  }

  // type=5 (link card)
  if (typeNum === 5) {
    const titleMatch = s.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
    const urlMatch = s.match(/<url>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/url>/s);
    const descMatch = s.match(/<des>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/des>/s);
    const title = titleMatch?.[1]?.trim() ?? "";
    const url = urlMatch?.[1]?.trim() ?? "";
    const desc = descMatch?.[1]?.trim() ?? "";
    const parts = [title];
    if (url) parts.push(url);
    if (desc) parts.push(desc);
    return parts.join("\n");
  }

  // type=2001 (red packet) - handle separately, return placeholder
  if (typeNum === 2001) {
    return "[Red packet]";
  }

  // Fallback: extract title
  const titleMatch = s.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
  return titleMatch?.[1]?.trim() ?? s;
}

function shouldProcessGroupMessage(
  content: string,
  senderWxid: string,
  botWxid: string,
  groupWxid: string | undefined,
  config: WeChatPadProAccountConfig,
): { process: boolean; cleanedContent: string; actualSenderWxid?: string; actualSenderName?: string } {
  let actualContent = content.trim();
  let actualSenderWxid = senderWxid;
  let actualSenderName: string | undefined;

  // Extract actual sender from format wxid_xxx:\ncontent
  const newlineIdx = actualContent.indexOf("\n");
  if (newlineIdx > 0) {
    const firstLine = actualContent.slice(0, newlineIdx).trim();
    if (firstLine.includes(":") || /^wxid_[a-z0-9_-]+$/i.test(firstLine)) {
      actualSenderWxid = firstLine.replace(/:$/, "").trim();
      actualContent = actualContent.slice(newlineIdx + 1).trim();
    }
  }

  // Skip @所有人 / @全体成员 / @All
  if (
    /^@所有人\s*$/i.test(actualContent) ||
    /^@全体成员\s*$/i.test(actualContent) ||
    /^@All\s*$/i.test(actualContent) ||
    /^@\s*所有人\s*$/i.test(actualContent)
  ) {
    return { process: false, cleanedContent: actualContent };
  }

  const myNicknames = config.myNicknames ?? [];
  const triggerKeywords = config.triggerKeywords ?? [];
  const openGroups = config.openGroups ?? [];

  let stripped = actualContent;
  let matched = false;

  // Check if bot is @'d
  const atWxid = `@${botWxid}`;
  if (actualContent.includes(atWxid)) {
    matched = true;
    stripped = actualContent
      .replace(new RegExp(atWxid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
      .trim();
  }
  if (!matched && myNicknames.length > 0) {
    for (const nick of myNicknames) {
      const atNick = `@${nick}`;
      if (actualContent.includes(atNick)) {
        matched = true;
        stripped = actualContent
          .replace(new RegExp(atNick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
          .trim();
        break;
      }
    }
  }

  // Check trigger keywords in open groups
  if (!matched && triggerKeywords.length > 0) {
    const isOpen = groupWxid && openGroups.some((g) => g?.trim().toLowerCase() === groupWxid.toLowerCase());
    if (isOpen) {
      for (const kw of triggerKeywords) {
        const k = kw?.trim();
        if (k && actualContent.startsWith(k)) {
          matched = true;
          stripped = actualContent.slice(k.length).trim();
          break;
        }
      }
    }
  }

  if (!matched) {
    return { process: false, cleanedContent: actualContent, actualSenderWxid };
  }

  return {
    process: true,
    cleanedContent: stripped,
    actualSenderWxid,
    actualSenderName,
  };
}

const SEGMENT_CHAR_LIMIT = 500;

function splitIntoNaturalSegments(text: string): string[] {
  if (text.length <= SEGMENT_CHAR_LIMIT) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const segments: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > SEGMENT_CHAR_LIMIT) {
      segments.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) segments.push(current.trim());

  const final: string[] = [];
  for (const seg of segments) {
    if (seg.length <= SEGMENT_CHAR_LIMIT) {
      final.push(seg);
    } else {
      const sentences = seg.split(/(?<=[。！？.!?\n])/);
      let buf = "";
      for (const s of sentences) {
        if (buf && (buf.length + s.length) > SEGMENT_CHAR_LIMIT) {
          final.push(buf.trim());
          buf = s;
        } else {
          buf += s;
        }
      }
      if (buf.trim()) final.push(buf.trim());
    }
  }
  return final.length > 0 ? final : [text];
}

function interSegmentDelayMs(): number {
  return 3000 + Math.random() * 5000; // 3~8s between segments
}

function delaySleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function deliverWeChatPadProReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  toWxid: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, toWxid, accountId, statusSink } = params;
  const text = payload.text ?? "";
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (!text.trim() && mediaList.length === 0) {
    return;
  }

  const mediaBlock = mediaList.length
    ? mediaList.map((url) => `Attachment: ${url}`).join("\n")
    : "";
  const combined = text.trim()
    ? mediaBlock
      ? `${text.trim()}\n\n${mediaBlock}`
      : text.trim()
    : mediaBlock;

  const segments = splitIntoNaturalSegments(combined);

  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      await delaySleep(interSegmentDelayMs());
    }
    await sendMessageWeChatPadPro(toWxid, segments[i], {
      accountId,
    });
  }

  recordReply(accountId, toWxid);
  statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleWeChatPadProInbound(params: {
  message: WeChatPadProInboundMessage;
  account: ResolvedWeChatPadProAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getWeChatPadProRuntime();
  const botWxid = account.wxid?.trim() ?? "";

  // 6. Message type filtering
  const msgType = message.msgType ?? 1;
  if (msgType !== 1 && msgType !== 49) {
    return;
  }

  let rawBody = message.text?.trim() ?? "";
  const fromUser = message.senderWxid;
  const toUser = message.wxid;

  // 5. Type=49 app message parsing (if raw XML passed)
  if (msgType === 49 && (message.rawContent || rawBody)) {
    const raw = message.rawContent ?? rawBody;
    if (raw.includes("<") && raw.includes(">")) {
      const parsed = parseAppMessageXml(raw);
      if (parsed === null) return; // transfer - skip
      rawBody = parsed;
    }
  }

  if (!rawBody) {
    return;
  }

  // 1. System/blocked account filtering
  if (isBlockedAccount(fromUser, account.config)) {
    logInboundDrop({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      reason: "blocked account",
      senderId: fromUser,
    });
    return;
  }

  const isGroup = message.isGroupChat;
  const senderWxid = message.senderWxid;
  const toWxid = message.wxid;
  const targetWxid = isGroup ? message.groupWxid : senderWxid;

  // 2. Self-message handling
  const isSelfMessage = botWxid && senderWxid === botWxid;
  const aiSuffix = account.config.aiSuffix ?? " [AI]";

  if (isSelfMessage) {
    const isSelfChat = fromUser === toUser && toUser === botWxid;
    if (isSelfChat) {
      // Personal assistant mode - allow through with special flag (no extra handling needed)
    } else {
      // Sending to group or another person - only allow if starts with trigger keyword
      const keywords = account.config.triggerKeywords ?? [];
      const matchedKw = keywords.find((kw) => kw?.trim() && rawBody.startsWith(kw.trim()));
      if (!matchedKw) {
        logInboundDrop({
          channel: CHANNEL_ID,
          accountId: account.accountId,
          reason: "self message without trigger",
          senderId: senderWxid,
        });
        return;
      }
      // Strip trigger keyword prefix before passing to AI
      rawBody = rawBody.slice(matchedKw.trim().length).trim();
    }
    // Skip if message ends with AI suffix (prevent loops)
    if (aiSuffix && rawBody.endsWith(aiSuffix)) {
      return;
    }
  }

  // 3. Group message processing
  let finalText = rawBody;
  let finalSenderWxid = senderWxid;
  let finalSenderName = message.senderName;

  if (isGroup && message.groupWxid) {
    const grp = shouldProcessGroupMessage(
      rawBody,
      senderWxid,
      botWxid,
      message.groupWxid,
      account.config,
    );
    if (!grp.process) {
      logInboundDrop({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        reason: "group not @'d or trigger",
        senderId: grp.actualSenderWxid ?? senderWxid,
        targetId: message.groupWxid,
      });
      return;
    }
    finalText = grp.cleanedContent;
    if (grp.actualSenderWxid) finalSenderWxid = grp.actualSenderWxid;
    if (grp.actualSenderName) finalSenderName = grp.actualSenderName;
    // 7. Group sender name prefix
    const displayName = finalSenderName ?? finalSenderWxid;
    finalText = `${displayName}: ${finalText}`;
  }

  if (!finalText.trim()) {
    return;
  }

  // 5. Rate limiting (self-chat bypasses)
  const isSelfChat = botWxid && fromUser === toUser && toUser === botWxid;
  if (!isSelfChat && isRateLimited(account.accountId, targetWxid ?? senderWxid, account.config)) {
    logInboundDrop({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      reason: "rate limited",
      senderId: senderWxid,
      targetId: targetWxid,
    });
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = (config.channels as Record<string, unknown> | undefined)?.defaults as
    | { groupPolicy?: string }
    | undefined;
  const groupPolicy = (account.config.groupPolicy ??
    defaultGroupPolicy?.groupPolicy ??
    "allowlist") as GroupPolicy;

  const configAllowFrom = (account.config.allowFrom ?? []).map((id) => id.trim().toLowerCase());
  const configGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((id) =>
    id.trim().toLowerCase(),
  );
  const storeAllowFromRaw = await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch(() => []);
  const storeAllowFrom = Array.isArray(storeAllowFromRaw) ? storeAllowFromRaw : [];
  const storeAllowList = storeAllowFrom.map((id) => String(id).trim().toLowerCase());

  if (isGroup) {
    const groupAllowMatch =
      configGroupAllowFrom.includes("*") ||
      configGroupAllowFrom.includes(finalSenderWxid.toLowerCase()) ||
      storeAllowList.includes(finalSenderWxid.toLowerCase());

    if (groupPolicy === "allowlist" && !groupAllowMatch) {
      logInboundDrop({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        reason: "group allowlist",
        senderId: finalSenderWxid,
        targetId: message.groupWxid,
      });
      return;
    }

    if (groupPolicy === "disabled") {
      logInboundDrop({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        reason: "group disabled",
        senderId: finalSenderWxid,
        targetId: message.groupWxid,
      });
      return;
    }
  } else {
    const dmAllowMatch =
      configAllowFrom.includes("*") ||
      configAllowFrom.includes(senderWxid.toLowerCase()) ||
      storeAllowList.includes(senderWxid.toLowerCase());

    if (dmPolicy === "allowlist" && !dmAllowMatch) {
      logInboundDrop({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        reason: "dm allowlist",
        senderId: senderWxid,
      });
      return;
    }

    if (dmPolicy === "pairing" && !dmAllowMatch) {
      logInboundDrop({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        reason: "dm pairing required",
        senderId: senderWxid,
      });
      return;
    }
  }

  recordProcess(account.accountId, targetWxid ?? senderWxid);

  const fullConfig = (core.config.loadConfig() ?? {}) as OpenClawConfig;

  const peerId = targetWxid ?? senderWxid;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: fullConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const sessionCfg = (fullConfig as Record<string, unknown>).session as { store?: string } | undefined;
  const storePath = core.channel.session.resolveStorePath(
    sessionCfg?.store,
    { agentId: route.agentId },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(fullConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const fromLabel = isGroup ? (message.groupName ?? message.groupWxid ?? peerId) : finalSenderWxid;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "wechatpadpro",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: finalText,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: finalText,
    CommandBody: finalText,
    From: isGroup ? `wechatpadpro:group:${message.groupWxid}` : `wechatpadpro:${finalSenderWxid}`,
    To: `wechatpadpro:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: finalSenderName || finalSenderWxid,
    SenderId: finalSenderWxid,
    GroupSubject: isGroup ? (message.groupName ?? message.groupWxid) : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `wechatpadpro:${peerId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`[wechatpadpro] session record error: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: fullConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: fullConfig,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverWeChatPadProReply({
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          toWxid: peerId,
          accountId: account.accountId,
          statusSink,
        });
      },
      onError: (err, info) => {
        const dispatchDuration = Date.now() - message.timestamp;
        runtime.error?.(
          `[wechatpadpro] ${info.kind} reply failed after ${dispatchDuration}ms: ${String(err)}`,
        );
      },
    },
    replyOptions: {
      onModelSelected,
      disableBlockStreaming: true,
    },
  });
}
