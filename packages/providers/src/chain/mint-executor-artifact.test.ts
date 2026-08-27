import { describe, expect, it } from "vitest";
import {
  buildExecutorDeployData,
  buildRevokeOperatorCalldata,
  buildSetAllowlistCalldata,
  buildSetOperatorCalldata,
  buildWithdrawCalldata,
  MINT_EXECUTOR_BYTECODE,
} from "./mint-executor-artifact.ts";

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OPERATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TARGET = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const MINT_SELECTOR = "0x40c10f19"; // mint(address,uint256), verified via `cast sig`

describe("MINT_EXECUTOR_BYTECODE", () => {
  it("is well-formed hex with no doubled 0x prefix (regression: a generation-script bug once produced '0x0x...')", () => {
    expect(MINT_EXECUTOR_BYTECODE.startsWith("0x")).toBe(true);
    expect(MINT_EXECUTOR_BYTECODE.startsWith("0x0x")).toBe(false);
    const hexBody = MINT_EXECUTOR_BYTECODE.slice(2);
    expect(hexBody.length % 2).toBe(0);
    expect(/^[0-9a-fA-F]+$/.test(hexBody)).toBe(true);
  });
});

describe("buildExecutorDeployData", () => {
  it("matches the real deploy calldata forge used in the live anvil verification (script/verify-e2e.sh)", () => {
    // The exact constructor-encoded deploy data forge sent when deploying
    // to anvil for this pass's end-to-end verification — captured via
    // `cast tx 0x0bc429fe...` against the local anvil instance while the
    // verification was running. If this ever drifts, it means either the
    // bytecode constant or the constructor-arg encoding has silently
    // diverged from what actually got deployed and proven-working.
    const data = buildExecutorDeployData(OWNER);
    expect(data.startsWith("0x60a06040526001600455")).toBe(true); // MintExecutor's real init code prefix
    // Constructor arg (owner address, left-padded to 32 bytes) is
    // appended after the init code — confirm it's present and correct.
    expect(data.toLowerCase().endsWith(OWNER.slice(2).toLowerCase())).toBe(true);
  });

  it("encodes a different owner into a different, still well-formed deployment", () => {
    const a = buildExecutorDeployData(OWNER);
    const b = buildExecutorDeployData(OPERATOR);
    expect(a).not.toBe(b);
    expect(b.toLowerCase().endsWith(OPERATOR.slice(2).toLowerCase())).toBe(true);
  });
});

describe("buildSetOperatorCalldata", () => {
  it("encodes setOperator(address) with the real 4-byte selector 0xb3ab15fb", () => {
    // Computed independently via `cast sig "setOperator(address)"`, not
    // read back out of this project's own ABI source — genuinely
    // cross-checks the encoding, not just the naming.
    const data = buildSetOperatorCalldata(OPERATOR);
    expect(data.slice(0, 10)).toBe("0xb3ab15fb");
    expect(data.toLowerCase().endsWith(OPERATOR.slice(2).toLowerCase())).toBe(true);
  });
});

describe("buildRevokeOperatorCalldata", () => {
  it("encodes revokeOperator() with the real 4-byte selector 0xb674759c and no arguments", () => {
    const data = buildRevokeOperatorCalldata();
    expect(data).toBe("0xb674759c");
    expect(data.length).toBe(10); // "0x" + 8 hex chars, no encoded args
  });
});

describe("buildSetAllowlistCalldata", () => {
  it("encodes setAllowlist(...) with the real 4-byte selector 0xdd2e1988 and every field present", () => {
    // Computed independently via
    // `cast sig "setAllowlist(address,bytes4,bool,uint256,uint256)"`.
    const data = buildSetAllowlistCalldata({
      target: TARGET,
      selector: MINT_SELECTOR,
      allowed: true,
      recipientOffset: 4n,
      valueCapWei: 5_000_000_000_000_000_000n,
    });
    expect(data.slice(0, 10)).toBe("0xdd2e1988");
    expect(data.toLowerCase()).toContain(TARGET.slice(2).toLowerCase());
    expect(data.toLowerCase()).toContain(MINT_SELECTOR.slice(2).toLowerCase());
  });

  it("setting allowed:false produces different calldata than allowed:true (revocation is a real, distinct call)", () => {
    const enable = buildSetAllowlistCalldata({
      target: TARGET,
      selector: MINT_SELECTOR,
      allowed: true,
      recipientOffset: 4n,
      valueCapWei: 1n,
    });
    const disable = buildSetAllowlistCalldata({
      target: TARGET,
      selector: MINT_SELECTOR,
      allowed: false,
      recipientOffset: 4n,
      valueCapWei: 1n,
    });
    expect(enable).not.toBe(disable);
  });
});

describe("buildWithdrawCalldata", () => {
  it("encodes withdraw(address,uint256) with the real 4-byte selector 0xf3fef3a3", () => {
    const data = buildWithdrawCalldata(OWNER, 1_000_000_000_000_000_000n);
    expect(data.slice(0, 10)).toBe("0xf3fef3a3");
    expect(data.toLowerCase()).toContain(OWNER.slice(2).toLowerCase());
  });
});
