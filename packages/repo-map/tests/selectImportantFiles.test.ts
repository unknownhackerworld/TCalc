import { describe, it, expect } from "vitest";
import type { WorkspaceScanResult, WorkspaceFileInfo, FolderStats, LanguageBreakdown } from "@wma/core";
import { selectImportantFiles } from "../src/selectImportantFiles.js";

function makeFile(overrides: Partial<WorkspaceFileInfo> & { relativePath: string }): WorkspaceFileInfo {
  return {
    path: `/workspace/${overrides.relativePath}`,
    extension: overrides.extension ?? ".ts",
    language: overrides.language ?? "TypeScript",
    bytes: overrides.bytes ?? 1000,
    estimatedTokens: overrides.estimatedTokens ?? 100,
    included: overrides.included ?? true,
    riskFlags: overrides.riskFlags ?? [],
    ...overrides,
  };
}

function makeScanResult(files: WorkspaceFileInfo[]): WorkspaceScanResult {
  return {
    rootPath: "/workspace",
    scannedAt: new Date().toISOString(),
    totalFiles: files.length,
    includedFiles: files.filter((f) => f.included).length,
    excludedFiles: files.filter((f) => !f.included).length,
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
    includedBytes: files.filter((f) => f.included).reduce((s, f) => s + f.bytes, 0),
    totalEstimatedTokens: files.reduce((s, f) => s + f.estimatedTokens, 0),
    includedTokens: files.filter((f) => f.included).reduce((s, f) => s + f.estimatedTokens, 0),
    files,
    folders: [],
    languages: [],
    warnings: [],
    riskFiles: files.filter((f) => f.riskFlags.length > 0),
  };
}

describe("selectImportantFiles", () => {
  it("detects package.json", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "package.json", extension: ".json" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });
    expect(selected.configFiles).toHaveLength(1);
    expect(selected.configFiles[0].relativePath).toBe("package.json");
    expect(selected.configFiles[0].priority).toBe(90);
  });

  it("detects README.md", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "README.md", extension: ".md" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });
    expect(selected.documentationFiles).toHaveLength(1);
    expect(selected.documentationFiles[0].relativePath).toBe("README.md");
    expect(selected.documentationFiles[0].priority).toBe(80);
  });

  it("detects src/index.ts", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "src/index.ts", extension: ".ts" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });
    expect(selected.entryPoints).toHaveLength(1);
    expect(selected.entryPoints[0].relativePath).toBe("src/index.ts");
    expect(selected.entryPoints[0].priority).toBe(100);
  });

  it("detects tests", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "src/foo.test.ts", extension: ".ts" }),
      makeFile({ relativePath: "tests/bar.spec.ts", extension: ".ts" }),
      makeFile({ relativePath: "src/main.ts", extension: ".ts" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });
    expect(selected.testFiles).toHaveLength(2);
    const testPaths = selected.testFiles.map((f) => f.relativePath).sort();
    expect(testPaths).toEqual(["src/foo.test.ts", "tests/bar.spec.ts"]);
  });

  it("deprioritizes generated files", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "dist/bundle.min.js", extension: ".js", estimatedTokens: 10000 }),
      makeFile({ relativePath: "src/index.ts", extension: ".ts" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });
    const generated = selected.generatedFiles.find((f) => f.relativePath === "dist/bundle.min.js");
    expect(generated).toBeDefined();
    expect(generated!.priority).toBeLessThanOrEqual(20);
    const entry = selected.entryPoints.find((f) => f.relativePath === "src/index.ts");
    expect(entry).toBeDefined();
    expect(entry!.priority).toBeGreaterThan(generated!.priority);
  });

  it("flags large files", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "data/big-file.json", extension: ".json", estimatedTokens: 100000 }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });
    expect(selected.largeFiles).toHaveLength(1);
    expect(selected.largeFiles[0].relativePath).toBe("data/big-file.json");
  });

  it("detects AGENTS.md and CLAUDE.md", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "AGENTS.md", extension: ".md" }),
      makeFile({ relativePath: "CLAUDE.md", extension: ".md" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });
    expect(selected.documentationFiles).toHaveLength(2);
  });

  it("detects tsconfig.json as config", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "tsconfig.json", extension: ".json" }),
      makeFile({ relativePath: "tsconfig.base.json", extension: ".json" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });
    expect(selected.configFiles.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps scanner-classified generated files listed after exclusion", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "src/vendor.min.js", extension: ".js", estimatedTokens: 5000, included: false, excludedReason: "generated", riskFlags: ["generated"] }),
      makeFile({ relativePath: "src/index.ts", extension: ".ts" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });

    const generated = selected.generatedFiles.find((f) => f.relativePath === "src/vendor.min.js");
    expect(generated).toBeDefined();
    expect(selected.excludedFiles.map((f) => f.relativePath)).toContain("src/vendor.min.js");

    // Exclusion is a token-budget decision, so the file must not be recommended for inclusion.
    expect(selected.importantFiles.map((f) => f.relativePath)).not.toContain("src/vendor.min.js");
    expect(selected.recommendedInclude.map((f) => f.relativePath)).not.toContain("src/vendor.min.js");

    const excludeCount = selected.recommendedExclude.filter((f) => f.relativePath === "src/vendor.min.js").length;
    expect(excludeCount).toBe(1);
  });

  it("keeps scanner-excluded secret files in riskyFiles without token details", () => {
    const result = makeScanResult([
      makeFile({ relativePath: ".env", extension: "", estimatedTokens: 420, included: false, excludedReason: "potential secret file", riskFlags: ["secret"] }),
      makeFile({ relativePath: "backups/prod.sql", extension: ".sql", estimatedTokens: 9000, included: false, excludedReason: "database-dump", riskFlags: ["database-dump"] }),
      makeFile({ relativePath: "src/index.ts", extension: ".ts" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });

    const risky = selected.riskyFiles.map((f) => f.relativePath).sort();
    expect(risky).toEqual([".env", "backups/prod.sql"]);
    const env = selected.riskyFiles.find((f) => f.relativePath === ".env");
    expect(env?.estimatedTokens).toBe(0);
    expect(env?.reason).toBe("potential secret file");

    // Still excluded, never recommended for inclusion.
    expect(selected.excludedFiles.map((f) => f.relativePath)).toContain(".env");
    expect(selected.recommendedInclude.map((f) => f.relativePath)).not.toContain(".env");
    expect(selected.recommendedExclude.filter((f) => f.relativePath === "backups/prod.sql")).toHaveLength(1);
  });

  it("does not add ordinary excluded files to riskyFiles", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "node_modules/foo/index.js", extension: ".js", included: false, excludedReason: "In .gitignore" }),
      makeFile({ relativePath: "pnpm-lock.yaml", extension: ".yaml", estimatedTokens: 50000, included: false, excludedReason: "lockfile", riskFlags: ["lockfile"] }),
      makeFile({ relativePath: "dist/app.js", extension: ".js", included: false, excludedReason: "build-output", riskFlags: ["build-output", "large-file"] }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });

    expect(selected.riskyFiles).toHaveLength(0);
    expect(selected.excludedFiles).toHaveLength(3);
  });

  it("recommends each overlapping file for exclusion only once", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "dist/bundle.min.js", extension: ".js", estimatedTokens: 8000, riskFlags: ["generated"] }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });

    const paths = selected.recommendedExclude.map((f) => f.relativePath);
    expect(paths).toEqual([...new Set(paths)]);
  });

  it("marks excluded files", () => {
    const result = makeScanResult([
      makeFile({ relativePath: "node_modules/foo/index.js", extension: ".js", included: false, excludedReason: "In .gitignore" }),
    ]);
    const selected = selectImportantFiles(result, { tokenBudget: 8000 });
    expect(selected.excludedFiles).toHaveLength(1);
    expect(selected.excludedFiles[0].relativePath).toBe("node_modules/foo/index.js");
  });
});
