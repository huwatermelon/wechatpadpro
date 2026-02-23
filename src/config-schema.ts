import {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk";
import { z } from "zod";

export const WeChatPadProAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    serverUrl: z.string().url().optional(),
    wxid: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
    mediaMaxMb: z.number().positive().optional(),
    authcode: z.string().optional(),
    webhookPort: z.number().int().positive().optional(),
    triggerKeywords: z.array(z.string()).optional(),
    openGroups: z.array(z.string()).optional(),
    autoGrabRedPacket: z.boolean().optional(),
    voiceAsr: z
      .object({
        baiduApiKey: z.string(),
        baiduSecretKey: z.string(),
      })
      .optional(),
    myNicknames: z.array(z.string()).optional(),
    blockedAccounts: z.array(z.string()).optional(),
    aiSuffix: z.string().optional(),
    rateLimiting: z
      .object({
        chatCooldownMs: z.number().optional(),
        globalMaxPerMin: z.number().optional(),
      })
      .optional(),
    startupBufferMs: z.number().optional(),
  })
  .strict();

export const WeChatPadProAccountSchema = WeChatPadProAccountSchemaBase.superRefine(
  (value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.wechatpadpro.dmPolicy="open" requires channels.wechatpadpro.allowFrom to include "*"',
    });
  },
);

export const WeChatPadProConfigSchema = WeChatPadProAccountSchemaBase.extend({
  webhookBaseUrl: z.string().url().optional(),
  accounts: z.record(z.string(), WeChatPadProAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.wechatpadpro.dmPolicy="open" requires channels.wechatpadpro.allowFrom to include "*"',
  });
});
