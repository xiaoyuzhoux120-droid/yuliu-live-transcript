import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "./chatgpt-auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();

  return (
    <main className="login-page">
      <div className="login-glow login-glow-one" />
      <div className="login-glow login-glow-two" />

      <header className="login-header">
        <Link className="login-brand" href="/" aria-label="语流首页">
          <span className="login-brandmark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M3 13h3l2-8 4 15 3-12 2 5h4" />
            </svg>
          </span>
          语流
        </Link>
        {user ? (
          <a className="login-text-link" href={chatGPTSignOutPath("/")}>
            退出登录
          </a>
        ) : null}
      </header>

      <section className="login-hero">
        <div className="login-copy">
          <div className="login-kicker">
            <span /> 为中英文对话而生
          </div>
          <h1>让每一句话，<br />都清楚地留下来。</h1>
          <p>
            实时录音转写、双语字幕、说话人区分与会后总结，
            在一个专注而私密的工作台里完成。
          </p>

          {user ? (
            <div className="login-account-card">
              <div className="login-avatar">{initialFor(user.displayName)}</div>
              <div>
                <strong>欢迎回来，{user.displayName}</strong>
                <span>{user.email}</span>
              </div>
              <Link className="login-primary" href="/app">进入工作台 <span>→</span></Link>
            </div>
          ) : (
            <div className="login-actions">
              <a
                className="login-primary"
                href={chatGPTSignInPath("/app")}
                target="_top"
              >
                <span className="chatgpt-mark" aria-hidden="true">✦</span>
                使用 ChatGPT 登录
              </a>
              <span className="login-note">登录后才能访问转写工作台</span>
            </div>
          )}

          <div className="login-trust">
            <span><i /> 浏览器实时识别</span>
            <span><i /> 密钥仅保存在当前页面</span>
            <span><i /> 支持 DeepSeek 等开放接口</span>
          </div>
        </div>

        <div className="login-preview" aria-label="产品功能预览">
          <div className="preview-topbar">
            <div><b /> 正在聆听</div>
            <span>02:18</span>
          </div>
          <div className="preview-languages">
            <span>中文</span><em>⇄</em><span>English</span><small>AI 自动纠错</small>
          </div>
          <div className="preview-lines">
            <article>
              <time>01:42</time>
              <div><label>说话人 1</label><p>我们今天主要确认一下新版本的发布计划。</p><span>Today, we mainly need to confirm the release plan.</span></div>
            </article>
            <article>
              <time>01:57</time>
              <div><label className="speaker-two">说话人 2</label><p>实时字幕已经可以正常工作。</p><span>Live captions are now working correctly.</span></div>
            </article>
          </div>
          <div className="preview-footer">
            <button type="button"><i /> 结束录音</button>
            <div className="preview-wave"><i /><i /><i /><i /><i /></div>
          </div>
          <div className="summary-float">
            <small>AI 摘要</small>
            <strong>重点已整理</strong>
            <p>发布计划已确认，产品团队将在周五前整理反馈。</p>
          </div>
        </div>
      </section>
    </main>
  );
}

function initialFor(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "语";
}
