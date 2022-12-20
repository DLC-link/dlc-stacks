// deno-lint-ignore-file require-await no-explicit-any prefer-const
// @ts-ignore
import { Clarinet, Tx, Chain, Account, types, assertEquals, assertNotEquals , pricePackageToCV, assertStringIncludes, hex2ascii, shiftPriceValue } from "./deps.ts";
// @ts-ignore
import type { PricePackage, Block } from "./deps.ts";


// Unfortunately it is not straightforward to import "../src/stacks-redstone.ts"
// in Clarinet test files. Values are therefore generated by the helper scripts
// found in the ./scripts directory. The parameters used to generate the data
// is provided in comments.

const BTChex = "BTC";
const UUID = "fakeuuid";
const nftAssetContract = "open-dlc";
const dlcManagerContract = "dlc-manager-priced-v0-1";
const callbackContract = "callback-contract";
const eventSourceVersion = '0-1';

const contractPrincipal = (deployer: Account, contract: string) => `${deployer.address}.${contract}`;

const trustedOraclePubkey = "0x035ca791fed34bf9e9d54c0ce4b9626e1382cf13daa46aa58b657389c24a751cc6";
const untrustedOraclePubkey = "0x03cd2cfdbd2ad9332828a7a13ef62cb999e063421c708e863a7ffed71fb61c88c9";

const pricePackage: PricePackage = {
  timestamp: 1647332581,
  prices: [{ symbol: "BTC", value: 13588.669932 }]
}

const packageCV = pricePackageToCV(pricePackage);

const signature = "0x3256910f5d0788ee308baecd3787a36ab2e3a8ff3fb4d0fc4638c84ba48957b82876b71eb58751366dd7a8a6ae1f2040120706742676ddc2187170932bb344e901";

function setTrustedOracle(chain: Chain, senderAddress: string): Block {
  return chain.mineBlock([
    Tx.contractCall(dlcManagerContract, "set-trusted-oracle", [trustedOraclePubkey, types.bool(true)], senderAddress),
  ]);
}

function createNewDLC(chain: Chain, deployer: Account, creator: string, callbackContract: string) {
  const block = chain.mineBlock([
    Tx.contractCall(dlcManagerContract, "post-create-dlc", [types.buff(UUID), types.uint(10), types.principal(creator), types.principal(callbackContract), types.uint(1)], deployer.address)
  ]);

  block.receipts[0].result.expectOk().expectBool(true);
  const postCreateDLCEvent = block.receipts[0].events[0];
  const callbackPrintEvent = block.receipts[0].events[1];
  const mintEvent = block.receipts[0].events[2];
  return { postCreateDLCEvent, callbackPrintEvent, mintEvent };
}

Clarinet.test({
  name: "Contract owner can set trusted oracle",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get("deployer")!;
    const block = setTrustedOracle(chain, deployer.address);
    const [receipt] = block.receipts;
    receipt.result.expectOk().expectBool(true);
    const trusted = chain.callReadOnlyFn(dlcManagerContract, "is-trusted-oracle", [trustedOraclePubkey], deployer.address);
    const untrusted = chain.callReadOnlyFn(dlcManagerContract, "is-trusted-oracle", [untrustedOraclePubkey], deployer.address);
    trusted.result.expectBool(true);
    untrusted.result.expectBool(false);
  },
});

////////////////// DLC Creation

Clarinet.test({
  name: "create-dlc called from a protocol-contract emits a dlclink event",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer_2 = accounts.get('deployer_2')!;
    const creator = accounts.get('wallet_1')

    let block = chain.mineBlock([
      Tx.contractCall(contractPrincipal(deployer_2, callbackContract), "create-dlc-request", [types.uint(1000000), types.uint(shiftPriceValue(1)), types.uint(14000), types.uint(1000), types.uint(10)], creator.address)
    ]);

    block.receipts[0].result.expectOk().expectBool(true);
    const event = block.receipts[0].events[0];

    assertEquals(typeof event, 'object');
    assertEquals(event.type, 'contract_event');
    assertEquals(event.contract_event.topic, "print");
    assertStringIncludes(event.contract_event.value, "creator: " + 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5');
    assertStringIncludes(event.contract_event.value, `event-source: "dlclink:create-dlc:v${eventSourceVersion}"`);
  },
});

Clarinet.test({
  name: "create-dlc called multiple times in the same block generates different UUIDs",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer_2 = accounts.get('deployer_2')!;

    const localNonces = [0, 1, 2, 3, 4];
    const uuids: string[] = [];

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "create-dlc", [types.uint(10), types.principal(contractPrincipal(deployer_2, callbackContract)), types.uint(localNonces[0])], deployer_2.address),
      Tx.contractCall(dlcManagerContract, "create-dlc", [types.uint(10), types.principal(contractPrincipal(deployer_2, callbackContract)), types.uint(localNonces[1])], deployer_2.address),
      Tx.contractCall(dlcManagerContract, "create-dlc", [types.uint(10), types.principal(contractPrincipal(deployer_2, callbackContract)), types.uint(localNonces[2])], deployer_2.address),
      Tx.contractCall(dlcManagerContract, "create-dlc", [types.uint(10), types.principal(contractPrincipal(deployer_2, callbackContract)), types.uint(localNonces[3])], deployer_2.address),
      Tx.contractCall(dlcManagerContract, "create-dlc", [types.uint(10), types.principal(contractPrincipal(deployer_2, callbackContract)), types.uint(localNonces[4])], deployer_2.address)
    ]);

    block.receipts[0].result.expectOk().expectBool(true);

    block.receipts.forEach(receipt => {
      receipt.events.forEach(event => {
        const printContents: string = event.contract_event.value;
        const uuidIndex = printContents.search('0x');
        const uuid = printContents.substring(uuidIndex, uuidIndex + 66);

        uuids.forEach(uuid => assertNotEquals(uuid));
        uuids.push(uuid);

        assertEquals(typeof event, 'object');
        assertEquals(event.type, 'contract_event');
        assertEquals(event.contract_event.topic, "print");
        assertStringIncludes(event.contract_event.value, `event-source: "dlclink:create-dlc:v${eventSourceVersion}"`)
      })
    })

  },
});

Clarinet.test({
  name: "only contract owner can add DLC",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer_2 = accounts.get('deployer_2')!;
    const wallet_1 = accounts.get('wallet_1')!;

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "post-create-dlc", [types.buff(UUID), types.uint(10), types.principal(wallet_1.address), types.principal(contractPrincipal(deployer_2, callbackContract)), types.uint(1)], wallet_1.address),
    ]);

    const err = block.receipts[0].result.expectErr();
    assertEquals(err, "u101"); // err-unauthorised
  },
});

Clarinet.test({
  name: "post-create-dlc creates a new dlc, prints an event, calls the callback-function and mints an open-dlc nft",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;
    const user = accounts.get('wallet_1')!;

    const { postCreateDLCEvent, callbackPrintEvent, mintEvent } = createNewDLC(chain, deployer, user.address, contractPrincipal(deployer_2, callbackContract));

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "get-dlc", [types.buff(UUID)], deployer.address)
    ]);

    assertEquals(typeof postCreateDLCEvent, 'object');
    assertEquals(postCreateDLCEvent.type, 'contract_event');
    assertEquals(postCreateDLCEvent.contract_event.topic, "print");
    assertStringIncludes(postCreateDLCEvent.contract_event.value, 'creator: ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5, emergency-refund-time: u10, event-source: "dlclink:post-create-dlc:v0-1", uuid: 0x66616b6575756964')

    assertEquals(typeof callbackPrintEvent, 'object');
    assertEquals(callbackPrintEvent.type, 'contract_event');
    assertEquals(callbackPrintEvent.contract_event.topic, "print");
    assertStringIncludes(callbackPrintEvent.contract_event.value, 'event-source: "callback-mock-post-create", nonce: u1, uuid: 0x66616b6575756964')

    assertEquals(typeof mintEvent, 'object');
    assertEquals(mintEvent.type, 'nft_mint_event');
    assertEquals(mintEvent.nft_mint_event.asset_identifier.split("::")[1], nftAssetContract);
    assertEquals(mintEvent.nft_mint_event.recipient.split(".")[1], dlcManagerContract);

    const dlc: any = block.receipts[0].result.expectSome().expectTuple();

    assertEquals(hex2ascii(dlc.uuid), "fakeuuid");
    assertEquals(dlc.creator, "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5");
  },
});

////////////////// DLC Closing

Clarinet.test({
  name: "close-dlc emits an event",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;
    const user = accounts.get('wallet_1')!;

    createNewDLC(chain, deployer, user.address, contractPrincipal(deployer_2, callbackContract));

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "close-dlc", [types.buff(UUID), types.uint(0)], deployer.address),
    ]);

    block.receipts[0].result.expectOk().expectBool(true);
    const event = block.receipts[0].events[0];

    assertEquals(typeof event, 'object');
    assertEquals(event.type, 'contract_event');
    assertEquals(event.contract_event.topic, "print");
    assertStringIncludes(event.contract_event.value, "uuid: 0x66616b6575756964");
    assertStringIncludes(event.contract_event.value, 'event-source: "dlclink:close-dlc:v0-1"');
  },
});

Clarinet.test({
  name: "user can't call close-dlc",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;
    const user = accounts.get('wallet_1')!;

    createNewDLC(chain, deployer, user.address, contractPrincipal(deployer_2, callbackContract));

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "close-dlc", [types.buff(UUID), types.uint(0)], user.address),
    ]);

    const err = block.receipts[0].result.expectErr();
    assertEquals(err, "u101"); // err-unauthorised
  },
});

Clarinet.test({
  name: "out-of-bounds outcome throws error in close-dlc",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;
    const user = accounts.get('wallet_1')!;

    createNewDLC(chain, deployer, user.address, contractPrincipal(deployer_2, callbackContract));

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "close-dlc", [types.buff(UUID), types.uint(100000001)], deployer.address),
    ]);

    const err = block.receipts[0].result.expectErr();
    assertEquals(err, "u110"); // err-out-of-bounds-outcome
  },
});

Clarinet.test({
  name: "post-close-dlc updates status and actual-closing-time, calls the callback-contract and burns the corresponding nft",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;
    const user = accounts.get('wallet_1')!;

    const outcome = 90000000;

    createNewDLC(chain, deployer, user.address, contractPrincipal(deployer_2, callbackContract));

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "close-dlc", [types.buff(UUID), types.uint(outcome)], deployer.address),
      Tx.contractCall(dlcManagerContract, "post-close-dlc", [types.buff(UUID), types.principal(contractPrincipal(deployer_2, callbackContract)), types.uint(outcome)], deployer.address),
      Tx.contractCall(dlcManagerContract, "get-dlc", [types.buff(UUID)], deployer.address)
    ]);

    block.receipts[1].result.expectOk().expectBool(true);
    const printEvent2 = block.receipts[1].events[0];

    assertEquals(typeof printEvent2, 'object');
    assertEquals(printEvent2.type, 'contract_event');
    assertEquals(printEvent2.contract_event.topic, "print");
    assertStringIncludes(printEvent2.contract_event.value, 'actual-closing-time: u1, event-source: "dlclink:post-close-dlc:v0-1", outcome: u90000000, uuid: 0x66616b6575756964')

    const contractEvent = block.receipts[1].events[1];

    assertEquals(typeof contractEvent, 'object');
    assertEquals(contractEvent.type, 'contract_event');
    assertEquals(contractEvent.contract_event.topic, "print");
    assertStringIncludes(contractEvent.contract_event.value, 'event-source: "callback-mock-post-close", uuid: 0x66616b6575756964')

    const burnEvent = block.receipts[1].events[2];

    assertEquals(typeof burnEvent, 'object');
    assertEquals(burnEvent.type, 'nft_burn_event');
    assertEquals(burnEvent.nft_burn_event.asset_identifier.split("::")[1], nftAssetContract);
    assertEquals(burnEvent.nft_burn_event.sender.split(".")[1], dlcManagerContract);

    const dlc: any = block.receipts[2].result.expectSome().expectTuple();
    assertEquals(dlc['status'], "u1") // status-closed
  },
});

Clarinet.test({
  name: "post-close-dlc fails if oracle-outcome is different from on-chain outcome",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;
    const user = accounts.get('wallet_1')!;

    const outcome = 90000000;
    const oracleOutcome = 97000000;

    createNewDLC(chain, deployer, user.address, contractPrincipal(deployer_2, callbackContract));

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "close-dlc", [types.buff(UUID), types.uint(outcome)], deployer.address),
      Tx.contractCall(dlcManagerContract, "post-close-dlc", [types.buff(UUID), types.principal(contractPrincipal(deployer_2, callbackContract)), types.uint(oracleOutcome)], deployer.address),
    ]);

    const err = block.receipts[1].result.expectErr();
    assertEquals(err, "u111"); // err-different-outcomes
  },
});

Clarinet.test({
  name: "can't request close on a closed dlc",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;
    const user = accounts.get('wallet_1')!;

    createNewDLC(chain, deployer, user.address, contractPrincipal(deployer_2, callbackContract));

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "close-dlc", [types.buff(UUID), types.uint(0)], deployer.address),
      Tx.contractCall(dlcManagerContract, "post-close-dlc", [types.buff(UUID), types.principal(contractPrincipal(deployer_2, callbackContract)), types.uint(0)], deployer.address),
      Tx.contractCall(dlcManagerContract, "close-dlc", [types.buff(UUID), types.uint(0)], deployer.address),
    ]);

    const err = block.receipts[2].result.expectErr();
    assertEquals(err, "u105"); // err-already-closed
  },
});

Clarinet.test({
  name: "get-btc-price emits an event",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;
    const user = accounts.get('wallet_1')!;

    createNewDLC(chain, deployer, user.address, contractPrincipal(deployer_2, callbackContract));

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "get-btc-price", [types.buff(UUID)], deployer.address),
    ]);

    block.receipts[0].result.expectOk().expectBool(true);
    const event = block.receipts[0].events[0];

    assertEquals(typeof event, 'object');
    assertEquals(event.type, 'contract_event');
    assertEquals(event.contract_event.topic, "print");
    assertStringIncludes(event.contract_event.value, 'callback-contract: STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6.callback-contract, caller: ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM, creator: ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5, event-source: "dlclink:get-btc-price:v0-1", uuid: 0x66616b6575756964');
  },
});

Clarinet.test({
  name: "validate-price-data fails on untrusted oracle",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "validate-price-data", [types.buff(UUID), packageCV.timestamp, packageCV.prices, signature, types.principal(contractPrincipal(deployer_2, callbackContract))], deployer.address),
    ]);

    const err = block.receipts[0].result.expectErr();
    assertEquals(err, "u113"); // err-untrusted-oracle
  },
});

Clarinet.test({
  name: "validate-price-data calls get-btc-price-callback",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;

    let block0 = setTrustedOracle(chain, deployer.address);
    block0.receipts[0].result.expectOk().expectBool(true);

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "validate-price-data", [types.buff(UUID), packageCV.timestamp, packageCV.prices, signature, types.principal(contractPrincipal(deployer_2, callbackContract))], deployer.address),
    ]);

    block.receipts[0].result.expectOk().expectBool(true);
    const event = block.receipts[0].events[0];
  },
});

////////////////// Contract Registration

Clarinet.test({
  name: "only contract-owner can register contracts",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "register-contract", [types.principal(contractPrincipal(deployer_2, callbackContract))], deployer_2.address),
    ]);

    const err = block.receipts[0].result.expectErr();
    assertEquals(err, "u101"); // err-unauthorised
  },
});

Clarinet.test({
  name: "is-contract-registered returns true for registered contract",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "register-contract", [types.principal(contractPrincipal(deployer_2, callbackContract))], deployer.address),
      Tx.contractCall(dlcManagerContract, "is-contract-registered", [types.principal(contractPrincipal(deployer_2, callbackContract))], deployer_2.address)
    ]);

    block.receipts[0].result.expectOk().expectBool(true);
    block.receipts[1].result.expectBool(true);
  },
});

Clarinet.test({
  name: "is-contract-registered returns false for unregistered contract",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get('deployer')!;
    const deployer_2 = accounts.get('deployer_2')!;

    let block = chain.mineBlock([
      Tx.contractCall(dlcManagerContract, "register-contract", [types.principal(contractPrincipal(deployer_2, callbackContract))], deployer.address),
      Tx.contractCall(dlcManagerContract, "unregister-contract", [types.principal(contractPrincipal(deployer_2, callbackContract))], deployer.address),
      Tx.contractCall(dlcManagerContract, "is-contract-registered", [types.principal(contractPrincipal(deployer_2, callbackContract))], deployer_2.address)
    ]);

    block.receipts[0].result.expectOk().expectBool(true);
    block.receipts[1].result.expectOk().expectBool(true);
    block.receipts[2].result.expectBool(false);
  },
});
