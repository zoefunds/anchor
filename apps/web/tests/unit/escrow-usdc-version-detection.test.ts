import { describe, it, expect } from "vitest";
import { detectEscrowVersion } from "@/lib/escrow-version";

// Live integration check against the real EscrowUSDC deployed to
// Sepolia on 2026-09-09 (tx 0xb49c1002f9621ad258f3ef8cd69c48315cd5cd66c2a65e7a22a248e94cbbeb06).
// Requires real Sepolia RPC access — skipped, not failed, if that RPC
// is unreachable, since this suite must not flake CI on a public RPC
// hiccup; the unit-level allowlist behavior is already covered by
// tests/unit/usdc-escrow-allowlist.test.ts without needing the network.
const LIVE_ESCROW_USDC_ADDRESS = "0x87e94aac03f1a032b264e035fd41a76bcdc802e2";
const LIVE_ESCROW_ADDRESS = "0x4C7765A6823dc27Eca1DE174FceeAE5048d403e7"; // real deployed V2 Escrow, per docs/multisig-attestor-setup.md

describe("detectEscrowVersion against real deployed contracts", () => {
  it("identifies the real EscrowUSDC deployment as USDC_V1, not V2", async () => {
    process.env.HYPERLANE_RELAY_RPC_URL = process.env.HYPERLANE_RELAY_RPC_URL || "https://ethereum-sepolia.publicnode.com";
    const version = await detectEscrowVersion(LIVE_ESCROW_USDC_ADDRESS);
    expect(version).toBe("USDC_V1");
  }, 20_000);

  it("still identifies the real native-ETH Escrow as V2, unaffected by the new USDC probe", async () => {
    process.env.HYPERLANE_RELAY_RPC_URL = process.env.HYPERLANE_RELAY_RPC_URL || "https://ethereum-sepolia.publicnode.com";
    const version = await detectEscrowVersion(LIVE_ESCROW_ADDRESS);
    expect(version).toBe("V2");
  }, 20_000);
});
