/**
 * NeuralAdaptive — Photon Spectrum Companion Server
 *
 * Receives session-complete webhooks from the Chrome extension, runs a
 * tool-calling reading-coach agent against Dedalus (Claude), and delivers a
 * personalized iMessage summary via Photon Spectrum.
 *
 * Setup:
 *   1. Copy .env.example to .env and fill in your credentials
 *   2. npm install
 *   3. npm start
 *
 * The server listens on http://localhost:3847
 */

import express from "express";
import cors from "cors";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load env ────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const PORT = process.env.PORT || 3847;
const PHOTON_PROJECT_ID = process.env.PHOTON_PROJECT_ID || "";
const PHOTON_PROJECT_SECRET = process.env.PHOTON_PROJECT_SECRET || "";
const RECIPIENT_PHONE = process.env.RECIPIENT_PHONE || "";

// iMessage delivery backend.
//   "applescript" — default. Drives Messages.app via osascript. No Full Disk
//                   Access needed; first send triggers a one-time "allow
//                   Terminal to control Messages" prompt. Most forgiving.
//   "local"       — @photon-ai/imessage-kit. Reads the Messages SQLite DB.
//                   Requires Full Disk Access for the terminal running Node.
//   "cloud"       — Spectrum Cloud (Photon). Subject to project allowlists.
const IMESSAGE_MODE = (process.env.IMESSAGE_MODE || "applescript").toLowerCase();

// Dedalus (OpenAI-compatible) config. The extension already uses the same
// endpoint for paragraph summarization; we reuse the same key pattern here.
// NEVER hardcode a real key — load exclusively from the environment. If it's
// missing the coach-agent is skipped and the iMessage falls back to the
// stats-only template (see composeIMessage).
const DEDALUS_API_KEY = process.env.DEDALUS_API_KEY || "";
const DEDALUS_API_URL = "https://api.dedaluslabs.ai/v1/chat/completions";
const CLAUDE_MODEL =
  process.env.DEDALUS_MODEL || "anthropic/claude-haiku-4-5-20251001";
const AGENT_MAX_STEPS = 6;

// ─── Validate config ──────────────────────────────────────────────────────────
function validateConfig() {
  const missing = [];
  if (!RECIPIENT_PHONE) missing.push("RECIPIENT_PHONE");
  if (IMESSAGE_MODE === "cloud") {
    if (!PHOTON_PROJECT_ID) missing.push("PHOTON_PROJECT_ID");
    if (!PHOTON_PROJECT_SECRET) missing.push("PHOTON_PROJECT_SECRET");
  }
  if (missing.length > 0) {
    console.warn(
      `[spectrum-server] WARNING: Missing env vars: ${missing.join(", ")}\n` +
        `  Copy .env.example to .env and fill in your credentials.\n` +
        `  iMessage delivery will fail until these are set.`
    );
  }
  if (!DEDALUS_API_KEY) {
    console.warn(
      `[spectrum-server] WARNING: DEDALUS_API_KEY not set; agent will be skipped.`
    );
  }
  if (IMESSAGE_MODE !== "local" && IMESSAGE_MODE !== "cloud") {
    console.warn(
      `[spectrum-server] WARNING: IMESSAGE_MODE="${IMESSAGE_MODE}" is not recognized; falling back to "local".`
    );
  }
}
validateConfig();

// ─── iMessage clients ─────────────────────────────────────────────────────────
// Two paths: Spectrum Cloud (gated by Photon project limits) or local macOS
// Messages.app via @photon-ai/imessage-kit. We lazily initialize whichever the
// configured IMESSAGE_MODE requests.
let spectrumApp = null;
let localSdk = null;

async function getSpectrumApp() {
  if (spectrumApp) return spectrumApp;
  if (!PHOTON_PROJECT_ID || !PHOTON_PROJECT_SECRET) {
    throw new Error(
      "Photon credentials not configured. Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET in .env, or set IMESSAGE_MODE=local to bypass Spectrum Cloud."
    );
  }
  spectrumApp = await Spectrum({
    projectId: PHOTON_PROJECT_ID,
    projectSecret: PHOTON_PROJECT_SECRET,
    providers: [imessage.config()],
  });
  console.log("[spectrum-server] Spectrum Cloud client initialized");
  return spectrumApp;
}

function getLocalSdk() {
  if (localSdk) return localSdk;
  localSdk = new IMessageSDK();
  console.log("[spectrum-server] Local iMessage SDK initialized (macOS Messages.app)");
  return localSdk;
}

// AppleScript sender — drives Messages.app through osascript. Does NOT need
// Full Disk Access; only an Automation permission prompt that macOS surfaces
// the first time we try to send. Works for any iMessage-capable recipient.
async function sendViaAppleScript(to, text) {
  // Escape \ and " so they survive the AppleScript string literal.
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
    on run argv
      set targetAddress to item 1 of argv
      set messageBody to item 2 of argv
      tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy targetAddress of targetService
        send messageBody to targetBuddy
      end tell
    end run
  `;
  // Pass recipient + body as argv so content with quotes/newlines stays safe.
  await execFileAsync(
    "/usr/bin/osascript",
    ["-e", script, "--", esc(to), text],
    { maxBuffer: 1024 * 1024 }
  );
}

// ─── Stats template (fallback + header) ───────────────────────────────────────
function formatStatsBlock(payload) {
  const {
    sessionType = "reading",
    durationSeconds = 0,
    averageScore = 0,
    peakTier = "CALM",
    tierBreakdown = { calm: 100, elevated: 0, overload: 0 },
    interventionCount = 0,
    paragraphsRead = 0,
    paragraphsTotal = 0,
    wordsRead = 0,
    pageTitle,
  } = payload;

  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const sessionLabel =
    sessionType === "study" ? "Study Session" : "Reading Session";
  const tierEmoji = { CALM: "🟢", ELEVATED: "🟡", OVERLOAD: "🔴" };
  const focusRating =
    averageScore < 0.3
      ? "Excellent focus"
      : averageScore < 0.5
      ? "Good focus"
      : averageScore < 0.7
      ? "Moderate focus"
      : "High cognitive load";

  let message = `📚 NeuralAdaptive — ${sessionLabel} Complete\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n`;
  if (pageTitle) {
    const truncated =
      pageTitle.length > 50 ? pageTitle.slice(0, 47) + "…" : pageTitle;
    message += `📄 ${truncated}\n`;
  }
  message += `⏱ Duration: ${durationStr}\n`;
  if (paragraphsRead > 0 || wordsRead > 0) {
    const progressFrag =
      paragraphsTotal > 0
        ? `${paragraphsRead} / ${paragraphsTotal} paragraphs`
        : `${paragraphsRead} paragraphs`;
    const wordsFrag = wordsRead > 0 ? ` (~${wordsRead} words)` : "";
    message += `📖 Read: ${progressFrag}${wordsFrag}\n`;
  }
  message += `🧠 Avg Stress: ${(averageScore * 100).toFixed(0)}% — ${focusRating}\n`;
  message += `${tierEmoji[peakTier] || "⚪"} Peak State: ${peakTier}\n`;
  message += `\n📊 Time in each state:\n`;
  message += `  🟢 Calm:     ${tierBreakdown.calm.toFixed(0)}%\n`;
  message += `  🟡 Elevated: ${tierBreakdown.elevated.toFixed(0)}%\n`;
  message += `  🔴 Overload: ${tierBreakdown.overload.toFixed(0)}%\n`;
  if (interventionCount > 0) {
    message += `\n⚡ Interventions: ${interventionCount}\n`;
  }
  return message;
}

// ─── Reading-Coach Agent (Dedalus tool-calling loop) ──────────────────────────
// The agent sees session stats in its system prompt and can call tools to
// investigate further (stress timeline, specific paragraph text, reading pace,
// tier transitions). It terminates by calling finalize_message(message),
// which becomes the personalized debrief we append to the iMessage.

const AGENT_SYSTEM_PROMPT = `You are a reading-focus coach for a student using the NeuralAdaptive reading extension. The student has ADHD/dyslexia and just finished a reading session. You need to write a short, personal debrief that will be delivered to them via iMessage.

You have tools that let you investigate the session data:
- get_stress_timeline() — 15 time-bins showing how focused vs. stressed they were throughout the session
- get_paragraph_text(index) — retrieve the text of a specific paragraph they read
- get_tier_transitions() — moments when their focus state changed (CALM ↔ ELEVATED ↔ OVERLOAD)
- compute_reading_pace() — their words-per-minute + qualitative comparison

Workflow:
1. Look at the initial stats in the user message.
2. Call 1–3 tools to understand WHY the session went the way it did. Example: if they hit OVERLOAD, find when it happened via get_stress_timeline(), then pull the paragraph text around that time via get_paragraph_text() to see what tripped them up.
3. Call finalize_message(message) with a 2–4 sentence personalized debrief.

Rules for the final message:
- Warm but direct. Like a real coach, not a chatbot.
- Reference SPECIFIC content or specific moments — don't just say "good job." Mention the topic, a concept, or when things got hard.
- If they struggled, acknowledge it without being patronizing. If they crushed it, say so plainly.
- At most ONE concrete suggestion (e.g. "worth revisiting the section on X when you're fresh").
- Plain text only. No markdown, no quotes, no emojis.
- 30–70 words total.
- Do NOT repeat the numeric stats — those are already in the header of the message.
- If reading pace is flagged unreliable (skimming/scrolling/finicky eye movement), do NOT compliment reading speed or call them a "fast reader." Acknowledge that the pace estimate may reflect moving through the page rather than steady reading.

You MUST call finalize_message to complete the task.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_stress_timeline",
      description:
        "Return an array of 15 time bins covering the entire session. Each bin has {startSec, endSec, avgScore (0-1, higher=more stressed), samples, tier}. Use this to find rough patches.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_paragraph_text",
      description:
        "Retrieve the full text of a specific paragraph the reader covered. Returns {index, text, wordCount}. The reader's paragraphs are indexed 0..paragraphsRead-1.",
      parameters: {
        type: "object",
        properties: {
          index: {
            type: "number",
            description: "Zero-based paragraph index within the article.",
          },
        },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_tier_transitions",
      description:
        "Return every moment the reader's focus state changed. Array of {atSec, from, to}. Empty if they stayed in one state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "compute_reading_pace",
      description:
        "Compute words-per-minute from session data. Returns {wpm, credibleWpm, unreliable, rating}. If unreliable is true, wpm is inflated (skimming/scrolling); use credibleWpm for interpretation and do not praise raw speed.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "finalize_message",
      description:
        "Produce the final coach debrief. Call this once you understand the session. This terminates the agent loop.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "2-4 sentence personal debrief, 30-70 words, plain text, no markdown.",
          },
        },
        required: ["message"],
      },
    },
  },
];

function buildAgentUserContext(p) {
  const rp = p.readingPace;
  let paceLine = `- Words in covered paragraphs: ~${p.wordsRead ?? 0} (used for pace math)`;
  if (rp && typeof rp.rawWpm === "number") {
    paceLine += `\n- Raw WPM (naive): ${rp.rawWpm}; credible WPM (budget-capped): ${rp.credibleWpm ?? rp.rawWpm}`;
    paceLine += `\n- Typical sustained band: ~${rp.referenceWpm ?? 200}–${rp.maxPlausibleWpm ?? 250} wpm; above that is usually skimming/scrolling`;
    paceLine += `\n- Pace unreliable for praise: ${rp.unreliable ? "YES — do not compliment speed" : "no"}`;
    if (rp.wordsCapped) {
      paceLine += `\n- Word total was capped to fit session time (scrolled through more text than fits steady reading)`;
    }
    if (rp.unreliable && rp.note) paceLine += `\n- Note: ${rp.note}`;
  }
  const lines = [
    `Session stats to inform your debrief:`,
    `- Duration: ${p.durationSeconds}s`,
    `- Average stress score: ${(p.averageScore * 100).toFixed(0)}% (0=calm, 100=overloaded)`,
    `- Peak state: ${p.peakTier}`,
    `- Time in CALM / ELEVATED / OVERLOAD: ${(p.tierBreakdown?.calm ?? 0).toFixed(0)}% / ${(p.tierBreakdown?.elevated ?? 0).toFixed(0)}% / ${(p.tierBreakdown?.overload ?? 0).toFixed(0)}%`,
    `- Paragraphs read: ${p.paragraphsRead ?? 0} of ${p.paragraphsTotal ?? "?"}`,
    paceLine,
    `- Interventions (CSS auto-adjustments) triggered: ${p.interventionCount ?? 0}`,
    `- Article: "${p.pageTitle || "unknown"}"`,
    ``,
    `Investigate with tools, then call finalize_message.`,
  ];
  return lines.join("\n");
}

// Dispatcher — each tool reads from the payload that was shipped with the
// session webhook. The agent never touches live DOM; the extension already
// packed everything it needs.
function executeAgentTool(name, args, payload) {
  switch (name) {
    case "get_stress_timeline": {
      const tl = payload.stressTimeline || [];
      if (tl.length === 0) {
        return { error: "No stress timeline available for this session." };
      }
      return { bins: tl };
    }

    case "get_paragraph_text": {
      const idx = Number(args?.index);
      if (!Number.isFinite(idx)) return { error: "index must be a number" };
      const samples = payload.paragraphSamples || [];
      // Find the sampled paragraph closest to the requested index.
      let best = null;
      let bestDist = Infinity;
      for (const s of samples) {
        const d = Math.abs(s.index - idx);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      if (!best) return { error: "No paragraph samples available." };
      return {
        requestedIndex: idx,
        returnedIndex: best.index,
        text: best.text,
        wordCount: best.wordCount,
        note:
          best.index === idx
            ? undefined
            : `Exact index not sampled; returning nearest paragraph (${best.index}).`,
      };
    }

    case "get_tier_transitions": {
      const t = payload.tierTransitions || [];
      return { transitions: t, count: t.length };
    }

    case "compute_reading_pace": {
      const secs = Math.max(1, payload.durationSeconds || 0);
      const words = payload.wordsRead || 0;
      const rp = payload.readingPace;
      const ref = rp?.referenceWpm ?? 200;
      const maxPlausible = rp?.maxPlausibleWpm ?? ref + 50;
      const wpm =
        typeof rp?.rawWpm === "number"
          ? rp.rawWpm
          : Math.round(words / (secs / 60));
      const credibleWpm =
        typeof rp?.credibleWpm === "number"
          ? rp.credibleWpm
          : Math.min(wpm, maxPlausible);
      const unreliable =
        !!rp?.unreliable || wpm > maxPlausible || !!rp?.wordsCapped;
      let rating;
      if (wpm === 0 && credibleWpm === 0) rating = "no-data";
      else if (unreliable) {
        rating =
          "unreliable (skimming/scrolling — use credibleWpm only; do not praise speed)";
      } else if (credibleWpm < 120) {
        rating = "slower than typical (reflective pace)";
      } else if (credibleWpm <= maxPlausible) {
        rating = "within typical sustained reading range";
      } else {
        rating = "skimming or rushed";
      }
      return {
        wpm,
        credibleWpm,
        unreliable,
        referenceWpm: ref,
        maxPlausibleWpm: maxPlausible,
        rating,
        wordsRead: words,
        durationSeconds: secs,
        wordsCapped: !!rp?.wordsCapped,
        note: unreliable
          ? "Do not praise WPM; naive total can reflect scrolling through paragraphs."
          : undefined,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function callDedalus(body) {
  const res = await fetch(DEDALUS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEDALUS_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Dedalus ${res.status}: ${errText.slice(0, 300)}`
    );
  }
  return await res.json();
}

async function runReadingCoachAgent(payload) {
  if (!DEDALUS_API_KEY) {
    throw new Error("DEDALUS_API_KEY not configured");
  }

  const messages = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: buildAgentUserContext(payload) },
  ];

  const toolTrace = [];

  for (let step = 0; step < AGENT_MAX_STEPS; step++) {
    const res = await callDedalus({
      model: CLAUDE_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      max_tokens: 800,
      temperature: 0.4,
    });

    const msg = res?.choices?.[0]?.message;
    if (!msg) throw new Error("Dedalus returned empty response");

    // Append the assistant turn (including any tool_calls) to history.
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
    });

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      // Agent gave a plain-text reply without calling finalize_message.
      // Accept it as the final message if it looks reasonable.
      const text = (msg.content || "").trim();
      if (text && text.length > 20) {
        return { message: text, toolTrace, steps: step + 1, finalized: false };
      }
      return { message: null, toolTrace, steps: step + 1, finalized: false };
    }

    for (const tc of toolCalls) {
      let parsedArgs = {};
      try {
        parsedArgs = tc.function?.arguments
          ? JSON.parse(tc.function.arguments)
          : {};
      } catch {
        parsedArgs = {};
      }

      if (tc.function?.name === "finalize_message") {
        const finalText = String(parsedArgs.message || "").trim();
        toolTrace.push({ tool: "finalize_message", args: parsedArgs });
        return { message: finalText, toolTrace, steps: step + 1, finalized: true };
      }

      const result = executeAgentTool(tc.function?.name, parsedArgs, payload);
      toolTrace.push({ tool: tc.function?.name, args: parsedArgs, result });

      // Tool result must be a string under OpenAI-compat tool protocol.
      let serialized = JSON.stringify(result);
      if (serialized.length > 4000) serialized = serialized.slice(0, 4000) + "…";

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: serialized,
      });
    }
  }

  // Exhausted steps without finalization.
  return { message: null, toolTrace, steps: AGENT_MAX_STEPS, finalized: false };
}

// Compose the full iMessage: stats header + (agent coach blurb OR nothing).
async function composeIMessage(payload) {
  const stats = formatStatsBlock(payload);
  let coachBlurb = null;
  let agentInfo = { ok: false, error: null, steps: 0, finalized: false, toolTrace: [] };

  try {
    const agentRes = await runReadingCoachAgent(payload);
    agentInfo = { ok: true, ...agentRes };
    if (agentRes.message && agentRes.message.length >= 20) {
      coachBlurb = agentRes.message;
    }
  } catch (err) {
    agentInfo.error = err.message;
    console.error("[spectrum-server] agent failed:", err.message);
  }

  let message = stats;
  if (coachBlurb) {
    message += `\n🤖 Coach:\n${coachBlurb}\n`;
  }
  message += `\n— Sent by NeuralAdaptive`;

  return { message, agentInfo };
}

// ─── Send via Spectrum ────────────────────────────────────────────────────────
async function sendIMessage(messageText) {
  if (!RECIPIENT_PHONE) {
    throw new Error("RECIPIENT_PHONE not set. Add your phone number to .env");
  }

  const maskedPhone = `${RECIPIENT_PHONE.slice(0, 4)}****`;

  if (IMESSAGE_MODE === "cloud") {
    const app = await getSpectrumApp();
    const iMsg = imessage(app);
    const user = await iMsg.user(RECIPIENT_PHONE);
    const space = await iMsg.space(user);
    await space.send(messageText);
    console.log(`[spectrum-server] iMessage sent via Spectrum Cloud to ${maskedPhone}`);
    return;
  }

  if (IMESSAGE_MODE === "local") {
    const sdk = getLocalSdk();
    await sdk.send(RECIPIENT_PHONE, messageText);
    console.log(`[spectrum-server] iMessage sent via local Messages.app to ${maskedPhone}`);
    return;
  }

  // Default: AppleScript. No Full Disk Access required; just one Automation
  // permission prompt on first use.
  await sendViaAppleScript(RECIPIENT_PHONE, messageText);
  console.log(`[spectrum-server] iMessage sent via AppleScript to ${maskedPhone}`);
}

// ─── Express server ───────────────────────────────────────────────────────────
const expressApp = express();

expressApp.use(
  cors({
    origin: "*",
    methods: ["POST", "GET"],
  })
);
expressApp.use(express.json({ limit: "2mb" }));

expressApp.get("/health", (_req, res) => {
  const cloudReady =
    IMESSAGE_MODE !== "cloud" ||
    Boolean(PHOTON_PROJECT_ID && PHOTON_PROJECT_SECRET);
  res.json({
    ok: true,
    mode: IMESSAGE_MODE,
    configured: cloudReady && Boolean(RECIPIENT_PHONE),
    agent: Boolean(DEDALUS_API_KEY),
    model: CLAUDE_MODEL,
  });
});

expressApp.post("/session-complete", async (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ ok: false, error: "Invalid payload" });
  }

  console.log(
    `[spectrum-server] Session complete: type=${payload.sessionType} duration=${payload.durationSeconds}s paragraphs=${payload.paragraphsRead}/${payload.paragraphsTotal}`
  );

  try {
    const { message, agentInfo } = await composeIMessage(payload);

    if (agentInfo.ok) {
      console.log(
        `[spectrum-server] agent: ${agentInfo.steps} steps, finalized=${agentInfo.finalized}, tools=${agentInfo.toolTrace.map((t) => t.tool).join(",")}`
      );
    }

    await sendIMessage(message);

    res.json({ ok: true, message, agent: agentInfo });
  } catch (err) {
    console.error("[spectrum-server] Failed to send iMessage:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

expressApp.listen(PORT, () => {
  console.log(`[spectrum-server] Listening on http://localhost:${PORT}`);
  console.log(`[spectrum-server] iMessage mode: ${IMESSAGE_MODE}`);
  if (IMESSAGE_MODE === "cloud") {
    console.log(
      `[spectrum-server] Photon configured: ${Boolean(
        PHOTON_PROJECT_ID && PHOTON_PROJECT_SECRET
      )}`
    );
  }
  console.log(`[spectrum-server] Recipient set: ${Boolean(RECIPIENT_PHONE)}`);
  console.log(
    `[spectrum-server] Reading-coach agent: ${Boolean(DEDALUS_API_KEY) ? "enabled" : "disabled (no DEDALUS_API_KEY)"} (${CLAUDE_MODEL})`
  );
});
