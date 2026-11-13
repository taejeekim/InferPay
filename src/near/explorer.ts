export function txUrl(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}

export function accountUrl(accountId: string): string {
  return `https://testnet.nearblocks.io/address/${accountId}`;
}
