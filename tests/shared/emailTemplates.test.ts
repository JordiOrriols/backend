// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const templates = [
  ["template", "confirmation", ["ConfirmationURL"]],
  ["template", "invite", ["ConfirmationURL"]],
  ["template", "magic_link", ["ConfirmationURL"]],
  ["template", "email_change", ["NewEmail", "ConfirmationURL"]],
  ["template", "recovery", ["ConfirmationURL"]],
  ["template", "reauthentication", ["Token"]],
  ["notification", "password_changed", []],
  ["notification", "email_changed", ["OldEmail", "Email"]],
  ["notification", "phone_changed", ["OldPhone", "Phone"]],
  ["notification", "identity_linked", ["Provider", "Email"]],
  ["notification", "identity_unlinked", ["Provider", "Email"]],
  ["notification", "mfa_factor_enrolled", ["FactorType"]],
  ["notification", "mfa_factor_unenrolled", ["FactorType"]],
] as const;

describe("shared Supabase email templates", () => {
  it("has a copy of all 13 emails and no unconfigured HTML", () => {
    expect(
      readdirSync(resolve("supabase/templates"))
        .filter((file) => file.endsWith(".html"))
        .sort()
    ).toEqual(templates.map(([, name]) => `${name}.html`).sort());
  });

  it.each(templates)("configures and renders %s.%s", (kind, name, variables) => {
    const config = read("supabase/config.toml");
    const section = config.split(`[auth.email.${kind}.${name}]`)[1]?.split(/^\[/m)[0];
    expect(section).toBeDefined();
    expect(section).toContain(`content_path = "./supabase/templates/${name}.html"`);
    expect(section).toMatch(/subject = ".+ \| JordiOrriols\.cat"/);
    if (kind === "notification") expect(section).toContain("enabled = true");

    const html = read(`supabase/templates/${name}.html`);
    const actualVariables = [...html.matchAll(/{{\s*\.(\w+)\s*}}/g)].map((match) => match[1]);
    expect([...new Set(actualVariables)].sort()).toEqual([...variables].sort());
    // Representative long values exercise wrapping; this is not a Go template renderer.
    const rendered = html.replace(/{{\s*\.(\w+)\s*}}/g, (_, variable: string) =>
      variable === "ConfirmationURL"
        ? "https://example.supabase.co/auth/v1/verify?token=example&amp;type=recovery"
        : variable === "Token"
          ? "001234"
          : `${variable}-${"long".repeat(15)}`
    );
    const document = new DOMParser().parseFromString(rendered, "text/html");
    expect(document.documentElement.lang).toBe("en");
    expect(document.querySelector('meta[name="viewport"]')).not.toBeNull();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.body.textContent).toContain("JordiOrriols.cat");
    expect(document.body.textContent).toContain("Planner, Ladders and Pulse");
    expect(document.querySelector("script, iframe, form, link, img")).toBeNull();
    for (const table of document.querySelectorAll("table"))
      expect(table.getAttribute("role")).toBe("presentation");

    const links = [...document.querySelectorAll("a")];
    if (variables.some((variable) => variable === "ConfirmationURL")) {
      expect(links).toHaveLength(2);
      for (const link of links)
        expect(link.getAttribute("href")).toBe(
          "https://example.supabase.co/auth/v1/verify?token=example&type=recovery"
        );
      expect(html.match(/href="{{ .ConfirmationURL }}"/g)).toHaveLength(2);
    } else {
      expect(links).toHaveLength(0);
    }
    if (name === "reauthentication") expect(document.body.textContent).toContain("001234");
  });
});
