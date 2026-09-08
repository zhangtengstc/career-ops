import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { careerOpsRoot } from "./career-ops";

export type LaunchBossChromeOptions = {
  profileDir?: string;
  chromePath?: string;
  debugPort?: number;
};

function findChrome(): string | undefined {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function isCdpReady(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = http.request(`${baseUrl}/json/version`, { method: "GET", timeout: 400 }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString("utf-8"); });
        res.on("end", () => {
          try {
            const j = JSON.parse(data) as { Browser?: string };
            resolve(typeof j.Browser === "string" && j.Browser.includes("Chrome"));
          } catch {
            resolve(false);
          }
        });
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getChromeCdpUrl(opts: LaunchBossChromeOptions = {}): Promise<string> {
  const profileDir =
    opts.profileDir ??
    path.join(careerOpsRoot(), "config", "browser-state", "boss-profile");
  const chromePath = opts.chromePath ?? findChrome() ?? "chrome";
  const debugPort = opts.debugPort ?? 9222;
  const baseUrl = `http://127.0.0.1:${debugPort}`;

  if (await isCdpReady(baseUrl)) return baseUrl;

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--start-maximized",
    "https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100",
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // Chrome takes a moment to open its DevTools port — poll instead of letting
  // callers race against a half-started instance.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await isCdpReady(baseUrl)) break;
  }
  return baseUrl;
}
