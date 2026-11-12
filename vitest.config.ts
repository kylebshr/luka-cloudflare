import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway APNs signing key, so integration tests exercise real provider-token minting.
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PUSH_NOTIFICATION_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          PUSH_NOTIFICATION_ID: "TESTKEY123",
          TEAM_IDENTIFIER: "TESTTEAM45",
        },
      },
    }),
  ],
});
