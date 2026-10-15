import { z } from "zod";

/**
 * Top-level configuration for the host_bash tool's shell environment. The
 * host shell PATH is built from the assistant process PATH plus the built-in
 * `~/.local/bin` and `~/.bun/bin` entries; `extraPath` prepends additional
 * directories for setups where the assistant runs with a minimal PATH (e.g.
 * launched from a desktop app) and host commands need binaries outside it.
 */
export const HostShellConfigSchema = z
  .object({
    extraPath: z
      .array(
        z.string({
          error: "hostShell.extraPath entries must be strings",
        }),
      )
      .default([])
      .describe(
        "Additional directories prepended to PATH for commands spawned by the host_bash tool. Entries are prepended ahead of the built-in ~/.local/bin and ~/.bun/bin entries.",
      ),
  })
  .describe("Host shell (host_bash) environment configuration.");

export type HostShellConfig = z.infer<typeof HostShellConfigSchema>;
