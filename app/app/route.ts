import { chatGPTSignOutPath, requireChatGPTUser } from "../chatgpt-auth";
import transcriptHtml from "./transcript.html?raw";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireChatGPTUser("/app");
  const displayName = escapeHtml(user.displayName);
  const email = escapeHtml(user.email);
  const signOutPath = chatGPTSignOutPath("/");
  const accountUi = `
    <style>
      .account-pill{position:fixed;z-index:4;right:28px;bottom:24px;display:flex;align-items:center;gap:10px;padding:8px 10px 8px 12px;border:1px solid #dbe4e1;border-radius:14px;background:rgba(255,255,255,.96);box-shadow:0 14px 40px rgba(18,45,39,.14);backdrop-filter:blur(12px);font-family:Inter,"PingFang SC",system-ui,sans-serif}
      .account-copy{display:grid;line-height:1.2;max-width:180px}.account-copy strong{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.account-copy span{font-size:10px;color:#71817e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.account-pill a{color:#17342e;background:#e6f7ef;text-decoration:none;font-size:11px;font-weight:750;padding:8px 10px;border-radius:9px;white-space:nowrap}
      @media(max-width:620px){.account-pill{right:12px;bottom:10px}.account-copy{display:none}}
    </style>
    <div class="account-pill" aria-label="当前登录账号">
      <div class="account-copy"><strong>${displayName}</strong><span>${email}</span></div>
      <a href="${signOutPath}">退出</a>
    </div>`;

  return new Response(transcriptHtml.replace("</body>", `${accountUi}</body>`), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
