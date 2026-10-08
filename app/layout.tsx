import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "语流 · 实时转写",
  description: "支持中英文优化、实时字幕与翻译、说话人区分和会后总结的录音转写工具。",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
