// Genesis research targets: Claus and dynamic-fee Uniswap v4 pools on Ethereum mainnet. Verified 2026-10-06: each
// PoolKey read from PositionManager.poolKeys(bytes25(poolId)) (0xbD21…ee9e) has fee = 0x800000 (DYNAMIC_FEE_FLAG), and
// keccak256(abi.encode(PoolKey)) equals the pool id below. Hook names are Etherscan's verified-source contract names.
// Nothing here is indexed or replayed: the genesis job only researches and runs the analytic table.
export type GenesisPool = { name: string; poolId: `0x${string}`; hook: `0x${string}`; mechanism: string; source: string };

export const GENESIS_POOLS: GenesisPool[] = [
  {
    name: "Claus (ETH/CLAUS, Programmable launchpad)",
    poolId: "0xfaa42866f7667e3a1a10d783f3b629171febd45f056336b8df766d74afc0f0f7",
    hook: "0x37Bfb8AC7C960E558657871D41Ca70E07e7DbfFf",
    mechanism: "LP fee forced to 0; the hook takes the trading fee through return deltas and funds buybacks and auto-liquidity (tickSpacing 1)",
    source: "PositionManager.poolKeys; https://etherscan.io/address/0x37Bfb8AC7C960E558657871D41Ca70E07e7DbfFf",
  },
  {
    name: "1234 (ETH/1234, EntityHook, same deployer as Claus' agent)",
    poolId: "0x4c9d70ac7fdc3ae6ab1545cacb18c78caf0a032d8c9e36acb21bb5d27dc55300",
    hook: "0x585DD51eb8866d8b951B6a1349DC68Fc2830BFFf",
    mechanism: "EntityHook, an ERC1967 proxy hook deployed 2026-10-02 by the Claus agent EOA 0xBb145…F1C5; dynamic-fee pool, tickSpacing 1 (fee logic to be researched)",
    source: "PositionManager.poolKeys; https://etherscan.io/address/0x585DD51eb8866d8b951B6a1349DC68Fc2830BFFf",
  },
  {
    name: "Angstrom USDC/WETH (Sorella Labs)",
    poolId: "0xe500210c7ea6bfd9f69dce044b09ef384ec2b34832f132baec3b418208e3a657",
    hook: "0x0000000aa232009084Bd71A5797d089AA4Edfad4",
    mechanism: "Angstrom hook (Etherscan tag 'Sorella Labs: Angstrom Hook (v1)'): MEV-protecting app-specific sequencing on a dynamic-fee pool, tickSpacing 10",
    source: "PositionManager.poolKeys; https://etherscan.io/address/0x0000000aa232009084Bd71A5797d089AA4Edfad4",
  },
  {
    name: "Angstrom USDT/WETH (Sorella Labs)",
    poolId: "0x90078845bceb849b171873cfbc92db8540e9c803ff57d9d21b1215ec158e79b3",
    hook: "0x0000000aa232009084Bd71A5797d089AA4Edfad4",
    mechanism: "same Angstrom hook as the USDC/WETH pool, tickSpacing 10",
    source: "PositionManager.poolKeys; https://etherscan.io/address/0x0000000aa232009084Bd71A5797d089AA4Edfad4",
  },
];
