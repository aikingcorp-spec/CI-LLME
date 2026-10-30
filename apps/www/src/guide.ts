import { DOWNLOAD_URL, OPENCLAW_ALTERNATIVE_PATH, SITE_URL, SUPPORT_EMAIL } from "./site";

export const OPENCLAW_DOCS_URL = "https://docs.openclaw.ai/";
export const OPENCLAW_GETTING_STARTED_URL = "https://docs.openclaw.ai/start/getting-started";
export const OPENCLAW_FEATURES_URL = "https://docs.openclaw.ai/concepts/features";
export const OPENCLAW_SANDBOX_URL = "https://docs.openclaw.ai/gateway/sandboxing";
export const OPENCLAW_GITHUB_URL = "https://github.com/openclaw/openclaw";

export type FaqItem = {
  question: string;
  answer: string;
};

export type ComparisonRow = {
  aspect: string;
  rakazo: string;
  openclaw: string;
};

export const SELF_HOST_H1 = "Install VNBot on your computer";
export const SELF_HOST_TITLE = "Install VNBot on Your Computer – VNBot";
export const SELF_HOST_DESCRIPTION =
  "Run VNBot on your own Mac, PC, or VPS. Your chats and data stay on your machine. Download the app and follow four short steps.";

export const SELF_HOST_STEPS = [
  { title: "Download VNBot", body: "Get the app for your computer from the download page." },
  { title: "Choose This computer", body: "Open the app and pick This computer. VNBot starts on your machine." },
  { title: "Create your account", body: "The first account you create owns this install." },
  { title: "Connect a model", body: "Use your own key, or a model server running on your machine." },
] as const;

export const SELF_HOST_REQUIREMENTS =
  "VNBot runs its bot computers in Docker, so install Docker first. Leave the machine on if bots should keep running routines.";

export const SELF_HOST_SERVER =
  "For an always-on machine, such as a Mac mini or a VPS, install VNBot there the same way. From other devices, choose Existing instance in the desktop app or Use a custom server in the mobile app and enter its https address.";

export const SELF_HOST_FAQS: readonly FaqItem[] = [
  {
    question: "Where does my data live?",
    answer:
      "Chats, bot files, browser profiles, and the audit log stay on your computer. Content you send to a model provider is processed by that provider under its terms. You choose the provider and the keys.",
  },
  {
    question: "What does it cost?",
    answer:
      "There is no seat fee for running VNBot on your own computer. You pay the model provider you connect.",
  },
];

export const OPENCLAW_H1 = "OpenClaw alternative";
export const OPENCLAW_TITLE = "OpenClaw Alternative – VNBot";
export const OPENCLAW_UPDATED = "October 7, 2026";
export const OPENCLAW_DESCRIPTION =
  "VNBot and OpenClaw are both self-hosted AI agents. VNBot keeps setup and daily use in chat. OpenClaw's docs add a gateway, a config file, and a background service you can install.";

export const OPENCLAW_SETUP_PARAGRAPHS = [
  "VNBot's self-host path is the desktop app starting that stack on this computer. You create an account and connect a model. From there it is just chat, on the web, desktop, and mobile apps. A new bot interviews you about the work, and you manage the bot from that chat. Routines are readable Markdown.",
  "OpenClaw's getting-started guide installs the CLI, then runs a wizard. Quick start is the short path when a Claude Code or Codex login, or an API key, is already on the machine. Custom setup walks through the full flow, and `openclaw onboard --classic` is the step-by-step wizard. Quick start leaves the Gateway in that terminal until you stop it, so you can chat before installing a service. `openclaw gateway install` is the later step that keeps it in the background: a LaunchAgent on macOS, a systemd user unit on Linux, or a Scheduled Task on Windows. You check `openclaw gateway status` (the guide says port 18789) and open `openclaw dashboard`. Messaging from a phone, such as Telegram, is a separate Channels step.",
] as const;

export const OPENCLAW_DAY_TO_DAY_PARAGRAPHS = [
  "Day to day, you manage VNBot from the same chat. Schedules, memory, and approval boundaries stay with that bot, on the web, desktop, and mobile apps. Optional connectors can attach Slack, WhatsApp, Telegram, iMessage via Sendblue, and Feishu/Lark. They are not required to use the product.",
  "OpenClaw's docs send later changes through `openclaw configure` and a JSON config file, `~/.openclaw/openclaw.json` unless you override the path. `openclaw doctor` and `openclaw triage` diagnose the install. The Gateway is the process you keep running, in a terminal or as the installed background service, and chat apps are the main way you message the assistant, alongside the Control UI.",
] as const;

export const OPENCLAW_FAQS: readonly FaqItem[] = [
  {
    question: "Is VNBot simpler to set up than OpenClaw?",
    answer:
      "The documented paths are different. VNBot's local path is the desktop app starting the stack, then an account and a model. After that VNBot is just chat, and you manage the bot from that chat. OpenClaw's getting-started guide is an installer and a wizard (Quick start or Custom setup). You can chat while the Gateway runs in that terminal. `openclaw gateway install` keeps it running in the background, then `openclaw gateway status` and `openclaw dashboard`. Connecting a chat app is another step. OpenClaw can be short when a model login is already detected. The ongoing surface is still the Gateway and the config file.",
  },
  {
    question: "Can I chat with OpenClaw before installing a background service?",
    answer:
      "Yes. Quick start leaves the Gateway in that terminal until you stop it, so you can send a message before `openclaw gateway install`. That command is the later step that keeps the Gateway in the background: a LaunchAgent on macOS, a systemd user unit on Linux, or a Scheduled Task on Windows. VNBot does not add a gateway service. After the desktop app, the product is the chat.",
  },
  {
    question: "Do I manage OpenClaw from the chat?",
    answer:
      "You message the assistant from chat apps or the Control UI. The docs send later changes through `openclaw configure` and `~/.openclaw/openclaw.json`. `openclaw doctor` and `openclaw gateway status` are separate commands. VNBot keeps schedules, memory, and approval boundaries in the same chat, the way Grok Bot does.",
  },
  {
    question: "Is VNBot just chat, like Grok Bot?",
    answer:
      "After the install, yes. You set up the bot and manage it from that chat on the web, desktop, and mobile apps. OpenClaw is also a conversation, and its docs add a Gateway you keep running and a config file for later changes. The two are not interchangeable. VNBot does not import an OpenClaw setup.",
  },
  {
    question: "Is VNBot a drop-in replacement for OpenClaw?",
    answer:
      "No. VNBot does not import OpenClaw configuration, skills, or channel sessions. It is a separate agent you can self-host.",
  },
  {
    question: "Do both keep data on my machine?",
    answer:
      "Yes for the software you run. OpenClaw's documentation says state, memory, and credentials live on your hardware, and that there is no hosted service in the middle. A VNBot deployment stores its database and bot data on your host. In both cases, prompts go to the model provider you configure, and to any chat service you connect.",
  },
  {
    question: "Can I choose my own model with either one?",
    answer:
      "Yes. VNBot supports OpenAI, Anthropic, Google, OpenRouter, Vercel AI Gateway, an OpenAI-compatible endpoint, and a local model server, with a choice per bot. OpenClaw documents Anthropic, OpenAI, Google, and other providers, including self-hosted OpenAI-compatible and Anthropic-compatible endpoints, plus failover.",
  },
  {
    question: "Does either project charge for the software?",
    answer:
      "VNBot is free to self-host. Hosted VNBot Cloud is in beta. OpenClaw's documentation says the project has no paid tier and no hosted service. You still pay for models, machines, and any optional computer providers you use.",
  },
];

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  {
    aspect: "Setup",
    rakazo:
      "The desktop app's local stack, then an account and a model. After that VNBot is just chat: a new bot interviews you, and you manage it from the chat.",
    openclaw:
      "CLI install, then Quick start or Custom setup. The Gateway can stay in that terminal for a first chat. `openclaw gateway install` is the background service (LaunchAgent, systemd user unit, or Windows Scheduled Task). Then `openclaw gateway status` and `openclaw dashboard`. A phone channel is a separate step.",
  },
  {
    aspect: "Day-to-day management",
    rakazo:
      "You manage the bot from the same chat on the web, desktop, and mobile apps. Routines are readable Markdown and can run on a schedule. A bot can pause for approval at a boundary you set.",
    openclaw:
      "Later changes go through `openclaw configure` and `~/.openclaw/openclaw.json`. `openclaw doctor` and `openclaw triage` diagnose the install. The Gateway stays running in a terminal or as the installed background service.",
  },
  {
    aspect: "What it is",
    rakazo:
      "A platform for persistent AI teammates. Bots keep conversations, memory, routines, and history, and can use a browser, shell, and desktop.",
    openclaw:
      "A self-hosted gateway that connects chat apps to an AI assistant on your machine. The project describes one Gateway for the channels you already use.",
  },
  {
    aspect: "Where it runs",
    rakazo:
      "You run the stack on your own computer with the desktop app, or connect to a computer you operate. Web, desktop, and mobile apps are clients of that API. Hosted VNBot Cloud is in beta.",
    openclaw:
      "You run the Gateway on your own computer or a server. The docs say there is no hosted service in the middle. Interfaces include a browser Control UI, companion apps, and iOS and Android nodes.",
  },
  {
    aspect: "How you talk to it",
    rakazo:
      "The VNBot web app, Electron desktop app, and Expo mobile app. Optional connectors can attach Slack, WhatsApp, Telegram, iMessage via Sendblue, and Feishu/Lark.",
    openclaw:
      "Chat apps are the primary surface. Documented channels include Discord, Google Chat, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo, and others via plugins, plus WebChat.",
  },
  {
    aspect: "Models",
    rakazo:
      "Bring your own keys for OpenAI, Anthropic, Google, OpenRouter, or Vercel AI Gateway. OpenAI-compatible endpoints and a local model server (Ollama, LM Studio, llama.cpp, or MLX) are supported. Each bot can use a different model.",
    openclaw:
      "Many providers, including Anthropic, OpenAI, and Google, plus OAuth for some subscriptions such as OpenAI Codex. Self-hosted endpoints include vLLM, SGLang, Ollama, llama.cpp, LM Studio, and other OpenAI-compatible or Anthropic-compatible servers, with failover.",
  },
  {
    aspect: "Computers and tools",
    rakazo:
      "Browser, terminal, files, and a graphical desktop. The default computer is local Docker. Optional remote computers are E2B, Daytona, CreateOS, and Boat. An explicit desktop provider can run on the host; it is not the default.",
    openclaw:
      "Tools include browser automation and exec. Sandboxing is off by default. When enabled, documented backends include Docker, Podman, SSH, OpenShell, and Crabbox. The Gateway process stays on the host.",
  },
  {
    aspect: "Routines and memory",
    rakazo:
      "Routines are saved as readable Markdown. Memory, schedules, an audit log, and approval boundaries are part of the product.",
    openclaw:
      "Sessions, memory, skills, cron, hooks, and plugins. Direct chats can share a main session. Group chats are isolated by default.",
  },
  {
    aspect: "Integrations",
    rakazo:
      "Optional Composio or Pipedream catalogs, plus MCP servers, Treg, and OpenAPI tools you add.",
    openclaw: "Channel plugins, skills, a plugin SDK, and web search through several providers.",
  },
  {
    aspect: "More than one agent",
    rakazo: "Bots can delegate to peer bots or short-lived subagents.",
    openclaw: "Multi-agent routing with isolated sessions per agent, workspace, or sender.",
  },
  {
    aspect: "Software cost",
    rakazo: "No seat fee for self-hosting. You pay the models and infrastructure you use.",
    openclaw: "The docs say there is no paid tier. You pay the models and the machine you run.",
  },
];

export function faqPageStructuredData(items: readonly FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

function faqMarkdown(items: readonly FaqItem[]): string {
  return items.map((item) => `### ${item.question}\n\n${item.answer}`).join("\n\n");
}

function comparisonMarkdown(): string {
  const header = "| | VNBot | OpenClaw |\n| --- | --- | --- |";
  const rows = COMPARISON_ROWS.map(
    (row) => `| ${row.aspect} | ${row.rakazo} | ${row.openclaw} |`,
  );
  return [header, ...rows].join("\n");
}

export const SELF_HOST_MARKDOWN = `# ${SELF_HOST_H1}

> Run VNBot on your own Mac, PC, or VPS. Your chats and data stay on your machine.

## Steps

${SELF_HOST_STEPS.map((step, index) => `${index + 1}. **${step.title}.** ${step.body}`).join("\n")}

[Download VNBot](${DOWNLOAD_URL})

## Before you start

${SELF_HOST_REQUIREMENTS}

## Always-on machine

${SELF_HOST_SERVER} For help, email [${SUPPORT_EMAIL}](mailto:${SUPPORT_EMAIL}).

## FAQ

${faqMarkdown(SELF_HOST_FAQS)}

## Related

- [Home](${SITE_URL}/)
- [OpenClaw comparison](${SITE_URL}${OPENCLAW_ALTERNATIVE_PATH})
`;

export const OPENCLAW_RELATED = [
  { href: "/grok-bot-alternative/", label: "Grok Bot alternative" },
  { href: "/muse-alternative/", label: "Meta Muse" },
  { href: "/dots-alternative/", label: "OpenAI Dots" },
  { href: "/instinct-alternative/", label: "Instinct AI" },
  { href: "/claude-duet-alternative/", label: "Claude Duet" },
  { href: "/hark-alternative/", label: "Hark Pro" },
  { href: "/hermes-alternative/", label: "Hermes Agent" },
  { href: "/alternatives/", label: "All comparisons" },
] as const;

export const OPENCLAW_MARKDOWN = `# OpenClaw alternative

Updated ${OPENCLAW_UPDATED}.

> A fair comparison of VNBot and OpenClaw, two self-hosted ways to run an AI agent you control.

The main difference is simplicity. Like Grok Bot, VNBot is just chat: you set up the bot and manage it from that chat. OpenClaw is also self-hosted. Its [getting-started guide](${OPENCLAW_GETTING_STARTED_URL}) is a longer path: a CLI installer, an onboarding wizard, a Gateway you run in the terminal or install as a background service, and a config file.

They are not the same product, and VNBot does not import an OpenClaw setup. This comparison follows [OpenClaw's documentation](${OPENCLAW_DOCS_URL}) and this project. Details change. Those docs are the full source for OpenClaw.

## Setup

${OPENCLAW_SETUP_PARAGRAPHS.join("\n\n")}

## Day-to-day management

${OPENCLAW_DAY_TO_DAY_PARAGRAPHS.join("\n\n")}

## Comparison

${comparisonMarkdown()}

## Key differences

VNBot is a web, desktop, and mobile app for persistent teammates: a bot has a job, a computer, and routines saved as Markdown. OpenClaw is a Gateway you message from chat apps, with a browser Control UI and mobile nodes.

VNBot runs bot work on a computer. Local Docker is the default. OpenClaw can sandbox tool execution, and its docs say sandboxing is off by default. The Gateway process stays on the host.

Both let you bring a model provider, including a server you run. Neither charges a seat fee for the software. OpenClaw's docs say it has no paid tier and no hosted service. VNBot is free to self-host. Hosted VNBot Cloud is in beta.

## Which shape fits

Choose VNBot for repeated browser and shell work, scheduled operational routines, an audit log, and approval boundaries, shared across the web, desktop, and mobile clients.

Choose OpenClaw when the assistant should live in chat apps you already use, with channel plugins, skills, and a gateway on your machine.

## Sources

- [OpenClaw docs](${OPENCLAW_DOCS_URL})
- [OpenClaw getting started](${OPENCLAW_GETTING_STARTED_URL})
- [OpenClaw features](${OPENCLAW_FEATURES_URL})
- [OpenClaw sandboxing](${OPENCLAW_SANDBOX_URL})
- [OpenClaw source](${OPENCLAW_GITHUB_URL})

## FAQ

${faqMarkdown(OPENCLAW_FAQS)}

## Related

- [Home](${SITE_URL}/)
${OPENCLAW_RELATED.map((item) => `- [${item.label}](${SITE_URL}${item.href})`).join("\n")}
`;
