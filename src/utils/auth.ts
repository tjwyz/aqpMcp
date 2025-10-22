import axios from "axios";

let cachedToken: string | null = null;
let tokenExpireAt = 0; // 秒级时间戳（UNIX）

export interface AuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

/**
 * 获取 Azure AD 的 client_credentials token。
 * 返回 accessToken 与 tokenExpireAt（Unix 秒级时间戳）
 */
export async function getToken(config: any): Promise<{ accessToken: string; tokenExpireAt: number } | null> {
  const tenantId = config?.tenantId || "";
  const clientId = config?.clientId || "";
  const clientSecret = config?.clientSecret || "";

  const scope = `${clientId}/.default`;
  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const now = Math.floor(Date.now() / 1000);

  // 如果缓存未过期（预留 60 秒提前刷新）
  if (cachedToken && tokenExpireAt > now + 60) {
    return { accessToken: cachedToken, tokenExpireAt };
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("scope", scope);

  try {
    const response = await axios.post(tokenEndpoint, params);
    const { access_token, expires_in } = response.data;

    cachedToken = access_token;
    tokenExpireAt = now + (expires_in || 3600); // 转成绝对时间戳

    console.log(`[auth] fetched new token, expires at ${new Date(tokenExpireAt * 1000).toISOString()}`);
    return { accessToken: access_token, tokenExpireAt };
  } catch (error: any) {
    console.error("[auth] token fetch failed:", error.response?.data || error);
    return null;
  }
}
