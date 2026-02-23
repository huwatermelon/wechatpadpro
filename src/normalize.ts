export function normalizeWeChatPadProMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  let normalized = trimmed;

  if (normalized.startsWith("wechatpadpro:")) {
    normalized = normalized.slice("wechatpadpro:".length).trim();
  } else if (normalized.startsWith("wxp:")) {
    normalized = normalized.slice("wxp:".length).trim();
  }

  if (!normalized) {
    return undefined;
  }

  return `wechatpadpro:${normalized}`;
}

export function looksLikeWeChatPadProTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  if (/^(wechatpadpro|wxp):/i.test(trimmed)) {
    return true;
  }

  // WeChat wxid format (typically alphanumeric, may include special characters)
  return /^[a-zA-Z0-9_\-@]+$/.test(trimmed);
}
