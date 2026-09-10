import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

// Opt-in: use a running local web server and an existing report. All worker/save
// requests are intercepted; an isolated browser context never touches user history.
// CV_TEST_URL=http://localhost:3000 CV_TEST_REPORT=007 node --test tests/e2e/job-page-translation.test.mjs
const baseURL = process.env.CV_TEST_URL;
const report = process.env.CV_TEST_REPORT;

for (const translated of [false, true]) {
  for (const outcome of ["error", "done"]) {
    test(`JobPage running → ${outcome}, translated=${translated}`, {
      skip: !baseURL || !report,
      timeout: 90_000,
    }, async () => {
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await context.addInitScript(() => {
          localStorage.setItem("career-ops:config", JSON.stringify({ cliId: "hermes", mode: "cli" }));
          const realFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = new URL(typeof input === "string" ? input : input.url, location.href);
            if (url.pathname === "/api/run") {
              window.testRunRequest = JSON.parse(init.body);
              const encoder = new TextEncoder();
              return new Response(new ReadableStream({
                start(controller) {
                  window.finishTestRun = (type) => {
                    controller.enqueue(encoder.encode(JSON.stringify(type === "error"
                      ? { type, msg: "The run reached its time limit (600s)." }
                      : { type, tokens: 0 }) + "\n"));
                    controller.close();
                  };
                },
              }));
            }
            if (url.pathname === "/api/runs/save") return Response.json({ ok: true });
            return realFetch(input, init);
          };
        });
        await page.goto(`${baseURL}/pipeline/${report}`);
        const generate = page.getByRole("button", { name: "Generate tailored CV (PDF)", exact: true });
        const regenerate = page.getByRole("button", { name: "Regenerate the tailored CV", exact: true });
        await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) =>
          b.textContent.includes("Generate tailored CV (PDF)") || b.title === "Regenerate the tailored CV"));
        if (await generate.count()) await generate.click();
        else await regenerate.click();
        await page.waitForFunction(() => typeof window.finishTestRun === "function");
        assert.equal(await page.evaluate(() => window.testRunRequest.kind), "pdf");
        await page.getByRole("link", { name: "Generating CV…", exact: true }).click();
        await page.locator("section p").filter({ hasText: "working" }).waitFor();
        if (translated) {
          // Browser translation replaces Text nodes outside React. Keep detached
          // originals (React still references them), as Google/Edge Translate do.
          await page.evaluate(() => {
            for (const parent of document.querySelectorAll("section p, ol li")) {
              const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
              const nodes = [];
              while (walker.nextNode()) nodes.push(walker.currentNode);
              for (const node of nodes) {
                if (!node.textContent.trim()) continue;
                const outer = document.createElement("font");
                const inner = document.createElement("font");
                inner.textContent = `译文 ${node.textContent}`;
                outer.append(inner);
                node.replaceWith(outer);
              }
            }
          });
        }
        await page.evaluate((type) => window.finishTestRun(type), outcome);
        await page.waitForFunction((status) => {
          const jobs = JSON.parse(localStorage.getItem("career-ops:jobs") || "[]");
          return jobs[0]?.status === status;
        }, outcome);
        // Give React the next paint to commit (and report any commit-phase error).
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(errors, [], "status transition must not throw a DOM error");
        assert.equal((await page.locator("section p").first().textContent()).trim(), outcome);
        if (outcome === "error") assert.match(await page.locator("ol").innerText(), /time limit \(600s\)/);
        assert.equal(await page.locator("ol").getByText("thinking…", { exact: true }).count(), 0);
      } finally {
        await browser.close();
      }
    });
  }
}
