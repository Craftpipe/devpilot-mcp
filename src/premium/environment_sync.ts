/**
 * environment_sync — Pro tool to compare env vars across environments.
 * Input: { provider, environments: string[] }
 * Returns: diff showing which vars differ (values MASKED).
 */

import { requirePro } from "./gate.js";
import { VercelAdapter } from "../adapters/vercel.js";
import { RailwayAdapter } from "../adapters/railway.js";
import { getAuditLog } from "../lib/audit.js";

export interface EnvironmentSyncInput {
  provider: "vercel" | "railway";
  project_id?: string;
  environments: string[];
}

export interface EnvDiffEntry {
  key: string;
  status: "only_in_first" | "only_in_second" | "present_in_all" | "missing_in_some";
  environments: Record<string, "present" | "missing">;
}

export interface EnvironmentSyncOutput {
  provider: string;
  environments: string[];
  total_keys: number;
  diff: EnvDiffEntry[];
  summary: {
    in_all: number;
    missing_in_some: number;
    only_in_one: number;
  };
}

export async function environmentSync(
  input: EnvironmentSyncInput
): Promise<{ content: [{ type: "text"; text: string }] }> {
  requirePro("environment_sync");

  if (!input.environments || input.environments.length < 2) {
    throw new Error(
      "At least two environments are required for environment_sync comparison."
    );
  }

  const audit = getAuditLog();
  const start = Date.now();

  try {
    const adapter =
      input.provider === "vercel"
        ? new VercelAdapter()
        : new RailwayAdapter();

    // Fetch env vars for each environment — values are masked, only keys matter
    const envVarsByEnvironment: Map<string, Set<string>> = new Map();

    for (const env of input.environments) {
      // When project_id is provided, fetch all vars for the project and filter by
      // target environment. When omitted, fall back to using the environment name
      // directly as the project identifier (legacy behaviour).
      const fetchId = input.project_id ?? env;
      const vars = await adapter.getEnvironmentVars(fetchId);
      const envVars = input.project_id
        ? vars.filter(
            (v) => !v.target || v.target.length === 0 || v.target.includes(env)
          )
        : vars;
      envVarsByEnvironment.set(env, new Set(envVars.map((v) => v.key)));
    }

    // Collect all unique keys across all environments
    const allKeys = new Set<string>();
    for (const keys of envVarsByEnvironment.values()) {
      for (const key of keys) {
        allKeys.add(key);
      }
    }

    // Build diff
    const diff: EnvDiffEntry[] = [];
    for (const key of Array.from(allKeys).sort()) {
      const envStatus: Record<string, "present" | "missing"> = {};
      let presentCount = 0;

      for (const env of input.environments) {
        const hasKey = envVarsByEnvironment.get(env)?.has(key) ?? false;
        envStatus[env] = hasKey ? "present" : "missing";
        if (hasKey) presentCount++;
      }

      let status: EnvDiffEntry["status"];
      if (presentCount === input.environments.length) {
        status = "present_in_all";
      } else if (presentCount === 0) {
        // Should never happen (we only track keys that exist somewhere), but be safe
        status = "missing_in_some";
      } else if (presentCount === 1) {
        // Figure out which environment it's in
        const onlyEnv = input.environments.find((e) => envStatus[e] === "present");
        if (onlyEnv === input.environments[0]) {
          status = "only_in_first";
        } else if (onlyEnv === input.environments[input.environments.length - 1]) {
          status = "only_in_second";
        } else {
          status = "missing_in_some";
        }
      } else {
        status = "missing_in_some";
      }

      diff.push({ key, status, environments: envStatus });
    }

    const inAll = diff.filter((d) => d.status === "present_in_all").length;
    const missingInSome = diff.filter((d) => d.status === "missing_in_some").length;
    const onlyInOne = diff.filter(
      (d) => d.status === "only_in_first" || d.status === "only_in_second"
    ).length;

    const result: EnvironmentSyncOutput = {
      provider: input.provider,
      environments: input.environments,
      total_keys: allKeys.size,
      diff,
      summary: {
        in_all: inAll,
        missing_in_some: missingInSome,
        only_in_one: onlyInOne,
      },
    };

    audit.log({
      tool_name: "environment_sync",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        project_id: input.project_id,
        environments: input.environments,
      }),
      result_summary: `${allKeys.size} keys across ${input.environments.length} environments — ${inAll} in all, ${missingInSome + onlyInOne} differ`,
      success: true,
      duration_ms: Date.now() - start,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    audit.log({
      tool_name: "environment_sync",
      provider: input.provider,
      input_summary: audit.sanitize({
        provider: input.provider,
        project_id: input.project_id,
        environments: input.environments,
      }),
      result_summary: `Error: ${message}`,
      success: false,
      duration_ms: Date.now() - start,
    });

    throw err;
  }
}
