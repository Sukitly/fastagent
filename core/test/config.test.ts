import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, pickModelSpec, resolveModel } from "../src/index.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("config: loadConfig", () => {
  it("装载 fastagent.config.ts 的 default export(含 tools 数组透传)", async () => {
    const { config, path } = await loadConfig(join(fixtures, "configured"));
    expect(path).toMatch(/fastagent\.config\.ts$/);
    expect(config.model).toBe("openai-codex/gpt-5.5");
    expect(config.http?.port).toBe(9999);
    expect(config.tools).toHaveLength(1);
    expect(config.tools![0]!.name).toBe("ping");
  });

  it("无配置文件 → zero-config({},path undefined)", async () => {
    const { config, path } = await loadConfig("/tmp");
    expect(config).toEqual({});
    expect(path).toBeUndefined();
  });

  it("形状不对 → 抛清晰错误(fail visibly)", async () => {
    await expect(loadConfig(join(fixtures, "bad-config"))).rejects.toThrow(/must default-export/);
  });
});

describe("config: resolveModel", () => {
  it('解析 "provider/modelId"', () => {
    const m = resolveModel("openai-codex/gpt-5.5");
    expect(m.provider).toBe("openai-codex");
    expect(m.id).toBe("gpt-5.5");
  });

  it("坏格式 / 未知 model → 抛清晰错误", () => {
    expect(() => resolveModel("no-slash")).toThrow(/provider\/modelId/);
    expect(() => resolveModel("nope/nothing")).toThrow(/unknown model/);
  });
});

describe("config: pickModelSpec(优先级 flag > config > env)", () => {
  it("flag 赢 config 赢 env", () => {
    const env = { FASTAGENT_MODEL: "e/m" } as NodeJS.ProcessEnv;
    expect(pickModelSpec("f/m", { model: "c/m" }, env)).toBe("f/m");
    expect(pickModelSpec(undefined, { model: "c/m" }, env)).toBe("c/m");
    expect(pickModelSpec(undefined, {}, env)).toBe("e/m");
    expect(pickModelSpec(undefined, {}, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
