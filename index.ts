import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wechatpadproPlugin } from "./src/channel.js";
import { setWeChatPadProRuntime } from "./src/runtime.js";

const plugin = {
  id: "wechatpadpro",
  name: "WeChatPadPro",
  description: "WeChatPadPro channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWeChatPadProRuntime(api.runtime);
    api.registerChannel({ plugin: wechatpadproPlugin });
  },
};

export default plugin;
