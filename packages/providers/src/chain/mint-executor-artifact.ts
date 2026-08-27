/**
 * MintExecutor contract artifact (ADR 0004 Phase 2, contracts/mint-executor).
 * Generated from a clean `forge build` of
 * contracts/mint-executor/src/MintExecutor.sol, solc 0.8.30, optimizer 200
 * runs (see contracts/mint-executor/foundry.toml) — 2026-08-22, after the
 * full 25/25 Foundry test suite + slither + a real end-to-end anvil
 * verification (contracts/mint-executor/script/verify-e2e.sh) all passed.
 * This is NOT hand-maintained — regenerate by re-running that build and
 * copying out/MintExecutor.sol/MintExecutor.json's bytecode.object/abi
 * here. Never edit the bytecode string directly.
 */
import { encodeDeployData, encodeFunctionData, type Hex } from "viem";

export const MINT_EXECUTOR_BYTECODE =
  "0x60a06040526001600455348015610014575f5ffd5b50604051610df4380380610df48339810160408190526100339161006b565b6001600160a01b03811661005a5760405163d92e233d60e01b815260040160405180910390fd5b6001600160a01b0316608052610098565b5f6020828403121561007b575f5ffd5b81516001600160a01b0381168114610091575f5ffd5b9392505050565b608051610d1a6100da5f395f8181610157015281816102a50152818161036e015281816103ff0152818161051e015281816107ae01526107fc0152610d1a5ff3fe608060405260043610610092575f3560e01c8063b674759c11610057578063b674759c146101c5578063dd2e1988146101d9578063ef5c491c146101f8578063f3fef3a31461025c578063f7f35c3e1461027b575f5ffd5b80633334ecc5146100d2578063570ca735146101105780638da5cb5b14610146578063a4ba3edd14610179578063b3ab15fb146101a4575f5ffd5b366100ce5760405134815233907f2da466a7b24304f47e87fa2e1e5a81b9831ce54fec19055ce277ca2f39ba42c49060200160405180910390a2005b5f5ffd5b3480156100dd575f5ffd5b506100fd6100ec366004610a86565b60026020525f908152604090205481565b6040519081526020015b60405180910390f35b34801561011b575f5ffd5b505f5461012e906001600160a01b031681565b6040516001600160a01b039091168152602001610107565b348015610151575f5ffd5b5061012e7f000000000000000000000000000000000000000000000000000000000000000081565b348015610184575f5ffd5b506100fd610193366004610a86565b60036020525f908152604090205481565b3480156101af575f5ffd5b506101c36101be366004610a86565b61029a565b005b3480156101d0575f5ffd5b506101c3610363565b3480156101e4575f5ffd5b506101c36101f3366004610ac4565b6103f4565b348015610203575f5ffd5b5061023f610212366004610b1d565b600160208181525f9384526040808520909152918352912080549181015460029091015460ff9092169183565b604080519315158452602084019290925290820152606001610107565b348015610267575f5ffd5b506101c3610276366004610b50565b610513565b348015610286575f5ffd5b506101c3610295366004610b7a565b610699565b336001600160a01b037f000000000000000000000000000000000000000000000000000000000000000016146102e3576040516330cd747160e01b815260040160405180910390fd5b6001600160a01b03811661030a5760405163d92e233d60e01b815260040160405180910390fd5b5f80546040516001600160a01b03808516939216917ffd489696792cc4c5d5b226c46f008e459c8ec9b746c49191d74bb92c19fd186791a35f80546001600160a01b0319166001600160a01b0392909216919091179055565b336001600160a01b037f000000000000000000000000000000000000000000000000000000000000000016146103ac576040516330cd747160e01b815260040160405180910390fd5b5f80546040516001600160a01b03909116907ffd489696792cc4c5d5b226c46f008e459c8ec9b746c49191d74bb92c19fd1867908390a35f80546001600160a01b0319169055565b336001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000161461043d576040516330cd747160e01b815260040160405180910390fd5b6001600160a01b0385166104645760405163d92e233d60e01b815260040160405180910390fd5b604080516060808201835285151580835260208084018781528486018781526001600160a01b038c165f81815260018086528982206001600160e01b03198f16808452908752918a90209851895460ff1916901515178955935193880193909355905160029096019590955585519283529082018790529381018590527f179489c024842b90639c599edfc3bd23b86a8efabaeca0a545ce2db50a2e8597910160405180910390a35050505050565b336001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000161461055c576040516330cd747160e01b815260040160405180910390fd5b6001600160a01b0382166105835760405163d92e233d60e01b815260040160405180910390fd5b478111156105b25760405163cf47918160e01b8152600481018290524760248201526044015b60405180910390fd5b816001600160a01b03167f7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5826040516105ed91815260200190565b60405180910390a25f826001600160a01b0316826040515f6040518083038185875af1925050503d805f811461063e576040519150601f19603f3d011682016040523d82523d5f602084013e610643565b606091505b50509050806106945760405162461bcd60e51b815260206004820152601860248201527f7769746864726177207472616e73666572206661696c6564000000000000000060448201526064016105a9565b505050565b5f546001600160a01b031633146106c357604051631f0853c160e21b815260040160405180910390fd5b6002600454036106e65760405163769dd35360e11b815260040160405180910390fd5b6002600490815582101561070d5760405163610c824560e11b815260040160405180910390fd5b5f61071b6004828587610c01565b61072491610c28565b6001600160a01b0386165f9081526001602081815260408084206001600160e01b0319861685528252928390208351606081018552815460ff161515808252938201549281019290925260020154928101929092529192509061079a5760405163610c824560e11b815260040160405180910390fd5b5f6107aa8686846020015161094d565b90507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316816001600160a01b0316146108315760405163016a849360e21b81526001600160a01b037f000000000000000000000000000000000000000000000000000000000000000081166004830152821660248201526044016105a9565b61084087836040015186610983565b4784111561086a5760405163cf47918160e01b8152600481018590524760248201526044016105a9565b604080518581526001600160a01b0383811660208301526001600160e01b0319861692908a16917f2a19d41eaabbf82e9142ca42132a6935e85b79e76cb68a07ab9ce652cbe12ed4910160405180910390a35f5f886001600160a01b03168689896040516108d9929190610c60565b5f6040518083038185875af1925050503d805f8114610913576040519150601f19603f3d011682016040523d82523d5f602084013e610918565b606091505b50915091508161093d5780604051633328256d60e21b81526004016105a99190610c6f565b5050600160045550505050505050565b5f610959826020610cb8565b831015610979576040516320c6c71560e21b815260040160405180910390fd5b5090910135919050565b6001600160a01b0383165f908152600260205260409020548015806109b457506109b08162015180610cb8565b4210155b156109e557506001600160a01b0383165f908152600260209081526040808320429081905560039092528220919091555b6001600160a01b0384165f9081526003602052604081205490818511610a0b575f610a15565b610a158286610cd1565b905080841115610a42576040516333b65efd60e01b815260048101859052602481018290526044016105a9565b610a4c8483610cb8565b6001600160a01b039096165f908152600360205260409020959095555050505050565b6001600160a01b0381168114610a83575f5ffd5b50565b5f60208284031215610a96575f5ffd5b8135610aa181610a6f565b9392505050565b80356001600160e01b031981168114610abf575f5ffd5b919050565b5f5f5f5f5f60a08688031215610ad8575f5ffd5b8535610ae381610a6f565b9450610af160208701610aa8565b935060408601358015158114610b05575f5ffd5b94979396509394606081013594506080013592915050565b5f5f60408385031215610b2e575f5ffd5b8235610b3981610a6f565b9150610b4760208401610aa8565b90509250929050565b5f5f60408385031215610b61575f5ffd5b8235610b6c81610a6f565b946020939093013593505050565b5f5f5f5f60608587031215610b8d575f5ffd5b8435610b9881610a6f565b9350602085013567ffffffffffffffff811115610bb3575f5ffd5b8501601f81018713610bc3575f5ffd5b803567ffffffffffffffff811115610bd9575f5ffd5b876020828401011115610bea575f5ffd5b949760209190910196509394604001359392505050565b5f5f85851115610c0f575f5ffd5b83861115610c1b575f5ffd5b5050820193919092039150565b80356001600160e01b03198116906004841015610c59576001600160e01b0319600485900360031b81901b82161691505b5092915050565b818382375f9101908152919050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b634e487b7160e01b5f52601160045260245ffd5b80820180821115610ccb57610ccb610ca4565b92915050565b81810381811115610ccb57610ccb610ca456fea26469706673582212203e28f863544e9763392f3b5bb362ac6cec8cd63eee9817be9a4faa700b328ab364736f6c634300081e0033" as const;

export const MINT_EXECUTOR_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "_owner",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "receive",
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "allowlist",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "bytes4",
        internalType: "bytes4",
      },
    ],
    outputs: [
      {
        name: "allowed",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "recipientOffset",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "valueCapWei",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "executeMint",
    inputs: [
      {
        name: "target",
        type: "address",
        internalType: "address",
      },
      {
        name: "data",
        type: "bytes",
        internalType: "bytes",
      },
      {
        name: "value",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "operator",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "revokeOperator",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setAllowlist",
    inputs: [
      {
        name: "target",
        type: "address",
        internalType: "address",
      },
      {
        name: "selector",
        type: "bytes4",
        internalType: "bytes4",
      },
      {
        name: "allowed",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "recipientOffset",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "valueCapWei",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setOperator",
    inputs: [
      {
        name: "newOperator",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "windowSpentWei",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "windowStart",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address payable",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "AllowlistSet",
    inputs: [
      {
        name: "target",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "selector",
        type: "bytes4",
        indexed: true,
        internalType: "bytes4",
      },
      {
        name: "allowed",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
      {
        name: "recipientOffset",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "valueCapWei",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "MintExecuted",
    inputs: [
      {
        name: "target",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "selector",
        type: "bytes4",
        indexed: true,
        internalType: "bytes4",
      },
      {
        name: "value",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "recipient",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OperatorSet",
    inputs: [
      {
        name: "previousOperator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOperator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "CalldataTooShortForRecipient",
    inputs: [],
  },
  {
    type: "error",
    name: "InsufficientBalance",
    inputs: [
      {
        name: "requested",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "available",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "MintCallFailed",
    inputs: [
      {
        name: "returnData",
        type: "bytes",
        internalType: "bytes",
      },
    ],
  },
  {
    type: "error",
    name: "NotOperator",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "RecipientMismatch",
    inputs: [
      {
        name: "expected",
        type: "address",
        internalType: "address",
      },
      {
        name: "actual",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "Reentrant",
    inputs: [],
  },
  {
    type: "error",
    name: "TargetNotAllowlisted",
    inputs: [],
  },
  {
    type: "error",
    name: "ValueCapExceeded",
    inputs: [
      {
        name: "requested",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "remaining",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: [],
  },
] as const;

/**
 * ADR 0004 Phase 2 onboarding calldata builders. Every one of these is
 * meant to be signed by the OWNER's own browser wallet (the existing
 * Phase 1 `window.ethereum` flow, generalized beyond mint-plan execution
 * attempts — see apps/web's executor-onboarding UI), never auto-signed —
 * deployment and every allowlist entry are each individually reviewed and
 * Ledger-signed, per ADR 0004's non-batched discipline. This module only
 * encodes; it never calls a wallet or the network.
 */

/** Contract-creation calldata (bytecode + encoded constructor arg) — sent
 *  with no `to` field for a real deployment transaction. */
export function buildExecutorDeployData(ownerAddress: string): Hex {
  return encodeDeployData({
    abi: MINT_EXECUTOR_ABI,
    bytecode: MINT_EXECUTOR_BYTECODE,
    args: [ownerAddress as Hex],
  });
}

export function buildSetOperatorCalldata(operatorAddress: string): Hex {
  return encodeFunctionData({
    abi: MINT_EXECUTOR_ABI,
    functionName: "setOperator",
    args: [operatorAddress as Hex],
  });
}

export function buildRevokeOperatorCalldata(): Hex {
  return encodeFunctionData({ abi: MINT_EXECUTOR_ABI, functionName: "revokeOperator", args: [] });
}

export function buildSetAllowlistCalldata(input: {
  target: string;
  selector: string;
  allowed: boolean;
  recipientOffset: bigint;
  valueCapWei: bigint;
}): Hex {
  return encodeFunctionData({
    abi: MINT_EXECUTOR_ABI,
    functionName: "setAllowlist",
    args: [
      input.target as Hex,
      input.selector as Hex,
      input.allowed,
      input.recipientOffset,
      input.valueCapWei,
    ],
  });
}

export function buildWithdrawCalldata(to: string, amountWei: bigint): Hex {
  return encodeFunctionData({
    abi: MINT_EXECUTOR_ABI,
    functionName: "withdraw",
    args: [to as Hex, amountWei],
  });
}

/**
 * The `executeMint(target, data, value)` calldata the operator session key
 * broadcasts (ADR 0004 Phase 2). Exported so the worker can simulate the
 * EXACT transaction it will broadcast — `from` = operator EOA, `to` =
 * Executor — before signing. That closes the finding-#7 gap: simulating
 * only the inner mint call (from the wallet, to the mint contract) has a
 * different `msg.sender` and gas profile than the real wrapped call, so it
 * could pass while the live tx reverts. ABI encoding is deterministic, so
 * this produces byte-identical calldata to what signExecutorTransaction
 * builds from the same args — simulate-gate and sign stay in lockstep. */
export function buildExecuteMintCalldata(target: string, data: string, valueWei: string): Hex {
  return encodeFunctionData({
    abi: MINT_EXECUTOR_ABI,
    functionName: "executeMint",
    args: [target as Hex, data as Hex, BigInt(valueWei)],
  });
}
