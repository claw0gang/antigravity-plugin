# Third-Party Notices and Service Disclaimer

This project is an independent open-source integration developed and published by `claw0gang`. It is not affiliated with, sponsored by, endorsed by, or an official product of Google, OpenClaw/OpenClaw Foundation, Anthropic, or OpenAI.

References to Google Antigravity, OpenClaw, Claude, Codex, Anthropic, OpenAI, and other third-party products, providers, models, and services are used only to identify compatible, compared, or upstream software and services. All third-party trademarks, service marks, product names, logos, and brand features remain the property of their respective owners.

## Upstream service terms

As of 2026-09-23, Google's published Antigravity Additional Terms and FAQ state that using third-party software, tools, or services, including OpenClaw, to access Antigravity with an individual Antigravity login/OAuth is prohibited and may result in suspension or termination.

Do not use an individual or personal Antigravity account through this integration unless Google expressly authorizes that use.

Certain Gemini Enterprise and Google Cloud access routes are governed by separate administrator or Google Cloud terms rather than the individual Antigravity Additional Terms. Users and administrators are responsible for confirming that their applicable agreement permits the intended integration. Use of third-party models may also be subject to the applicable model provider's terms.

Current upstream references:

- Google Antigravity Additional Terms: https://antigravity.google/terms
- Google Antigravity FAQ: https://antigravity.google/docs/faq/

## Data and privacy

This plugin does not operate a `claw0gang`-hosted model inference service. It launches the locally installed Google Antigravity CLI (`agy`).

Content supplied to AGY may include prompts, images, file contents, paths, tool inputs or results, and related metadata depending on the task and configuration. That content may be processed by Google and/or selected upstream model providers under the terms and data controls applicable to the user's authentication route.

Google's individual Antigravity Terms describe recording and storage of interactions and possible use of interactions for service, research, and machine-learning improvement, including human review subject to applicable settings and controls. Enterprise and Google Cloud data handling may differ.

Review the applicable upstream terms, privacy notices, administrator policies, and data controls before processing confidential, personal, regulated, or otherwise sensitive information.

## Agent and tool execution

AGY can execute native tools and access resources permitted by the user's environment and configuration.

Setting `dangerouslySkipPermissions: true` causes this plugin to pass AGY's `--dangerously-skip-permissions` option. Google documents that this option approves all tool calls, including file writes and command execution.

Prefer sandboxing, scoped AGY permission rules, and least-privilege credentials. Enable unrestricted execution only when that risk is deliberately accepted. Review workspace/project selection, `addDirs`, log-file configuration, credentials, and network-accessible resources before use.

Upstream CLIs, services, model availability, quotas, behavior, and terms may change independently of this project.

Google's headless/permission documentation is available at:
https://antigravity.google/docs/cli/headless/

## License and trademarks

The MIT License in `LICENSE` applies to the copyrightable software and documentation distributed by this project. It does not grant rights to third-party trademarks, service marks, product names, logos, brand features, upstream software or services, or model/provider materials.

Google Antigravity CLI is separate software supplied by Google and remains subject to Google's applicable terms.
