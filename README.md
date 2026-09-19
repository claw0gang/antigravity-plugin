# antigravity-plugin for OpenClaw

> **Independent project / upstream-service notice**
>
> This is an independent third-party OpenClaw integration. It is not affiliated with, sponsored by, endorsed by, or an official product of Google, OpenClaw/OpenClaw Foundation, Anthropic, or OpenAI.
>
> Google's published Antigravity Additional Terms and FAQ state that third-party access through software including OpenClaw using an individual Antigravity login/OAuth is prohibited and may result in suspension or termination. Do not use a personal/individual Antigravity account through this integration unless Google expressly authorizes that use. Enterprise and Google Cloud routes may be governed separately. See `NOTICE.md` and verify the terms that apply to your access route.

`antigravity-plugin` connects OpenClaw to the separately installed Google Antigravity CLI (`agy`). OpenClaw remains the orchestrator; AGY owns its native model execution, native tools, authentication, and upstream service access.

## Runtime surfaces

| Surface | Role |
| --- | --- |
| `antigravity/*` | Primary OpenClaw `AgentHarnessV2` runtime/provider |
| `antigravity-cli/*` | Generic CLI-backend compatibility path |
| Package | `@claw0gang/antigravity` |
| Plugin ID | `antigravity` |
| External executable | `agy` |

Version `0.3.0` requires OpenClaw plugin/Gateway `>=2026.9.2` and Node.js `>=22.12.0`. It is built against the OpenClaw `2026.9.4` SDK as reproducible build provenance, not as a host pin.

### OpenClaw 2026.9.5

The `0.3.0` compatibility range admits OpenClaw `2026.9.5`. A source/API review found the ANTIGRAVITY-required plugin-entry, AgentHarnessV2, session mutation, and terminal-helper contracts still present; the 2026.9.5 Gateway/node transport V2 migration does not apply to ANTIGRAVITY's current imports. Final 2026.9.5 support evidence remains the isolated package/runtime qualification performed for this release candidate.

## Installation

AGY must already be installed, authenticated through an allowed access route, and available as `agy` on `PATH` (or configured with `command`).

Before publication, install only an explicitly reviewed local package:

```bash
openclaw plugins install ./claw0gang-antigravity-0.3.0.tgz --force --accept-capabilities
```

After the release is published on ClawHub:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity
```

Then enable/configure the plugin and select an `antigravity/*` model. A safe baseline is:

```json5
{
  plugins: {
    allow: ["antigravity"],
    entries: {
      antigravity: {
        enabled: true,
        config: {
          command: "agy",
          sandbox: true,
          dangerouslySkipPermissions: false,
          printTimeout: "30m"
        }
      }
    }
  },
  agents: {
    defaults: {
      models: {
        "antigravity/*": { agentRuntime: { id: "antigravity" } }
      }
    }
  }
}
```

## What it can do

- Use an `antigravity/*` model as an ordinary main-session model/runtime.
- Run ordinary OpenClaw `sessions_spawn` children on an exact ANTIGRAVITY model and return the real child result through OpenClaw's normal completion/announcement path.
- Discover the live AGY model inventory and validate the exact requested model before execution.
- Bind an OpenClaw session to the exact AGY `conversation_id` and concrete model for safe resume.
- Execute AGY-native tools and report terminal tool evidence back through OpenClaw's harness contracts.
- Translate qualified OpenClaw child restrictions into an AGY-native policy carrier where AGY can enforce an equivalent restriction; unsupported or ambiguous policy shapes fail closed.
- Accept supported image input through private attempt-scoped files inside the selected OpenClaw workspace.

## `workspace-only` and AGY-native tools

OpenClaw filesystem policy and AGY-native filesystem authority are separate layers. `workspace-only` remains useful and is compatible with ANTIGRAVITY main and subagent use, but it is not by itself a sandbox around the external `agy` process.

For least privilege, keep OpenClaw `workspace-only`, keep `dangerouslySkipPermissions: false`, use AGY sandbox/permission controls, and review `project`, `addDirs`, `logFile`, native shell/file permissions, and credentials. ANTIGRAVITY image staging itself does not require broad home-directory or system-temp access.

## Compared with OpenClaw `claude-cli` and `codex`

| Capability | antigravity-plugin | `claude-cli` | `codex` |
| --- | --- | --- | --- |
| Primary OpenClaw runtime type | `AgentHarnessV2` | CLI backend | Native app-server harness |
| Compatibility CLI backend | Yes (`antigravity-cli`) | Native role | Legacy `codex-cli` is no longer the primary route |
| External runtime owns native loop/tools | AGY | Claude Code | Codex app-server |
| Exact native session resume | Yes | Yes | Yes |
| OpenClaw subagent execution | Yes, qualified for ordinary `sessions_spawn` | Via CLI-backend orchestration | Deep native support |
| Live provider model discovery | Yes, from AGY | Provider/backend-defined | OpenAI/Codex-owned |
| Fine-grained OpenClaw-native integrations | Partial/translated where safely representable | CLI-oriented | Deepest first-party integration |

ANTIGRAVITY's strength is a native OpenClaw harness around AGY with exact model/session identity, dynamic inventory, native-tool observation, and fail-closed policy translation. It does not claim Codex-level first-party integration for every OpenClaw control-plane feature.

## Important limitations

- ANTIGRAVITY does not provide Google credentials or bypass upstream authentication/terms.
- It does not silently fall back to another model when a selected AGY model disappears.
- A bound AGY conversation cannot silently switch to another concrete model.
- OpenClaw policies that cannot be represented safely by supported AGY controls fail closed.
- AGY-native tools may have filesystem/network authority beyond OpenClaw's own tools; configure both layers.
- `dangerouslySkipPermissions: true` explicitly requests AGY always-proceed behavior and should be treated as unrestricted execution.

## Provenance and release evidence

`src/**` in this public release preparation is exported byte-for-byte from `claw0gang/antigravity@d3cfc24a0eed0ebfd2036879002e15b3350ca467`. Public packaging/legal documentation may differ and is requalified as part of `p02t009`. See `EXPORT-MANIFEST.json`, `RELEASE-NOTES.md`, `docs/BUILD.md`, and `docs/QUALIFICATION.md`.

## License

MIT. See `LICENSE`. Third-party trademarks, upstream software, and service terms are not granted by the MIT license; see `NOTICE.md`.
