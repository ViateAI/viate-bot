import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyConfigDraftPatch, buildConfigInput, ConfigEditor, draftsFromConfig, type ConfigDraft, type RedactedConfig } from "./apps-page.js";

describe("shared config drafts", () => {
  it("keeps a secret reference and its prefix instead of treating it as a private secret", () => {
    const drafts = draftsFromConfig({
      MCP_TOKEN: { secret: true, secretRef: "corp", prefix: "Bearer " },
      REGION: "eu",
      API_TOKEN: { secret: true },
    } as RedactedConfig);
    const shared = drafts.find((row) => row.key === "MCP_TOKEN");
    const plain = drafts.find((row) => row.key === "REGION");
    const privateSecret = drafts.find((row) => row.key === "API_TOKEN");
    expect(shared).toMatchObject({ secretRef: "corp", prefix: "Bearer ", value: "" });
    expect(plain).toMatchObject({ value: "eu", secretRef: "" });
    expect(privateSecret).toMatchObject({ existingSecret: true, secretRef: "", value: "" });
    expect(JSON.stringify(shared)).not.toContain("plaintext");
    const html = renderToStaticMarkup(
      <ConfigEditor drafts={drafts} disabled={false} onChange={() => {}} onAdd={() => {}} onRemove={() => {}} />,
    );
    expect(html).toContain("引用共享密钥");
    expect(html).toContain("已单独设置（不回显）");
    expect(html).toContain("corp");
    expect(html).toContain("Bearer ");
    expect(html).not.toContain("secret-value");
  });

  it("rejects a shared reference with a bad name or prefix", () => {
    const drafts = draftsFromConfig({ MCP_TOKEN: { secret: true, secretRef: "corp" } } as RedactedConfig);
    const renamed = drafts.map((row): ConfigDraft => ({ ...row, secretRef: "Not Valid" }));
    const built = buildConfigInput(renamed);
    expect(built.ok).toBe(false);
    const prefixed = drafts.map((row): ConfigDraft => ({ ...row, prefix: "Bearer\n" }));
    expect(buildConfigInput(prefixed).ok).toBe(false);
  });

  it("writes a reference without copying a secret value", () => {
    const drafts = draftsFromConfig({ MCP_TOKEN: { secret: true, secretRef: "corp", prefix: "Bearer " } } as RedactedConfig);
    const built = buildConfigInput(drafts);
    expect(built).toEqual({
      ok: true,
      config: { MCP_TOKEN: { secret: true, secretRef: "corp", prefix: "Bearer " } },
    });
  });

  it("keeps an existing private secret when switching to a shared reference and back", () => {
    const [draft] = draftsFromConfig({ API_TOKEN: { secret: true } } as RedactedConfig);
    if (!draft) throw new Error("missing draft");
    const shared = applyConfigDraftPatch(draft, { mode: "shared", secretRef: "corp", prefix: "Bearer " });
    const back = applyConfigDraftPatch(shared, { mode: "secret" });
    expect(back.existingSecret).toBe(true);
    expect(back.secretRef).toBe("");
    expect(buildConfigInput([back])).toEqual({ ok: true, config: { API_TOKEN: { secret: true } } });
  });

  it("offers known secret names without requiring one", () => {
    const drafts = draftsFromConfig({ MCP_TOKEN: { secret: true, secretRef: "corp" } } as RedactedConfig);
    const props = { drafts, disabled: false, onChange: () => {}, onAdd: () => {}, onRemove: () => {} };
    const plain = renderToStaticMarkup(<ConfigEditor {...props} />);
    expect(plain).toContain("引用共享密钥");
    expect(plain).toContain("corp");
    expect(plain).not.toContain("<datalist");
    const hinted = renderToStaticMarkup(<ConfigEditor {...props} secretNames={["corp_token", "other_key"]} />);
    expect(hinted).toContain("<datalist");
    expect(hinted).toContain("corp_token");
    expect(hinted).toContain("other_key");
    expect(hinted).toContain("corp");
    expect(hinted).not.toContain("secret-value");
  });
});
